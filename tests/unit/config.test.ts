import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  test('uses defaults for an empty environment', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.queues).toEqual({
      transactions: 'wager-transactions.fifo',
      dlq: 'wager-transactions-dlq.fifo',
      events: 'wager-events.fifo',
    });
    expect(config.roles).toEqual({ http: true, consumer: true, outbox: true, pendingWorker: true });
    expect(config.maxReceiveCount).toBe(5);
    expect(config.pendingReference).toEqual({ maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 60000 });
  });

  test('turns off only the role that was disabled', () => {
    const config = loadConfig({ ROLE_CONSUMER: 'false' });
    expect(config.roles).toEqual({ http: true, consumer: false, outbox: true, pendingWorker: true });
  });

  test('prefixes every queue name', () => {
    expect(loadConfig({ QUEUE_PREFIX: 'test-' }).queues.dlq).toBe('test-wager-transactions-dlq.fifo');
  });
});
