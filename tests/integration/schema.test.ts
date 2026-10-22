import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { isUniqueViolation } from '../../src/database/pg-errors';
import { newId } from '../../src/shared/ids';
import { resetDatabase, sql, testOrm } from '../support/db';

let orm: MikroORM;

beforeAll(async () => {
  await resetDatabase();
  orm = await testOrm();
});
afterAll(() => orm.close());

/** Wallet + transação OPENING + ledger coerentes, numa única transação. */
async function seedWallet(balance = '100.00'): Promise<{ walletId: string; playerId: string }> {
  const walletId = newId();
  const playerId = newId();
  const openingId = newId();
  await orm.em.fork().transactional(async (em) => {
    await em.execute(
      `INSERT INTO wallets VALUES (?, ?, 'BRL', ?, 1, now(), now())`,
      [walletId, playerId, balance],
    );
    if (balance !== '0.00') {
      await em.execute(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at)
         VALUES (?, 'internal', ?, ?, '', ?, ?, 'opening', 'opening', 'OPENING', ?, 'BRL', 'PROCESSED', now(), now())`,
        [openingId, `opening:${walletId}`, `internal:opening:${walletId}`, walletId, playerId, balance],
      );
      await em.execute(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', ?, 'BRL', 0, ?, now())`,
        [newId(), walletId, openingId, balance, balance],
      );
    }
  });
  return { walletId, playerId };
}

