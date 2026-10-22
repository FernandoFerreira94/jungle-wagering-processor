import { describe, expect, test } from 'bun:test';
import { WagerTransactionRejected, WalletBalanceChanged } from '../../src/messaging/integration-events';
import { FailureCode } from '../../src/wagering/failure-code';
import { NOW, aTransaction, aWallet, brl } from '../support/builders';

const ctx = { correlationId: 'corr-1', causationId: 'msg-1', now: NOW };

describe('integration events', () => {
  test('WalletBalanceChanged carries MoneyProps strings and the wallet version', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.debit(brl('25.00'), 'tx-1', NOW);
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-10-22T12:00:00.000Z');
    expect(json.aggregateId).toBe(wallet.id);
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('msg-1');
    expect(json.data).toEqual({
      walletId: wallet.id,
      transactionId: 'tx-1',
      direction: entry.direction,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('WagerTransactionRejected carries the failure code', () => {
    const tx = aTransaction();
    tx.reject(FailureCode.InsufficientFunds, NOW);
    const json = WagerTransactionRejected.from(tx, ctx).toJSON();
    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(String(json.data.status)).toBe('REJECTED');
  });

  test('every event gets a unique id', () => {
    const tx = aTransaction();
    tx.reject(FailureCode.InsufficientFunds, NOW);
    expect(WagerTransactionRejected.from(tx, ctx).eventId).not.toBe(WagerTransactionRejected.from(tx, ctx).eventId);
  });
});
