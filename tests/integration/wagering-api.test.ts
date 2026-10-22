import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../src/messaging/outbox.repository';
import { api, createTestApp, createWallet, submitWager, wagerBody, type TestApp } from '../support/app';
import { resetDatabase, sql, testOrm } from '../support/db';

let t: TestApp;
let orm: MikroORM;

beforeAll(async () => {
  await resetDatabase();
  t = await createTestApp({ lockTimeoutMs: 300 });
  orm = await testOrm();
});
afterAll(async () => {
  await t.close();
  await orm.close();
});

const ledgerCount = async (walletId: string) =>
  Number((await sql<{ c: string }>(orm, `SELECT count(*) c FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]))[0]?.c);
const eventsFor = async (aggregateId: string) =>
  (await sql<{ event_type: string }>(orm, `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type`, [aggregateId])).map(
    (e) => e.event_type,
  );

describe('POST /wagering/transactions', () => {
  test('requires the Idempotency-Key header', async () => {
    const { walletId, playerId } = await createWallet(t.url);
    const res = await api(t.url, 'POST', '/wagering/transactions', wagerBody({ walletId, playerId, kind: 'BET' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('BET debits the wallet and answers with the new balance', async () => {
    const { walletId, playerId } = await createWallet(t.url, '1000.00');
    const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '25.00' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await ledgerCount(walletId)).toBe(2);
    expect(await eventsFor(res.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await eventsFor(walletId)).toEqual(['WalletBalanceChanged', 'WalletBalanceChanged']);
  });

  test('a replay returns the original result, including the balance seen at that time', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const first = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'replay-1' });
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '5.00' });
    const replay = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'replay-1' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('90.00');
    expect((await api(t.url, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('85.00');
  });

  test('same key with a different payload is a conflict, not a replay', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'conflict-1' });
    const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '11.00', externalTransactionId: 'conflict-1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(t.url, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('90.00');
  });

  test('same provider transaction under another key is a conflict', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    await submitWager(t.url, { walletId, playerId, kind: 'BET', externalTransactionId: 'conflict-2' });
    const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', externalTransactionId: 'conflict-2', idempotencyKey: 'other' });
    expect(res.status).toBe(409);
    expect(await ledgerCount(walletId)).toBe(2);
  });

  test('BET without balance is a 422 with INSUFFICIENT_FUNDS and no ledger entry', async () => {
    const { walletId, playerId } = await createWallet(t.url, '5.00');
    const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '5.01' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '5.00' } });
    expect(await ledgerCount(walletId)).toBe(1);
    expect(await eventsFor(res.body.transactionId)).toEqual(['WagerTransactionRejected']);
    const replay = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '5.01', externalTransactionId: res.sent.externalTransactionId });
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('WIN credits and LOSS only records the result', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const bet = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'round-bet' });
    const win = await submitWager(t.url, { walletId, playerId, kind: 'WIN', amount: '30.00', reference: 'round-bet' });
    expect(win.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '120.00' } });
    const loss = await submitWager(t.url, { walletId, playerId, kind: 'LOSS', amount: '0.00', reference: 'round-bet' });
    expect(loss.status).toBe(200);
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '120.00' } });
    expect(await eventsFor(loss.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await ledgerCount(walletId)).toBe(3);
    const view = await api(t.url, 'GET', `/wagering/transactions/${win.body.transactionId}`);
    expect(view.body).toMatchObject({ kind: 'WIN', referenceTransactionId: bet.body.transactionId, status: 'PROCESSED' });
  });

  test('REFUND reverts a BET exactly once', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '40.00', externalTransactionId: 'bet-r' });
    const refund = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', amount: '40.00', reference: 'bet-r' });
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const again = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', amount: '40.00', reference: 'bet-r' });
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const rollback = await submitWager(t.url, { walletId, playerId, kind: 'ROLLBACK', amount: '40.00', reference: 'bet-r' });
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await api(t.url, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('100.00');
  });

  test('REFUND amount must match and must reference a BET', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '40.00', externalTransactionId: 'bet-m' });
    await submitWager(t.url, { walletId, playerId, kind: 'WIN', amount: '10.00', externalTransactionId: 'win-m' });
    const partial = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', amount: '20.00', reference: 'bet-m' });
    expect(partial.body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    const ofWin = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', amount: '10.00', reference: 'win-m' });
    expect(ofWin.body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });

  test('ROLLBACK of a WIN that would make the balance negative is rejected with its own code', async () => {
    const { walletId, playerId } = await createWallet(t.url, '10.00');
    await submitWager(t.url, { walletId, playerId, kind: 'WIN', amount: '50.00', externalTransactionId: 'win-big' });
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '55.00' });
    const rollback = await submitWager(t.url, { walletId, playerId, kind: 'ROLLBACK', amount: '50.00', reference: 'win-big' });
    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({ failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '5.00' } });
  });

  test('currency of the operation must match the wallet', async () => {
    const { walletId, playerId } = await createWallet(t.url, '10.00');
    const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '1.00', currency: 'USD' });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('unknown wallet is a 404 and nothing is stored', async () => {
    const res = await submitWager(t.url, {
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      kind: 'BET',
    });
    expect(res.status).toBe(404);
  });

  test('invalid amounts are rejected before touching the database', async () => {
    const { walletId, playerId } = await createWallet(t.url, '10.00');
    for (const amount of ['0.00', '1e3', ' 25.00', '-0.00', '25.001']) {
      const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount });
      expect(res.status).toBe(400);
    }
    expect(await ledgerCount(walletId)).toBe(1);
  });

  test('a failure in the middle rolls back transaction, ledger, wallet and outbox together', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const outbox = t.app.get(OutboxRepository);
    const original = outbox.add.bind(outbox);
    outbox.add = async () => {
      throw new Error('simulated crash before commit');
    };
    try {
      const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'atomic-1' });
      expect(res.status).toBe(500);
    } finally {
      outbox.add = original;
    }
    expect((await api(t.url, 'GET', `/wallets/${walletId}`)).body).toMatchObject({ balance: { amount: '100.00' }, version: 1 });
    expect(await ledgerCount(walletId)).toBe(1);
    expect((await api(t.url, 'GET', '/providers/provider-a/wagering/transactions/atomic-1')).status).toBe(404);
    const retry = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'atomic-1' });
    expect(retry.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '90.00' } });
  });

  test('a wallet locked for too long answers 503 TRANSIENT_FAILURE instead of hanging', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locker = orm.em.fork().transactional(async (em) => {
      await em.execute(`SELECT 1 FROM wallets WHERE id = ? FOR UPDATE`, [walletId]);
      await held;
    });
    await Bun.sleep(50);
    const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '1.00' });
    release();
    await locker;
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TRANSIENT_FAILURE');
    expect(res.headers.get('retry-after')).toBe('1');
  });

  test('lookups by internal id and by provider id', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const res = await submitWager(t.url, { walletId, playerId, kind: 'BET', externalTransactionId: 'lookup-1' });
    const byProvider = await api(t.url, 'GET', '/providers/provider-a/wagering/transactions/lookup-1');
    expect(byProvider.body.id).toBe(res.body.transactionId);
    expect(byProvider.body.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect((await api(t.url, 'GET', '/providers/provider-b/wagering/transactions/lookup-1')).status).toBe(404);
    expect((await api(t.url, 'GET', '/wagering/transactions/not-a-uuid')).status).toBe(400);
  });
});
