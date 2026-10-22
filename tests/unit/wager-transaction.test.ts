import { describe, expect, test } from 'bun:test';
import { DomainError, InvalidTransactionStateError } from '../../src/shared/errors';
import { LedgerDirection } from '../../src/wallet/ledger-entry';
import { FailureCode } from '../../src/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/wagering/wager-transaction';
import { NOW, aProcessed, aTransaction, brl } from '../support/builders';

describe('WagerTransaction', () => {
  test('is born PENDING', () => {
    expect(aTransaction().status).toBe(WagerTransactionStatus.Pending);
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('%s requires a reference', (kind) => {
    expect(() => aTransaction({ kind })).toThrow(DomainError);
    expect(aTransaction({ kind, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('OPENING cannot be submitted from outside', () => {
    expect(() => aTransaction({ kind: WagerTransactionKind.Opening })).toThrow(DomainError);
  });

  test('requires a positive amount, except LOSS which may be zero', () => {
    expect(() => aTransaction({ money: brl('0.00') })).toThrow(DomainError);
    expect(aTransaction({ kind: WagerTransactionKind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
  });

  test.each([
    (tx: WagerTransaction) => tx.markProcessed(undefined, NOW, brl('1.00')),
    (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, NOW),
    (tx: WagerTransaction) => tx.fail(FailureCode.InternalError, NOW),
    (tx: WagerTransaction) => tx.markPendingReference(NOW),
  ])('terminal states refuse any further transition (%#)', (transition) => {
    for (const terminate of [
      (tx: WagerTransaction) => tx.markProcessed(undefined, NOW, brl('1.00')),
      (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, NOW),
      (tx: WagerTransaction) => tx.fail(FailureCode.InternalError, NOW),
    ]) {
      const tx = aTransaction();
      terminate(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
    }
  });

  test('PENDING_REFERENCE counts retries and can still finish', () => {
    const tx = aTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(NOW);
    tx.markPendingReference(NOW);
    expect(tx.referenceAttempts).toBe(1);
    tx.reject(FailureCode.ReferenceNotFound, NOW);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('matches only its own payload hash', () => {
    const tx = aTransaction({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  test('ledger direction follows the kind; ROLLBACK inverts its reference', () => {
    expect(aTransaction().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(aTransaction({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rollback = aTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(aProcessed())).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(aProcessed({ kind: WagerTransactionKind.Win }))).toBe(LedgerDirection.Debit);
    expect(() => aTransaction({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(DomainError);
  });

  test('createOpening is already processed with the initial balance', () => {
    const opening = WagerTransaction.createOpening({ id: 'o', walletId: 'w', playerId: 'p', money: brl('10.00'), at: NOW });
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.resultBalance?.toJSON().amount).toBe('10.00');
  });
});
