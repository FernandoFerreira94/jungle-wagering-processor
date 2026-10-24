import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, DomainError, InsufficientFundsError } from '../../src/shared/errors';
import { Money } from '../../src/shared/money';
import { LedgerDirection } from '../../src/wallet/ledger-entry';
import { NOW, aWallet, brl } from '../support/builders';

const later = new Date(NOW.getTime() + 1000);

describe('Wallet', () => {
  test('refuses a credit above the balance limit without changing its state', () => {
    const wallet = aWallet('999999999999999999.99');
    expect(() => wallet.credit(brl('0.01'), 'overflow', later)).toThrow(DomainError);
    expect(wallet.balance.toJSON().amount).toBe('999999999999999999.99');
    expect(wallet.version).toBe(1);
  });
  test('starts at version 1 with the opening entry matching the initial balance', () => {
    const wallet = aWallet('1000.00');
    expect(wallet.version).toBe(1);
    const opening = wallet.openingEntry('opening-tx');
    expect(opening.direction).toBe(LedgerDirection.Credit);
    expect(opening.balanceBefore.toJSON().amount).toBe('0.00');
    expect(opening.balanceAfter.toJSON().amount).toBe('1000.00');
  });

  test('debit returns the matching ledger entry and bumps the version', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.debit(brl('80.00'), 'tx-1', later);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('never goes negative and leaves state untouched on failure', () => {
    const wallet = aWallet('100.00');
    expect(() => wallet.debit(brl('100.01'), 'tx-1', later)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('allows debiting the whole balance', () => {
    const wallet = aWallet('100.00');
    wallet.debit(brl('100.00'), 'tx-1', later);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('credit increases balance and version', () => {
    const wallet = aWallet('0.00');
    wallet.credit(brl('5.00'), 'tx-1', later);
    expect(wallet.balance.toJSON().amount).toBe('5.00');
    expect(wallet.version).toBe(2);
  });

  test('rejects money in another currency', () => {
    const wallet = aWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit(usd, 'tx-1', later)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, 'tx-1', later)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });
});
