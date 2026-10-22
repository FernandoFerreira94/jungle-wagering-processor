import { describe, expect, test } from 'bun:test';
import { JsonLogger } from '../../src/shared/json-logger';

describe('JsonLogger', () => {
  test('writes one JSON line with the correlation fields and drops financial data', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line), 'debug');
    logger.info('wager transaction handled', {
      correlationId: 'c-1',
      messageId: 'm-1',
      transactionId: 't-1',
      walletId: 'w-1',
      providerId: 'p-1',
      amount: '25.00',
      money: { amount: '25.00', currency: 'BRL' },
      balance: '975.00',
      payload: { secret: true },
      authorization: 'Bearer x',
    });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string);
    expect(entry).toMatchObject({ level: 'info', msg: 'wager transaction handled', correlationId: 'c-1', messageId: 'm-1', transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' });
    for (const key of ['amount', 'money', 'balance', 'payload', 'authorization']) expect(entry).not.toHaveProperty(key);
  });

  test('drops financial data inside nested objects and lists too', () => {
    const lines: string[] = [];
    new JsonLogger((line) => lines.push(line)).info('nested', {
      request: { walletId: 'w-1', money: { amount: '25.00', currency: 'BRL' } },
      items: [{ id: 'e-1', balanceAfter: '10.00' }],
    });
    const entry = JSON.parse(lines[0] as string);
    expect(entry.request).toEqual({ walletId: 'w-1' });
    expect(entry.items).toEqual([{ id: 'e-1' }]);
  });

  test('serializes errors without stack traces or payloads', () => {
    const lines: string[] = [];
    new JsonLogger((line) => lines.push(line)).error('failed', { error: new Error('boom') });
    expect(JSON.parse(lines[0] as string).error).toEqual({ name: 'Error', message: 'boom' });
  });

  test('respects the minimum level', () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line), 'warn');
    logger.info('hidden');
    logger.warn('shown');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['shown']);
  });
});
