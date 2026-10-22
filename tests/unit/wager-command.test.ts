import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../src/shared/errors';
import { parseWagerCommand } from '../../src/wagering/wager-command';

const body = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('parseWagerCommand', () => {
  test('parses the contract from the challenge', () => {
    const cmd = parseWagerCommand(body, 'provider-a:transaction-123');
    expect(cmd.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(cmd.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the hash ignores key order, transport metadata and the idempotency key', () => {
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(parseWagerCommand(reordered, 'k1').payloadHash).toBe(parseWagerCommand(body, 'k2').payloadHash);
    expect(parseWagerCommand({ ...body, money: { amount: '25', currency: 'BRL' } }, 'k').payloadHash).toBe(
      parseWagerCommand(body, 'k').payloadHash,
    );
  });

  test('any business field change changes the hash', () => {
    const base = parseWagerCommand(body, 'k').payloadHash;
    expect(parseWagerCommand({ ...body, money: { amount: '25.01', currency: 'BRL' } }, 'k').payloadHash).not.toBe(base);
    expect(parseWagerCommand({ ...body, roundId: 'round-988' }, 'k').payloadHash).not.toBe(base);
  });

  test.each([
    ['missing idempotency key', body, undefined],
    ['OPENING kind', { ...body, kind: 'OPENING' }, 'k'],
    ['zero BET', { ...body, money: { amount: '0.00', currency: 'BRL' } }, 'k'],
    ['scientific notation', { ...body, money: { amount: '1e3', currency: 'BRL' } }, 'k'],
    ['padded amount', { ...body, money: { amount: ' 25.00', currency: 'BRL' } }, 'k'],
    ['REFUND without reference', { ...body, kind: 'REFUND' }, 'k'],
    ['bad wallet id', { ...body, walletId: 'w-1' }, 'k'],
    ['padded provider', { ...body, providerId: ' provider-a' }, 'k'],
    ['array body', [], 'k'],
  ])('rejects %s', (_label, payload, key) => {
    expect(() => parseWagerCommand(payload, key)).toThrow(ValidationError);
  });

  test('LOSS may carry a zero amount', () => {
    expect(parseWagerCommand({ ...body, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }, 'k').kind).toBe(
      'LOSS' as never,
    );
  });
});
