import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/money';
import { LedgerDirection } from '../../src/wallet/ledger-entry';
import { FailureCode } from '../../src/wagering/failure-code';
import { decideWager } from '../../src/wagering/wager-rules';
import { WagerTransactionKind as Kind } from '../../src/wagering/wager-transaction';
import { NOW, aProcessed, aTransaction, aWallet, brl } from '../support/builders';

const bet = (amount = '10.00') => aProcessed({ externalTransactionId: 'bet-1', money: brl(amount) });
const decide = (input: Partial<Parameters<typeof decideWager>[0]> & Pick<Parameters<typeof decideWager>[0], 'tx'>) =>
  decideWager({ wallet: aWallet('100.00'), referenceAlreadyReversed: false, ...input });

describe('decideWager', () => {
  test('rejects a credit that would overflow the wallet balance', () => {
    expect(decide({ wallet: aWallet('999999999999999999.99'), tx: aTransaction({ kind: Kind.Win, money: brl('0.01') }) }))
      .toEqual({ kind: 'reject', code: FailureCode.BalanceLimitExceeded });
  });
  test('BET debits when there is enough balance', () => {
    expect(decide({ tx: aTransaction({ money: brl('100.00') }) })).toEqual({ kind: 'apply', direction: LedgerDirection.Debit });
  });

  test('BET without balance is rejected with INSUFFICIENT_FUNDS', () => {
    expect(decide({ tx: aTransaction({ money: brl('100.01') }) })).toEqual({ kind: 'reject', code: FailureCode.InsufficientFunds });
  });

  test('WIN credits, with or without a reference', () => {
    expect(decide({ tx: aTransaction({ kind: Kind.Win }) })).toEqual({ kind: 'apply', direction: LedgerDirection.Credit });
    const win = aTransaction({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' });
    expect(decide({ tx: win, reference: bet() })).toEqual({ kind: 'apply', direction: LedgerDirection.Credit });
  });

  test('LOSS has no balance effect', () => {
    expect(decide({ tx: aTransaction({ kind: Kind.Loss }) })).toEqual({ kind: 'no-balance-effect' });
  });

  test('REFUND of a processed BET credits', () => {
    const refund = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(decide({ tx: refund, reference: bet() })).toEqual({ kind: 'apply', direction: LedgerDirection.Credit });
  });

  test('REFUND can only reference a BET', () => {
    const refund = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'win-1' });
    const win = aProcessed({ kind: Kind.Win, externalTransactionId: 'win-1' });
    expect(decide({ tx: refund, reference: win })).toEqual({ kind: 'reject', code: FailureCode.ReferenceKindNotAllowed });
  });

  test('ROLLBACK of a WIN debits, and is rejected with its own code when the balance is short', () => {
    const win = aProcessed({ kind: Kind.Win, externalTransactionId: 'win-1', money: brl('50.00') });
    const rollback = aTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'win-1', money: brl('50.00') });
    expect(decide({ tx: rollback, reference: win })).toEqual({ kind: 'apply', direction: LedgerDirection.Debit });
    expect(decide({ tx: rollback, reference: win, wallet: aWallet('49.99') })).toEqual({
      kind: 'reject',
      code: FailureCode.ReversalInsufficientFunds,
    });
  });

  test('ROLLBACK of a BET credits', () => {
    const rollback = aTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'bet-1' });
    expect(decide({ tx: rollback, reference: bet() })).toEqual({ kind: 'apply', direction: LedgerDirection.Credit });
  });

  test('ROLLBACK cannot reference a LOSS', () => {
    const loss = aProcessed({ kind: Kind.Loss, externalTransactionId: 'loss-1' });
    const rollback = aTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'loss-1' });
    expect(decide({ tx: rollback, reference: loss })).toEqual({ kind: 'reject', code: FailureCode.ReferenceKindNotAllowed });
  });

  test.each([
    ['round', { roundId: 'round-2' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['provider', { providerId: 'provider-b' }],
  ])('reference from another %s is a mismatch', (_label, override) => {
    const refund = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    const other = aProcessed({ externalTransactionId: 'bet-1', ...override });
    expect(decide({ tx: refund, reference: other })).toEqual({ kind: 'reject', code: FailureCode.ReferenceMismatch });
  });

  test('reference in another currency is a mismatch', () => {
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    const refund = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    const other = aProcessed({ externalTransactionId: 'bet-1', money: usd });
    expect(decide({ tx: refund, reference: other })).toEqual({ kind: 'reject', code: FailureCode.ReferenceMismatch });
  });

  test('reversal amount must equal the reference amount', () => {
    const refund = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1', money: brl('9.99') });
    expect(decide({ tx: refund, reference: bet('10.00') })).toEqual({ kind: 'reject', code: FailureCode.ReferenceAmountMismatch });
  });

  test('missing reference waits', () => {
    const rollback = aTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'bet-1' });
    expect(decide({ tx: rollback })).toEqual({ kind: 'wait-reference' });
  });

  test('reference still waiting for its own reference also waits', () => {
    const pending = aTransaction({ kind: Kind.Refund, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-0' });
    pending.markPendingReference(NOW);
    const rollback = aTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'refund-1' });
    expect(decide({ tx: rollback, reference: pending })).toEqual({ kind: 'wait-reference' });
  });

  test('rejected reference cannot be reversed', () => {
    const rejected = aTransaction({ externalTransactionId: 'bet-1' });
    rejected.reject(FailureCode.InsufficientFunds, NOW);
    const refund = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(decide({ tx: refund, reference: rejected })).toEqual({ kind: 'reject', code: FailureCode.ReferenceNotProcessed });
  });

  test('a reference can be reversed only once', () => {
    const refund = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(decide({ tx: refund, reference: bet(), referenceAlreadyReversed: true })).toEqual({
      kind: 'reject',
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test('currency of the operation must match the wallet', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(decide({ tx: aTransaction({ money: usd }) })).toEqual({ kind: 'reject', code: FailureCode.CurrencyMismatch });
  });

  test('player must own the wallet', () => {
    expect(decide({ tx: aTransaction({ playerId: 'intruder' }) })).toEqual({ kind: 'reject', code: FailureCode.WalletPlayerMismatch });
  });
});
