import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('always serializes with two decimal places', () => {
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(brl('25').toString()).toBe('25.00 BRL');
    expect(brl('0.07').toJSON().amount).toBe('0.07');
  });

  test('adds and subtracts exactly, without floating point drift', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    expect(brl('999999999999999.99').add(brl('0.01')).toJSON().amount).toBe('1000000000000000.00');
  });

  test('is immutable', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
  });

  test('negates and compares', () => {
    const negative = brl('10.00').negate();
    expect(negative.isNegative()).toBe(true);
    expect(negative.toJSON().amount).toBe('-10.00');
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(Money.zero('USD').equals(Money.from({ amount: '0.00', currency: 'USD' }))).toBe(true);
  });

  test.each(['NaN', 'Infinity', '-Infinity', '1e3', '', ' 25.00', '25.00 ', '25.001', '-1.00', '1,00', '+1.00', '.50', '1.'])(
    'rejects invalid amount %p without rounding',
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  test.each(['brl', 'BR', 'BRLL', ''])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts coming from contracts', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('refuses operations between different currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('round-trips through minor units', () => {
    expect(Money.fromMinor(12345n, 'BRL').toJSON().amount).toBe('123.45');
    expect(brl('123.45').minor).toBe(12345n);
  });
});
