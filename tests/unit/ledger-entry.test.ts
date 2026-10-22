import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../src/shared/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/wallet/ledger-entry';
import { NOW, brl } from '../support/builders';

const base = { walletId: 'w', transactionId: 't', createdAt: NOW };

describe('WalletLedgerEntry', () => {
  test('accepts a balanced debit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects wrong arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('75.00'),
      }),
    ).toThrow(DomainError);
  });

  test('rejects zero amounts', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(DomainError);
  });

  test('has no mutable fields', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });
});
