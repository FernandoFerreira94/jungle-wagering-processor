import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SqsGateway } from '../../src/messaging/sqs';
import { newId } from '../../src/shared/ids';
import { api, createWallet, submitWager, wagerBody } from '../support/app';
import { resetDatabase, sql, testOrm } from '../support/db';
import { eventually, startInstances, stopAll, type Instance } from '../support/instances';
import { assertLedgerInvariant } from '../support/invariant';
import { drainAll, drainQueue, queues, sendWager, testSqs, wagerMessage } from '../support/sqs';

/*
 * Paralelismo real: 3 processos do serviço, o mesmo Postgres e as mesmas filas.
 * Nenhum mock. Cada teste termina conferindo o invariante saldo == ledger.
 */

let instances: Instance[];
let orm: MikroORM;
let sqs: SqsGateway;
const touched: string[] = [];

const pick = (i: number) => (instances[i % instances.length] as Instance).url;

beforeAll(async () => {
  await resetDatabase();
  sqs = testSqs();
  await drainAll(sqs);
  orm = await testOrm();
  instances = await startInstances(3, { SQS_RETRY_BASE_SECONDS: '1', PENDING_REFERENCE_BASE_DELAY_MS: '200' });
});

afterAll(async () => {
  await stopAll(instances ?? []);
  await assertLedgerInvariant(orm, touched);
  await orm.close();
  sqs.destroy();
});

async function wallet(amount: string) {
  const created = await createWallet(pick(touched.length), amount);
  touched.push(created.walletId);
  return created;
}

