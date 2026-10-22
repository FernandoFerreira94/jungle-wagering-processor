import { EntitySchema } from '@mikro-orm/core';

/*
 * Registros de persistência (formato das tabelas). O domínio nunca os vê:
 * os repositórios convertem registro ⇄ objeto de domínio.
 * Valores monetários ficam como string decimal (NUMERIC(20,2)) + moeda.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export class LedgerEntryRecord {
  seq?: string;
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date | null;
}

const money = { type: 'decimal', precision: 20, scale: 2 } as const;
const timestamp = { type: 'datetime', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balance: { ...money },
    version: { type: 'integer' },
    createdAt: { ...timestamp },
    updatedAt: { ...timestamp },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: { ...money },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    resultBalance: { ...money, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: { ...timestamp, nullable: true },
    createdAt: { ...timestamp },
    processedAt: { ...timestamp, nullable: true },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    seq: { type: 'bigint', persist: false },
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { ...money },
    currency: { type: 'string', length: 3 },
    balanceBefore: { ...money },
    balanceAfter: { ...money },
    createdAt: { ...timestamp },
  },
});

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'text' },
    receivedAt: { ...timestamp },
    processedAt: { ...timestamp, nullable: true },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'text' },
    eventType: { type: 'text' },
    payload: { type: 'json' },
    occurredAt: { ...timestamp },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamp },
    publishedAt: { ...timestamp, nullable: true },
  },
});

export const ALL_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema];
