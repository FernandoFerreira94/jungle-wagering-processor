import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config';
import { PendingReferenceWorker } from '../../src/wagering/pending-reference.worker';
import { ProcessWagerUseCase } from '../../src/wagering/process-wager.use-case';
import { api, createTestApp, createWallet, submitWager, type TestApp } from '../support/app';
import { resetDatabase, sql, testOrm } from '../support/db';

let t: TestApp;
let orm: MikroORM;
let worker: PendingReferenceWorker;
const FUTURE = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  await resetDatabase();
  t = await createTestApp({ pendingReference: { ...loadConfig().pendingReference, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
  worker = t.app.get(PendingReferenceWorker);
  orm = await testOrm();
});
afterAll(async () => {
  await t?.close();
  await orm?.close();
});

const transaction = async (id: string) => (await api(t.url, 'GET', `/wagering/transactions/${id}`)).body;

describe('out-of-order references', () => {
  test('concurrent stale batches cannot spend retries before the next scheduled time', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const refund = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', reference: 'backoff-reference' });
    await sql(orm, `UPDATE wager_transactions SET next_reference_attempt_at = now() - interval '1 second' WHERE id = ?`, [refund.body.transactionId]);
    const other = await createTestApp({ pendingReference: { maxAttempts: 3, baseDelayMs: 60000, maxDelayMs: 60000 } });
    try {
      const useCase = other.app.get(ProcessWagerUseCase);
      const results = await Promise.all(Array.from({ length: 3 }, () => useCase.retryPending(refund.body.transactionId, 'backoff-test')));
      expect(results.filter(Boolean)).toHaveLength(1);
      const [row] = await sql<{ status: string; reference_attempts: number }>(orm, `SELECT status, reference_attempts FROM wager_transactions WHERE id = ?`, [refund.body.transactionId]);
      expect(row).toEqual({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
    } finally {
      await other.close();
    }
  });
  test('ROLLBACK that arrives before its BET waits, then is applied by the worker', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const rollback = await submitWager(t.url, { walletId, playerId, kind: 'ROLLBACK', amount: '30.00', reference: 'late-bet' });
    expect(rollback.status).toBe(202);
    expect(rollback.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: null });
    const [event] = await sql<{ event_type: string }>(orm, `SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`, [
      rollback.body.transactionId,
    ]);
    expect(event?.event_type).toBe('WagerTransactionPendingReference');

    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '30.00', externalTransactionId: 'late-bet' });
    expect((await api(t.url, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('70.00');

    await worker.runOnce(FUTURE());
    expect(await transaction(rollback.body.transactionId)).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect((await api(t.url, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('100.00');
    const replay = await submitWager(t.url, {
      walletId,
      playerId,
      kind: 'ROLLBACK',
      amount: '30.00',
      reference: 'late-bet',
      externalTransactionId: rollback.sent.externalTransactionId,
    });
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
  });

  test('a reference from another provider with the same external id never resolves it', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    await submitWager(t.url, { walletId, playerId, kind: 'BET', providerId: 'provider-b', externalTransactionId: 'shared-id' });
    const refund = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', reference: 'shared-id' });
    expect(refund.status).toBe(202);
    await worker.runOnce(FUTURE());
    expect((await transaction(refund.body.transactionId)).status).toBe('PENDING_REFERENCE');
  });

  test('gives up after the attempt limit with REFERENCE_NOT_FOUND and an event', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const refund = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', reference: 'never-arrives' });
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(2);
      await worker.runOnce(FUTURE());
    }
    expect(await transaction(refund.body.transactionId)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    const events = await sql<{ event_type: string }>(
      orm,
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at`,
      [refund.body.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect((await api(t.url, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('100.00');
  });

  test('two workers at the same time apply the pending reversal once', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const refund = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', amount: '20.00', reference: 'race-bet' });
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '20.00', externalTransactionId: 'race-bet' });
    const other = await createTestApp({ pendingReference: t.config.pendingReference });
    try {
      await Promise.all([worker.runOnce(FUTURE()), other.app.get(PendingReferenceWorker).runOnce(FUTURE()), worker.runOnce(FUTURE())]);
    } finally {
      await other.close();
    }
    expect((await transaction(refund.body.transactionId)).status).toBe('PROCESSED');
    const [credits] = await sql<{ c: string }>(
      orm,
      `SELECT count(*) c FROM wallet_ledger_entries WHERE transaction_id = ?`,
      [refund.body.transactionId],
    );
    expect(Number(credits?.c)).toBe(1);
    expect((await api(t.url, 'GET', `/wallets/${walletId}`)).body.balance.amount).toBe('100.00');
  });

  test('a permanent error while retrying marks the transaction FAILED (terminal and auditable)', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const refund = await submitWager(t.url, { walletId, playerId, kind: 'REFUND', reference: 'broken' });
    const useCase = t.app.get(ProcessWagerUseCase);
    const original = useCase.retryPending.bind(useCase);
    useCase.retryPending = async () => {
      throw new Error('corrupted reference data');
    };
    try {
      await worker.runOnce(FUTURE());
    } finally {
      useCase.retryPending = original;
    }
    expect(await transaction(refund.body.transactionId)).toMatchObject({ status: 'FAILED', failureCode: 'INTERNAL_ERROR' });
  });
});
