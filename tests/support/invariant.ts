import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { sql } from './db';

/**
 * Invariante final de todos os testes de concorrência:
 * wallet.balance == créditos − débitos do ledger == balance_after do último lançamento,
 * e a cadeia do ledger não tem buracos (cada balance_before é o balance_after anterior).
 */
export async function assertLedgerInvariant(orm: MikroORM, walletIds: string[]): Promise<void> {
  const rows = await sql<{ id: string; balance: string; calculated: string; last_after: string | null; broken_links: string }>(
    orm,
    `SELECT w.id, w.balance::text,
            (COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'CREDIT'), 0)
           - COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'DEBIT'), 0))::text AS calculated,
            (SELECT balance_after::text FROM wallet_ledger_entries x WHERE x.wallet_id = w.id ORDER BY seq DESC LIMIT 1) AS last_after,
            (SELECT count(*) FROM (
               SELECT balance_before, lag(balance_after) OVER (ORDER BY seq) AS prev
                 FROM wallet_ledger_entries y WHERE y.wallet_id = w.id) chain
              WHERE prev IS NOT NULL AND balance_before <> prev)::text AS broken_links
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ANY(?::uuid[])
      GROUP BY w.id`,
    [`{${walletIds.join(',')}}`],
  );
  expect(rows).toHaveLength(walletIds.length);
  for (const row of rows) {
    expect({ id: row.id, balance: row.calculated, links: row.broken_links }).toEqual({ id: row.id, balance: row.balance, links: '0' });
    expect(row.last_after ?? '0.00').toBe(row.balance);
  }
}
