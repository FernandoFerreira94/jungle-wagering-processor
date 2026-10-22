import { newId } from '../shared/ids';
import type { MoneyProps } from '../shared/money';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/ledger-entry';
import type { Wallet } from '../wallet/wallet';
import type { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-transaction';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface EventContext {
  correlationId: string;
  causationId?: string;
  now: Date;
}

export interface IntegrationEventJSON<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  protected static props<T>(aggregateId: string, data: T, ctx: EventContext): IntegrationEventProps<T> {
    return {
      eventId: newId(),
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
      data,
    };
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventJSON<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: { ...this.data } as T,
    };
  }
}

interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
}

function transactionData(tx: WagerTransaction): TransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends TransactionEventData {
  referenceTransactionId?: string;
  balanceAfter?: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.props(
        tx.id,
        { ...transactionData(tx), referenceTransactionId: tx.referenceTransactionId, balanceAfter: tx.resultBalance?.toJSON() },
        ctx,
      ),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      IntegrationEvent.props(tx.id, { ...transactionData(tx), failureCode: tx.failureCode as FailureCode }, ctx),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.props(
        tx.id,
        { ...transactionData(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId as string },
        ctx,
      ),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx,
      ),
    );
  }
}
