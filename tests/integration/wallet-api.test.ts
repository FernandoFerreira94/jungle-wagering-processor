import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { newId } from '../../src/shared/ids';
import { api, createTestApp, createWallet, type TestApp } from '../support/app';
import { resetDatabase, sql, testOrm } from '../support/db';

let t: TestApp;
let orm: MikroORM;

beforeAll(async () => {
  await resetDatabase();
  t = await createTestApp();
  orm = await testOrm();
});
afterAll(async () => {
  await t.close();
  await orm.close();
});

describe('wallet API', () => {
  test('creates a wallet with an OPENING credit in the ledger', async () => {
    const playerId = newId();
    const res = await api(t.url, 'POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });

    const ledger = await api(t.url, 'GET', `/wallets/${res.body.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({ direction: 'CREDIT', money: { amount: '1000.00', currency: 'BRL' } });

    const [opening] = await sql<{ kind: string; status: string }>(
      orm,
      `SELECT kind, status FROM wager_transactions WHERE wallet_id = ?`,
      [res.body.id],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
    const events = await sql<{ event_type: string }>(
      orm,
      `SELECT event_type FROM outbox_messages WHERE aggregate_id IN (?, (SELECT id::text FROM wager_transactions WHERE wallet_id = ?)) ORDER BY event_type`,
      [res.body.id, res.body.id],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('a zero initial balance creates no ledger entry', async () => {
    const { walletId } = await createWallet(t.url, '0.00');
    const ledger = await api(t.url, 'GET', `/wallets/${walletId}/ledger`);
    expect(ledger.body).toEqual({ items: [], nextCursor: null });
  });

  test('a second wallet for the same player and currency is a conflict', async () => {
    const playerId = newId();
    const body = { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } };
    expect((await api(t.url, 'POST', '/wallets', body)).status).toBe(201);
    const duplicate = await api(t.url, 'POST', '/wallets', body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('WALLET_ALREADY_EXISTS');
    const usd = await api(t.url, 'POST', '/wallets', { playerId, initialBalance: { amount: '10.00', currency: 'USD' } });
    expect(usd.status).toBe(201);
  });

  test('rejects invalid payloads with 400', async () => {
    for (const body of [
      { playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } },
      { playerId: newId(), initialBalance: { amount: 10, currency: 'BRL' } },
      { playerId: newId(), initialBalance: { amount: '-1.00', currency: 'BRL' } },
      { playerId: newId(), initialBalance: { amount: '1.001', currency: 'BRL' } },
    ]) {
      const res = await api(t.url, 'POST', '/wallets', body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    }
  });

  test('gets a wallet and 404s on an unknown one', async () => {
    const { walletId, playerId } = await createWallet(t.url, '5.00');
    const res = await api(t.url, 'GET', `/wallets/${walletId}`);
    expect(res.body).toEqual({ id: walletId, playerId, balance: { amount: '5.00', currency: 'BRL' }, version: 1 });
    expect((await api(t.url, 'GET', `/wallets/${newId()}`)).status).toBe(404);
  });

  test('paginates the ledger with a stable opaque cursor', async () => {
    const { walletId } = await createWallet(t.url, '5.00');
    const first = await api(t.url, 'GET', `/wallets/${walletId}/ledger?limit=1`);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBeNull();
    expect((await api(t.url, 'GET', `/wallets/${walletId}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await api(t.url, 'GET', `/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
  });

  test('reconciliation is consistent for a healthy wallet', async () => {
    const { walletId } = await createWallet(t.url, '975.00');
    const res = await api(t.url, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
  });

  test('reconciliation flags a divergence and does not fix it', async () => {
    const { walletId } = await createWallet(t.url, '10.00');
    // Simula corrupção por fora da aplicação, desligando os triggers só nesta sessão.
    await orm.em.fork().transactional(async (em) => {
      await em.execute(`SET LOCAL session_replication_role = replica`);
      await em.execute(`UPDATE wallets SET balance = balance + 1 WHERE id = ?`, [walletId]);
    });
    const res = await api(t.url, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: { amount: '1.00', currency: 'BRL' } });
    const again = await api(t.url, 'GET', `/wallets/${walletId}`);
    expect(again.body.balance.amount).toBe('11.00');
    const metrics = await fetch(`${t.url}/metrics`).then((r) => r.text());
    expect(metrics).toContain('reconciliation_mismatches_total 1');
  });

  test('health endpoints are open', async () => {
    expect((await api(t.url, 'GET', '/health/live')).body).toEqual({ status: 'ok' });
    const ready = await api(t.url, 'GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
  });

  test('propagates the correlation id', async () => {
    const res = await api(t.url, 'GET', '/health/live', undefined, { 'x-correlation-id': 'corr-123' });
    expect(res.headers.get('x-correlation-id')).toBe('corr-123');
  });
});
