import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher.worker';
import { createTestApp, createWallet, submitWager, type TestApp } from '../support/app';
import { resetDatabase } from '../support/db';

let t: TestApp;

beforeAll(async () => {
  await resetDatabase();
  t = await createTestApp();
});
afterAll(() => t?.close());

describe('GET /metrics', () => {
  test('exposes transaction, replay, latency and outbox metrics', async () => {
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'metrics-1' });
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: 'metrics-1' });
    await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '1000.00' });
    await t.app.get(OutboxPublisher).runOnce(new Date(Date.now() + 60_000));

    const text = await fetch(`${t.url}/metrics`).then((r) => r.text());
    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 1');
    expect(text).toContain('wager_transactions_total{kind="BET",status="REJECTED"} 1');
    expect(text).toContain('idempotent_replays_total{source="http"} 1');
    expect(text).toMatch(/wager_processing_duration_seconds_count\{source="http"\} 3/);
    expect(text).toContain('outbox_pending_messages 0');
    expect(text).toContain('outbox_lag_seconds 0');
    expect(text).toMatch(/outbox_published_total [1-9]/);
    for (const name of ['inbox_duplicates_total', 'sqs_retries_total', 'sqs_dlq_messages_total', 'lock_conflicts_total']) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });
});
