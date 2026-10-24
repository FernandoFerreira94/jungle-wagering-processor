import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WagerConsumer } from '../../src/messaging/wager-consumer';
import type { SqsGateway } from '../../src/messaging/sqs';
import { api, createTestApp, createWallet, submitWager, wagerBody, type TestApp } from '../support/app';
import { resetDatabase, sql, testOrm } from '../support/db';
import { drainAll, drainQueue, queues, sendWager, testSqs, wagerMessage } from '../support/sqs';

let t: TestApp;
let orm: MikroORM;
let sqs: SqsGateway;
let consumer: WagerConsumer;

beforeAll(async () => {
  await resetDatabase();
  t = await createTestApp({ sqsRetryBaseSeconds: 0, lockTimeoutMs: 300 });
  consumer = t.app.get(WagerConsumer);
  orm = await testOrm();
  sqs = testSqs();
});
afterAll(async () => {
  await consumer?.stop();
  await t?.close();
  await orm?.close();
  sqs?.destroy();
});
beforeEach(() => drainAll(sqs));

/** Consome até a fila esvaziar. */
async function consumeAll(rounds = 20): Promise<void> {
  let idle = 0;
  for (let i = 0; i < rounds && idle < 3; i++) idle = (await consumer.pollOnce(0)) === 0 ? idle + 1 : 0;
}

const balanceOf = async (walletId: string) => (await api(t.url, 'GET', `/wallets/${walletId}`)).body.balance.amount;
const debits = async (walletId: string) =>
  Number(
    (await sql<{ c: string }>(orm, `SELECT count(*) c FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]))[0]?.c,
  );

function betData(walletId: string, playerId: string, amount = '10.00', externalTransactionId = `tx-${crypto.randomUUID()}`) {
  const body = wagerBody({ walletId, playerId, kind: 'BET', amount, externalTransactionId });
  return { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` };
}

describe('SQS consumer', () => {
  test('processes a message, records the inbox and acks after commit', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const message = wagerMessage(betData(walletId, playerId, '25.00'));
    await sendWager(sqs, message);
    await consumeAll();
    expect(await balanceOf(walletId)).toBe('75.00');
    const [inbox] = await sql<{ processed_at: Date | null }>(orm, `SELECT processed_at FROM inbox_messages WHERE message_id = ?`, [
      message.messageId,
    ]);
    expect(inbox?.processed_at).not.toBeNull();
    expect(await drainQueue(sqs, queues.transactions, { quietMs: 200 })).toHaveLength(0);
  });

  test('the same message delivered twice debits once', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const message = wagerMessage(betData(walletId, playerId));
    await sendWager(sqs, message);
    await sendWager(sqs, message);
    await consumeAll();
    expect(await debits(walletId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('90.00');
    const metrics = await fetch(`${t.url}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/inbox_duplicates_total [1-9]/);
  });

  test('a reused messageId with a different payload goes to the DLQ', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const first = wagerMessage(betData(walletId, playerId, '10.00'));
    const forged = { ...first, data: betData(walletId, playerId, '99.00') };
    await sendWager(sqs, first);
    await consumeAll();
    await sendWager(sqs, forged);
    await consumeAll();
    expect(await balanceOf(walletId)).toBe('90.00');
    const dlq = await drainQueue(sqs, queues.dlq);
    expect(dlq.map((m) => m.messageId)).toEqual([first.messageId]);
  });

  test('a message for a wallet that does not exist goes to the DLQ', async () => {
    const message = wagerMessage(betData(crypto.randomUUID(), crypto.randomUUID()));
    await sendWager(sqs, message);
    await consumeAll();
    const dlq = await drainQueue(sqs, queues.dlq);
    expect(dlq.map((m) => m.messageId)).toEqual([message.messageId]);
  });

  test('malformed messages go straight to the DLQ', async () => {
    await sendWager(sqs, '{not json');
    await sendWager(sqs, JSON.stringify({ messageId: 'm1', type: 'Unknown', data: {} }));
    await consumeAll();
    const dlq = await drainQueue(sqs, queues.dlq);
    expect(dlq).toHaveLength(2);
    expect(dlq).toContain('{not json');
  });

  test('a transient failure returns the message; after maxReceiveCount it lands in the DLQ', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locker = orm.em.fork().transactional(async (em) => {
      await em.execute(`SELECT 1 FROM wallets WHERE id = ? FOR UPDATE`, [walletId]);
      await held;
    });
    await Bun.sleep(50);
    const message = wagerMessage(betData(walletId, playerId));
    await sendWager(sqs, message);
    try {
      for (let i = 0; i < 8; i++) {
        await consumer.pollOnce(0);
        await Bun.sleep(100);
      }
    } finally {
      release();
      await locker;
    }
    expect(await balanceOf(walletId)).toBe('100.00');
    const dlq = await drainQueue(sqs, queues.dlq);
    expect(dlq.map((m) => m.messageId)).toEqual([message.messageId]);
    const metrics = await fetch(`${t.url}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/sqs_retries_total [1-9]/);
  });

  test('a business rejection is acknowledged (not retried, not in the DLQ)', async () => {
    const { walletId, playerId } = await createWallet(t.url, '5.00');
    await sendWager(sqs, wagerMessage(betData(walletId, playerId, '10.00')));
    await consumeAll();
    const [row] = await sql<{ status: string; failure_code: string }>(
      orm,
      `SELECT status, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
      [walletId],
    );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await drainQueue(sqs, queues.dlq, { quietMs: 200 })).toHaveLength(0);
    expect(await drainQueue(sqs, queues.transactions, { quietMs: 200 })).toHaveLength(0);
  });

  test('HTTP and SQS with the same idempotency key have a single effect', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const data = betData(walletId, playerId, '10.00', 'both-channels');
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'both-channels' });
    await sendWager(sqs, wagerMessage(data));
    await consumeAll();
    expect(await debits(walletId)).toBe(1);
  });

  test('stop() lets the message in progress finish before returning', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const slow = await createTestApp({ sqsRetryBaseSeconds: 0, lockTimeoutMs: 5000 });
    const slowConsumer = slow.app.get(WagerConsumer);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locker = orm.em.fork().transactional(async (em) => {
      await em.execute(`SELECT 1 FROM wallets WHERE id = ? FOR UPDATE`, [walletId]);
      await held;
    });
    try {
      await Bun.sleep(50);
      await sendWager(sqs, wagerMessage(betData(walletId, playerId)));
      slowConsumer.start();
      await Bun.sleep(1500); // a mensagem está em andamento, esperando o lock
      const stopped = slowConsumer.stop();
      setTimeout(release, 300);
      await stopped;
      await locker;
      expect(await balanceOf(walletId)).toBe('90.00');
    } finally {
      release();
      await slow.close();
    }
    expect(await drainQueue(sqs, queues.transactions, { quietMs: 300 })).toHaveLength(0);
  });
});