const count = async (query: string, params: unknown[]) => Number((await sql<{ c: string }>(orm, query, params))[0]?.c);
const debitsOf = (walletId: string) =>
  count(`SELECT count(*) c FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]);
const balanceOf = async (walletId: string) => (await api(pick(0), 'GET', `/wallets/${walletId}`)).body.balance.amount as string;

describe('concurrency (3 instances)', () => {
  test('1. the same BET sent 50 times in parallel produces a single debit', async () => {
    const { walletId, playerId } = await wallet('1000.00');
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        submitWager(pick(i), { walletId, playerId, kind: 'BET', amount: '25.00', externalTransactionId: 'same-bet' }),
      ),
    );
    expect(responses.every((r) => r.status === 200 && r.body.status === 'PROCESSED')).toBe(true);
    expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(responses.map((r) => r.body.balance.amount))).toEqual(new Set(['975.00']));
    expect(await debitsOf(walletId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('975.00');
    await assertLedgerInvariant(orm, [walletId]);
  });

  test('2. two 80.00 BETs on a 100.00 wallet: exactly one wins (repeated on 10 wallets)', async () => {
    for (let round = 0; round < 10; round++) {
      const { walletId, playerId } = await wallet('100.00');
      const [a, b] = await Promise.all([
        submitWager(pick(round), { walletId, playerId, kind: 'BET', amount: '80.00' }),
        submitWager(pick(round + 1), { walletId, playerId, kind: 'BET', amount: '80.00' }),
      ]);
      const statuses = [a?.body.status, b?.body.status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      const rejected = [a, b].find((r) => r?.body.status === 'REJECTED');
      expect(rejected?.status).toBe(422);
      expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(walletId)).toBe('20.00');
      expect(await debitsOf(walletId)).toBe(1);
      // retries of both requests never debit again
      await Promise.all([submitWager(pick(2), { ...retryOf(a) }), submitWager(pick(0), { ...retryOf(b) })]);
      expect(await debitsOf(walletId)).toBe(1);
    }
  });

  test('3. different wallets are processed in parallel without interfering', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => wallet('100.00')));
    const results = await Promise.all(
      wallets.flatMap(({ walletId, playerId }, w) =>
        Array.from({ length: 10 }, (_, i) =>
          submitWager(pick(w + i), { walletId, playerId, kind: i % 2 === 0 ? 'BET' : 'WIN', amount: i % 2 === 0 ? '7.00' : '2.00' }),
        ),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const { walletId } of wallets) expect(await balanceOf(walletId)).toBe('75.00');
    await assertLedgerInvariant(
      orm,
      wallets.map((w) => w.walletId),
    );
  });

  test('4. three instances consuming the same queue (300 messages with duplicates) apply each operation once', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => wallet('100.00')));
    const messages = wallets.flatMap(({ walletId, playerId }) =>
      Array.from({ length: 5 }, () => {
        const body = wagerBody({ walletId, playerId, kind: 'BET', amount: '3.00' });
        return wagerMessage({ ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` });
      }),
    );
    // Cada mensagem enviada 2 vezes, intercaladas: 300 entregas para 150 operações.
    await Promise.all([...messages, ...messages].map((message) => sendWager(sqs, message)));
    await eventually(
      async () =>
        (await count(`SELECT count(*) c FROM wager_transactions WHERE wallet_id = ANY(?::uuid[]) AND kind = 'BET'`, [
          `{${wallets.map((w) => w.walletId).join(',')}}`,
        ])) === 150,
      60_000,
      'queue to be consumed',
    );
    await Bun.sleep(1000);
    for (const { walletId } of wallets) {
      expect(await debitsOf(walletId)).toBe(5);
      expect(await balanceOf(walletId)).toBe('85.00');
    }
    expect(await count(`SELECT count(*) c FROM inbox_messages WHERE message_id = ANY(?)`, [`{${messages.map((m) => m.messageId).join(',')}}`])).toBe(150);
    await assertLedgerInvariant(
      orm,
      wallets.map((w) => w.walletId),
    );
  });

  test('6. three publishers on the same outbox publish every committed event', async () => {
    await eventually(
      async () => (await count(`SELECT count(*) c FROM outbox_messages WHERE published_at IS NULL`, [])) === 0,
      60_000,
      'outbox to be empty',
    );
    const expected = (await sql<{ id: string }>(orm, `SELECT id FROM outbox_messages`)).map((r) => r.id);
    const received = new Set((await drainQueue(sqs, queues.events, { quietMs: 1500 })).map((e) => e.eventId));
    const missing = expected.filter((id) => !received.has(id));
    expect(missing).toEqual([]);
  });

  test('7. REFUND and ROLLBACK delivered before their references are resolved', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const ids = { bet1: `bet-${newId()}`, bet2: `bet-${newId()}` };
    const message = (kind: string, amount: string, ext: string, reference?: string) => {
      const body = wagerBody({ walletId, playerId, kind, amount, externalTransactionId: ext, reference });
      return wagerMessage({ ...body, idempotencyKey: `${body.providerId}:${ext}` });
    };
    const refundExt = `refund-${newId()}`;
    const rollbackExt = `rollback-${newId()}`;
    // As reversões chegam primeiro (mesmo grupo FIFO = mesma wallet, ordem preservada).
    await sendWager(sqs, message('REFUND', '40.00', refundExt, ids.bet1));
    await sendWager(sqs, message('ROLLBACK', '10.00', rollbackExt, ids.bet2));
    await sendWager(sqs, message('BET', '40.00', ids.bet1));
    await sendWager(sqs, message('BET', '10.00', ids.bet2));
    const statusOf = async (ext: string) =>
      (await api(pick(1), 'GET', `/providers/provider-a/wagering/transactions/${ext}`)).body?.status;
    await eventually(
      async () => (await statusOf(refundExt)) === 'PROCESSED' && (await statusOf(rollbackExt)) === 'PROCESSED',
      30_000,
      'pending references to resolve',
    );
    expect(await balanceOf(walletId)).toBe('100.00');
    expect(await count(`SELECT count(*) c FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId])).toBe(5);
    await assertLedgerInvariant(orm, [walletId]);
  });
});

function retryOf(response: Awaited<ReturnType<typeof submitWager>> | undefined) {
  const sent = response!.sent;
  return {
    walletId: sent.walletId,
    playerId: sent.playerId,
    kind: sent.kind,
    amount: sent.money.amount,
    externalTransactionId: sent.externalTransactionId,
  };
}
