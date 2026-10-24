import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SqsGateway } from '../../src/messaging/sqs';
import { api, createWallet, wagerBody, submitWager } from '../support/app';
import { resetDatabase, sql, testOrm } from '../support/db';
import { eventually, startInstances, stopAll, type Instance } from '../support/instances';
import { assertLedgerInvariant } from '../support/invariant';
import { drainAll, sendWager, testSqs, wagerMessage } from '../support/sqs';

let orm: MikroORM;
let sqs: SqsGateway;
const running: Instance[] = [];

beforeAll(async () => {
  await resetDatabase();
  sqs = testSqs();
  await drainAll(sqs);
  orm = await testOrm();
});

afterAll(async () => {
  await stopAll(running);
  await orm?.close();
  sqs?.destroy();
});

async function start(count: number, env: Record<string, string> = {}): Promise<Instance[]> {
  const started = await startInstances(count, { SQS_VISIBILITY_SECONDS: '2', SQS_RETRY_BASE_SECONDS: '1', ...env });
  running.push(...started);
  return started;
}

const count = async (query: string, params: unknown[] = []) => Number((await sql<{ c: string }>(orm, query, params))[0]?.c);

function betMessage(walletId: string, playerId: string, amount = '1.00') {
  const body = wagerBody({ walletId, playerId, kind: 'BET', amount });
  return wagerMessage({ ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` });
}

describe('crash recovery', () => {
  test('5. a worker killed after the commit and before the ack does not cause a second debit', async () => {
    const [api1] = await start(1, { ROLE_CONSUMER: 'false' });
    const { walletId, playerId } = await createWallet(api1!.url, '100.00');
    const message = betMessage(walletId, playerId, '10.00');

    const [crashing] = await start(1, { FAULT_CRASH_AFTER_COMMIT: 'true', ROLE_OUTBOX: 'false', ROLE_PENDING_WORKER: 'false' });
    await sendWager(sqs, message);
    expect(await crashing!.proc.exited).toBe(137);
    // O commit aconteceu, o ack não: a mensagem continua na fila.
    expect(await count(`SELECT count(*) c FROM inbox_messages WHERE message_id = ?`, [message.messageId])).toBe(1);

    await start(1);
    await eventually(
      async () => (await sql<{ c: string }>(orm, `SELECT 1 c FROM wager_transactions LIMIT 0`)).length === 0 && (await queueIsEmpty()),
      30_000,
      'redelivered message to be acked',
    );
    expect(await count(`SELECT count(*) c FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId])).toBe(1);
    expect((await api(api1!.url, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('90.00');
    await assertLedgerInvariant(orm, [walletId]);
  });

  test('8. instances killed mid-traffic and restarted end consistent', async () => {
    const group = await start(3);
    const wallets = await Promise.all(Array.from({ length: 15 }, (_, i) => createWallet(group[i % 3]!.url, '500.00')));
    const messages = wallets.flatMap(({ walletId, playerId }) => Array.from({ length: 10 }, () => betMessage(walletId, playerId, '2.00')));

    // Tráfego HTTP e SQS ao mesmo tempo; no meio, duas instâncias morrem com SIGKILL.
    const sending = Promise.all(messages.map((m) => sendWager(sqs, m)));
    const http = Promise.all(
      wallets.flatMap(({ walletId, playerId }, w) =>
        Array.from({ length: 4 }, (_, i) =>
          submitWager(group[(w + i) % 3]!.url, { walletId, playerId, kind: 'BET', amount: '5.00', externalTransactionId: `http-${walletId}-${i}` }).catch(() => null),
        ),
      ),
    );
    await Bun.sleep(300);
    await Promise.all([group[1]!.kill('SIGKILL'), group[2]!.kill('SIGKILL')]);
    await Promise.all([sending, http]);
    await start(2);

    // Requisições HTTP que morreram junto com a instância são reenviadas pelo "provedor".
    const survivor = running.at(-1)!.url;
    await Promise.all(
      wallets.flatMap(({ walletId, playerId }) =>
        Array.from({ length: 4 }, (_, i) =>
          submitWager(survivor, { walletId, playerId, kind: 'BET', amount: '5.00', externalTransactionId: `http-${walletId}-${i}` }),
        ),
      ),
    );
    const ids = `{${wallets.map((w) => w.walletId).join(',')}}`;
    await eventually(
      async () => (await count(`SELECT count(*) c FROM wager_transactions WHERE wallet_id = ANY(?::uuid[]) AND kind = 'BET'`, [ids])) === 210,
      90_000,
      'all operations to be applied after restart',
    );
    for (const { walletId } of wallets) {
      expect((await api(survivor, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('460.00');
      const reconciliation = await api(survivor, 'POST', `/wallets/${walletId}/reconciliation`);
      expect(reconciliation.body.consistent).toBe(true);
    }
    await assertLedgerInvariant(
      orm,
      wallets.map((w) => w.walletId),
    );
    await eventually(async () => (await count(`SELECT count(*) c FROM outbox_messages WHERE published_at IS NULL`)) === 0, 30_000, 'outbox to drain');
  });
});

async function queueIsEmpty(): Promise<boolean> {
  const [row] = await sql<{ c: string }>(orm, `SELECT count(*) c FROM inbox_messages WHERE processed_at IS NULL`);
  if (Number(row?.c) !== 0) return false;
  const attributes = await sqs.receive((await import('../support/sqs')).queues.transactions, 1, 0, 0);
  return attributes.length === 0;
}