async function insertTransaction(
  walletId: string,
  playerId: string,
  fields: { kind: string; status: string; amount?: string; ref?: string; refId?: string; failure?: string },
): Promise<string> {
  const id = newId();
  const ext = `ext-${id}`;
  await sql(
    orm,
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code, created_at, processed_at)
     VALUES (?, 'provider-a', ?, ?, 'h', ?, ?, 'round-1', 'game', ?, ?, 'BRL', ?, ?, ?, ?, now(),
       CASE WHEN ? IN ('PROCESSED','REJECTED','FAILED') THEN now() END)`,
    [id, ext, `provider-a:${ext}`, walletId, playerId, fields.kind, fields.amount ?? '10.00', fields.ref ?? null,
      fields.refId ?? null, fields.status, fields.failure ?? null, fields.status],
  );
  return id;
}

describe('schema guarantees', () => {
  test('wallet balance can never be negative', async () => {
    const { walletId } = await seedWallet();
    await expect(sql(orm, `UPDATE wallets SET balance = -1 WHERE id = ?`, [walletId])).rejects.toThrow(
      /ck_wallets_balance_non_negative/,
    );
  });

  test('one wallet per player and currency', async () => {
    const { playerId } = await seedWallet('0.00');
    const error = await sql(orm, `INSERT INTO wallets VALUES (?, ?, 'BRL', 0, 1, now(), now())`, [newId(), playerId]).catch(
      (e) => e,
    );
    expect(isUniqueViolation(error, 'uq_wallets_player_currency')).toBe(true);
  });

  test('wallet balance must match the last ledger entry at commit time', async () => {
    const { walletId } = await seedWallet();
    await expect(sql(orm, `UPDATE wallets SET balance = balance + 1 WHERE id = ?`, [walletId])).rejects.toThrow(
      /does not match ledger/,
    );
  });

  test('a wallet cannot be born with balance but no opening entry', async () => {
    await expect(
      sql(orm, `INSERT INTO wallets VALUES (?, ?, 'BRL', 50, 1, now(), now())`, [newId(), newId()]),
    ).rejects.toThrow(/does not match ledger/);
  });

  test('ledger rows cannot be updated, deleted or truncated', async () => {
    const { walletId } = await seedWallet();
    await expect(sql(orm, `UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [walletId])).rejects.toThrow(
      /append-only/,
    );
    await expect(sql(orm, `DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId])).rejects.toThrow(/append-only/);
    await expect(sql(orm, `TRUNCATE wallet_ledger_entries CASCADE`)).rejects.toThrow(/append-only/);
  });

  test('ledger arithmetic is checked by the database', async () => {
    const { walletId, playerId } = await seedWallet();
    const txId = await insertTransaction(walletId, playerId, { kind: 'BET', status: 'PROCESSED' });
    await expect(
      sql(
        orm,
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'DEBIT', 10, 'BRL', 100, 95, now())`,
        [newId(), walletId, txId],
      ),
    ).rejects.toThrow(/ck_ledger_arithmetic/);
  });

  test('the same idempotency key or provider transaction cannot be stored twice', async () => {
    const { walletId, playerId } = await seedWallet();
    const id = await insertTransaction(walletId, playerId, { kind: 'BET', status: 'PENDING' });
    const [row] = await sql<{ external_transaction_id: string }>(
      orm,
      `SELECT external_transaction_id FROM wager_transactions WHERE id = ?`,
      [id],
    );
    const error = await sql(
      orm,
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, created_at)
       VALUES (?, 'provider-a', ?, 'another-key', 'h', ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now())`,
      [newId(), row?.external_transaction_id, walletId, playerId],
    ).catch((e) => e);
    expect(isUniqueViolation(error, 'uq_wager_provider_external')).toBe(true);
  });

  test('a reference can be reversed only once', async () => {
    const { walletId, playerId } = await seedWallet();
    const betId = await insertTransaction(walletId, playerId, { kind: 'BET', status: 'PROCESSED' });
    await insertTransaction(walletId, playerId, { kind: 'REFUND', status: 'PROCESSED', ref: 'x', refId: betId });
    const error = await insertTransaction(walletId, playerId, {
      kind: 'ROLLBACK',
      status: 'PROCESSED',
      ref: 'x',
      refId: betId,
    }).catch((e) => e);
    expect(isUniqueViolation(error, 'ux_wager_single_reversal')).toBe(true);
  });

  test('reversals require a reference and rejections require a failure code', async () => {
    const { walletId, playerId } = await seedWallet();
    await expect(insertTransaction(walletId, playerId, { kind: 'REFUND', status: 'PENDING' })).rejects.toThrow(
      /ck_wager_reversal_reference/,
    );
    await expect(insertTransaction(walletId, playerId, { kind: 'BET', status: 'REJECTED' })).rejects.toThrow(
      /ck_wager_failure_code/,
    );
    await expect(insertTransaction(walletId, playerId, { kind: 'BET', status: 'PENDING', amount: '0.00' })).rejects.toThrow(
      /ck_wager_amount/,
    );
  });

  test('terminal transactions are immutable and no transaction is ever deleted', async () => {
    const { walletId, playerId } = await seedWallet();
    const id = await insertTransaction(walletId, playerId, { kind: 'BET', status: 'PROCESSED' });
    await expect(sql(orm, `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`, [id])).rejects.toThrow(
      /is terminal/,
    );
    await expect(sql(orm, `DELETE FROM wager_transactions WHERE id = ?`, [id])).rejects.toThrow(/append-only/);
  });

  test('business fields of a pending transaction cannot change', async () => {
    const { walletId, playerId } = await seedWallet();
    const id = await insertTransaction(walletId, playerId, { kind: 'BET', status: 'PENDING' });
    await expect(sql(orm, `UPDATE wager_transactions SET amount = 99 WHERE id = ?`, [id])).rejects.toThrow(/immutable/);
  });

  test('migrations are reversible', async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    const [gone] = await sql<{ count: string }>(orm, `SELECT count(*) FROM pg_tables WHERE tablename = 'wallets'`);
    expect(Number(gone?.count)).toBe(0);
    await migrator.up();
    const [back] = await sql<{ count: string }>(orm, `SELECT count(*) FROM pg_tables WHERE tablename = 'wallets'`);
    expect(Number(back?.count)).toBe(1);
  });
});
