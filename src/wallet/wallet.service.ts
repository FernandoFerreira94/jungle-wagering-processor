import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../database/database';
import { isUniqueViolation } from '../database/pg-errors';
import { WagerTransactionProcessed, WalletBalanceChanged, type EventContext } from '../messaging/integration-events';
import { OutboxRepository } from '../messaging/outbox.repository';
import { NotFoundError, ValidationError, WalletAlreadyExistsError } from '../shared/errors';
import { newId } from '../shared/ids';
import { JsonLogger } from '../shared/json-logger';
import { Metrics } from '../shared/metrics';
import type { Money, MoneyProps } from '../shared/money';
import { WagerTransaction } from '../wagering/wager-transaction';
import { WagerTransactionRepository } from '../wagering/wager-transaction.repository';
import type { LedgerDirection } from './ledger-entry';
import { Wallet } from './wallet';
import { WalletRepository } from './wallet.repository';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class WalletService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(WagerTransactionRepository) private readonly transactions: WagerTransactionRepository,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Cria a wallet; saldo inicial > 0 vira transação OPENING + ledger + eventos, tudo na mesma transação SQL. */
  async create(input: { playerId: string; initialBalance: Money }, correlationId: string): Promise<WalletView> {
    const now = new Date();
    const wallet = Wallet.open({ id: newId(), playerId: input.playerId, initialBalance: input.initialBalance, now });
    try {
      await this.db.transaction(async (em) => {
        await this.wallets.insert(em, wallet);
        if (wallet.balance.isPositive()) {
          const opening = WagerTransaction.createOpening({
            id: newId(),
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: wallet.balance,
            at: now,
          });
          const entry = wallet.openingEntry(opening.id);
          const ctx: EventContext = { correlationId, now };
          await this.transactions.insert(em, opening);
          await this.wallets.appendLedger(em, entry);
          await this.outbox.add(em, WagerTransactionProcessed.from(opening, ctx), WalletBalanceChanged.from(wallet, entry, ctx));
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, 'uq_wallets_player_currency')) throw new WalletAlreadyExistsError();
      throw error;
    }
    this.logger.info('wallet created', { correlationId, walletId: wallet.id });
    return toView(wallet);
  }

  async get(walletId: string): Promise<WalletView> {
    const wallet = await this.db.read((em) => this.wallets.findById(em, walletId));
    if (!wallet) throw new NotFoundError('Wallet', walletId);
    return toView(wallet);
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<{ items: LedgerEntryView[]; nextCursor: string | null }> {
    await this.get(walletId);
    const page = await this.db.read((em) => this.wallets.pageLedger(em, walletId, decodeCursor(cursor), limit));
    return {
      items: page.entries.map(({ entry }) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextSeq ? encodeCursor(page.nextSeq) : null,
    };
  }

  /** Compara o saldo gravado com o recalculado pelo ledger. Divergência é sinalizada, nunca corrigida. */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationView> {
    // Lock compartilhado: lê saldo e ledger num ponto consistente sem bloquear outras leituras.
    const result = await this.db.transaction(async (em) => {
      await em.execute(`SELECT 1 FROM wallets WHERE id = ? FOR SHARE`, [walletId]);
      const wallet = await this.wallets.findById(em, walletId);
      if (!wallet) throw new NotFoundError('Wallet', walletId);
      const totals = await this.wallets.ledgerTotals(em, walletId, wallet.currency);
      return { wallet, totals };
    });
    const { wallet, totals } = result;
    const difference = wallet.balance.subtract(totals.balance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationMismatches.inc();
      this.logger.error('reconciliation mismatch', { correlationId, walletId, checkedEntries: totals.entries });
    }
    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: totals.balance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: totals.entries,
    };
  }
}

function toView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const { s } = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { s?: unknown };
    if (typeof s === 'string' && /^\d+$/.test(s)) return s;
  } catch {
    // cai no erro abaixo
  }
  throw new ValidationError(['cursor is invalid']);
}
