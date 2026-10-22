import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/messaging/inbox-message';
import { WagerTransactionProcessed } from '../../src/messaging/integration-events';
import { OutboxMessage } from '../../src/messaging/outbox-message';
import { NOW, aProcessed } from '../support/builders';

const message = () => OutboxMessage.enqueue(WagerTransactionProcessed.from(aProcessed(), { correlationId: 'c', now: NOW }));

describe('OutboxMessage', () => {
  test('is pending and due right after enqueue', () => {
    const outbox = message();
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(NOW)).toBe(true);
    expect(outbox.attempts).toBe(0);
  });

  test('backs off exponentially up to 60 seconds', () => {
    const outbox = message();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      outbox.scheduleRetry(NOW);
      delays.push((outbox.nextAttemptAt as Date).getTime() - NOW.getTime());
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(outbox.isDue(NOW)).toBe(false);
    expect(outbox.attempts).toBe(8);
  });

  test('stops being pending once published', () => {
    const outbox = message();
    outbox.markPublished(NOW);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(NOW)).toBe(false);
  });
});

describe('InboxMessage', () => {
  test('records processing once', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: NOW });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    inbox.markProcessed(new Date(NOW.getTime() + 1));
    expect(inbox.processedAt).toEqual(NOW);
  });
});
