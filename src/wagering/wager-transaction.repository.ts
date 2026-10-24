import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionRecord, WalletRecord } from '../database/entities';
import { Money } from '../shared/money';
import { FailureCode } from './failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export class WagerTransactionRepository {
  async findById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { id }, { refresh: true });
    return record ? rehydrateRecord(em, record) : null;
  }

  async lockById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return record ? rehydrateRecord(em, record) : null;
  }

  async findByIdempotencyKey(em: EntityManager, key: string): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { idempotencyKey: key }, { refresh: true });
    return record ? rehydrateRecord(em, record) : null;
  }

  async findByExternalId(em: EntityManager, providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, { refresh: true });
    return record ? rehydrateRecord(em, record) : null;
  }

  /** Já existe reversão aplicada para esta transação? */
  async hasProcessedReversal(em: EntityManager, referenceTransactionId: string): Promise<boolean> {
    const count = await em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  /** Ids de pendências vencidas (sem lock: o lock é feito por item, na ordem wallet → transação). */
  async findDuePendingReferences(em: EntityManager, now: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    const rows = await em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { fields: ['id', 'walletId'], orderBy: { nextReferenceAttemptAt: 'asc' }, limit },
    );
    return rows.map((row) => ({ id: row.id, walletId: row.walletId }));
  }

  async insert(em: EntityManager, tx: WagerTransaction): Promise<void> {
    await em.insert(WagerTransactionRecord, toRecord(tx));
  }

  async update(em: EntityManager, tx: WagerTransaction): Promise<void> {
    const { id, ...changes } = toRecord(tx);
    await em.nativeUpdate(WagerTransactionRecord, { id }, {
      status: changes.status,
      referenceTransactionId: changes.referenceTransactionId,
      failureCode: changes.failureCode,
      resultBalance: changes.resultBalance,
      referenceAttempts: changes.referenceAttempts,
      nextReferenceAttemptAt: changes.nextReferenceAttemptAt,
      processedAt: changes.processedAt,
    });
  }
}

function toRecord(tx: WagerTransaction): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toDecimal(),
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    resultBalance: tx.resultBalance?.toDecimal() ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
    createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null,
  };
}

async function rehydrateRecord(em: EntityManager, record: WagerTransactionRecord): Promise<WagerTransaction> {
  // Identidade é validada antes da moeda; ambas as rejeições podem ter moedas diferentes.
  const balanceCurrency = record.resultBalance != null &&
    (record.failureCode === FailureCode.CurrencyMismatch || record.failureCode === FailureCode.WalletPlayerMismatch)
    ? (await em.findOneOrFail(WalletRecord, { id: record.walletId })).currency
    : record.currency;
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.fromDecimal(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    resultBalance: record.resultBalance != null ? Money.fromDecimal(record.resultBalance, balanceCurrency) : undefined,
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
  });
}
