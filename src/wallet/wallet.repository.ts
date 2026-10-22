import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import { LedgerEntryRecord, WalletRecord } from '../database/entities';
import { Money } from '../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Wallet } from './wallet';

export interface LedgerPage {
  entries: { entry: WalletLedgerEntry; seq: string }[];
  nextSeq?: string;
}

export class WalletRepository {
  async findById(em: EntityManager, id: string): Promise<Wallet | null> {
    const record = await em.findOne(WalletRecord, { id });
    return record ? toWallet(record) : null;
  }

  /** SELECT … FOR UPDATE: a unidade de concorrência é a wallet. */
  async lockById(em: EntityManager, id: string): Promise<Wallet | null> {
    const record = await em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return record ? toWallet(record) : null;
  }

  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    await em.insert(WalletRecord, toRecord(wallet));
  }

  /** Atualização condicionada à versão lida: defesa extra contra lost update. */
  async update(em: EntityManager, wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toDecimal(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new Error(`Wallet ${wallet.id} changed concurrently (expected version ${expectedVersion})`);
  }

  async appendLedger(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await em.insert(LedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toDecimal(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toDecimal(),
      balanceAfter: entry.balanceAfter.toDecimal(),
      createdAt: entry.createdAt,
    });
  }

  async pageLedger(em: EntityManager, walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage> {
    const rows = await em.execute<LedgerRow[]>(
      `SELECT seq, id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND seq > ?
        ORDER BY seq
        LIMIT ?`,
      [walletId, afterSeq ?? '0', limit + 1],
    );
    const page = rows.slice(0, limit).map((row) => ({ entry: toEntry(row), seq: String(row.seq) }));
    return { entries: page, nextSeq: rows.length > limit ? page.at(-1)?.seq : undefined };
  }

  /** Saldo recalculado só a partir do ledger (créditos − débitos). */
  async ledgerTotals(em: EntityManager, walletId: string, currency: string): Promise<{ balance: Money; entries: number }> {
    const [row] = await em.execute<{ credits: string; debits: string; entries: string }[]>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text  AS debits,
              count(*)::text AS entries
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    const credits = Money.fromDecimal(row?.credits ?? '0', currency);
    const debits = Money.fromDecimal(row?.debits ?? '0', currency);
    return { balance: credits.subtract(debits), entries: Number(row?.entries ?? 0) };
  }
}

interface LedgerRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.fromDecimal(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function toRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toDecimal(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function toEntry(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction,
    money: Money.fromDecimal(row.amount, row.currency),
    balanceBefore: Money.fromDecimal(row.balance_before, row.currency),
    balanceAfter: Money.fromDecimal(row.balance_after, row.currency),
    createdAt: new Date(row.created_at),
  });
}
