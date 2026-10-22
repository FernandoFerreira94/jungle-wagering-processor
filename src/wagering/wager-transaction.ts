import { DomainError, InvalidTransactionStateError } from '../shared/errors';
import { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/ledger-entry';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);

/** Tipos que cada operação pode referenciar. */
export const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** id no provedor — não o id interno */
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. OPENING só via `createOpening`. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError('OPENING_NOT_ALLOWED', 'OPENING is internal and cannot be submitted');
    }
    const tx = WagerTransaction.build(props);
    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED', `${tx.kind} requires referenceExternalTransactionId`);
    }
    const mustBePositive = tx.kind !== WagerTransactionKind.Loss;
    if (tx.money.isNegative() || (mustBePositive && tx.money.isZero())) {
      throw new DomainError('INVALID_AMOUNT', `${tx.kind} amount must be greater than zero`);
    }
    return tx;
  }

  /** Crédito interno de abertura da wallet, já aplicado. */
  static createOpening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const tx = WagerTransaction.build({
      id: props.id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: '',
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
    tx.markProcessed(undefined, props.at, props.money);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  /** Saldo observado quando a transação chegou a um estado final (usado no replay). */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertCanMoveTo(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = balanceAfter;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Referência ainda não chegou: espera o worker tentar de novo em `nextAttemptAt`. */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.PendingReference);
    if (this._status === WagerTransactionStatus.PendingReference) this._referenceAttempts += 1;
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, at: Date, balanceAt?: Money): void {
    this.assertCanMoveTo(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = balanceAt;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new DomainError('REFERENCE_REQUIRED', 'ROLLBACK direction depends on its reference');
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new DomainError('NO_BALANCE_EFFECT', 'LOSS does not move the balance');
    }
  }

  private assertCanMoveTo(next: WagerTransactionStatus): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status, next);
  }
}
