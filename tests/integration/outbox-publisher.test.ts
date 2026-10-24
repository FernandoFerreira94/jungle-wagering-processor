import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher.worker';
import { OutboxRepository } from '../../src/messaging/outbox.repository';
import type { SqsGateway } from '../../src/messaging/sqs';
import { createTestApp, createWallet, submitWager, type TestApp } from '../support/app';
import { resetDatabase, sql, testOrm } from '../support/db';
import { drainAll, drainQueue, queues, testSqs } from '../support/sqs';

let t: TestApp;
let orm: MikroORM;
let sqs: SqsGateway;

beforeAll(async () => {
  await resetDatabase();
  t = await createTestApp();
  orm = await testOrm();
  sqs = testSqs();
  await drainAll(sqs);
});
afterAll(async () => {
  await t?.close();
  await orm?.close();
  sqs?.destroy();
});

const pending = async () =>
  Number((await sql<{ c: string }>(orm, `SELECT count(*) c FROM outbox_messages WHERE published_at IS NULL`))[0]?.c);
const allEventIds = async () => (await sql<{ id: string }>(orm, `SELECT id FROM outbox_messages`)).map((r) => r.id);

async function publishEverything(publisher: OutboxPublisher): Promise<void> {
  const future = new Date(Date.now() + 3_600_000);
  while ((await publisher.runOnce(future)) > 0);
}

describe('outbox publisher', () => {
  beforeEach(async () => {
    await publishEverything(t.app.get(OutboxPublisher));
    await drainQueue(sqs, queues.events, { quietMs: 300 });
  });

  test('events committed by one instance are published by another (crash before publish)', async () => {
    // A app `t` tem o publisher desligado: commit feito, ninguém publicou ainda.
    const { walletId, playerId } = await createWallet(t.url, '100.00');
    const bet = await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '10.00' });
    expect(await pending()).toBeGreaterThan(0);

    const other = await createTestApp();
    try {
      await publishEverything(other.app.get(OutboxPublisher));
    } finally {
      await other.close();
    }
    expect(await pending()).toBe(0);
    const received = await drainQueue(sqs, queues.events);
    const types = received.filter((e) => e.aggregateId === bet.body.transactionId).map((e) => e.eventType);
    expect(types).toEqual(['WagerTransactionProcessed']);
    const balance = received.find((e) => e.eventType === 'WalletBalanceChanged' && e.data.transactionId === bet.body.transactionId);
    expect(balance.data).toMatchObject({ balanceBefore: { amount: '100.00' }, balanceAfter: { amount: '90.00' }, walletVersion: 2 });
  });

  test('two publishers on the same outbox publish everything, each event at least once', async () => {
    for (let i = 0; i < 10; i++) {
      const { walletId, playerId } = await createWallet(t.url, '50.00');
      await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '1.00' });
    }
    const expected = new Set(await sql<{ id: string }>(orm, `SELECT id FROM outbox_messages WHERE published_at IS NULL`).then((r) => r.map((x) => x.id)));
    expect(expected.size).toBeGreaterThanOrEqual(30);

    const other = await createTestApp();
    try {
      const a = t.app.get(OutboxPublisher);
      const b = other.app.get(OutboxPublisher);
      await Promise.all([publishEverything(a), publishEverything(b), publishEverything(a)]);
    } finally {
      await other.close();
    }
    expect(await pending()).toBe(0);
    const received = new Set((await drainQueue(sqs, queues.events)).map((e) => e.eventId));
    for (const id of expected) expect(received.has(id)).toBe(true);
  });

  test('a publisher that dies after sending and before committing is safe: the event is sent again with the same id', async () => {
    const { walletId, playerId } = await createWallet(t.url, '10.00');
    const repo = t.app.get(OutboxRepository);
    const original = repo.save.bind(repo);
    repo.save = async () => {
      throw new Error('process died before commit');
    };
    const publisher = t.app.get(OutboxPublisher);
    try {
      await expect(publisher.runOnce(new Date(Date.now() + 3_600_000))).rejects.toThrow('process died');
    } finally {
      repo.save = original;
    }
    expect(await pending()).toBeGreaterThan(0);
    await publishEverything(publisher);
    expect(await pending()).toBe(0);
    const ids = (await drainQueue(sqs, queues.events)).map((e) => e.eventId);
    const walletEvents = await sql<{ id: string }>(orm, `SELECT id FROM outbox_messages WHERE aggregate_id = ?`, [walletId]);
    for (const { id } of walletEvents) expect(ids).toContain(id);
  });

  test('when SQS is down the event stays pending with exponential backoff', async () => {
    const broken = await createTestApp({ aws: { endpoint: 'http://127.0.0.1:9', region: 'us-east-1' } });
    try {
      const { walletId, playerId } = await createWallet(t.url, '10.00');
      await submitWager(t.url, { walletId, playerId, kind: 'BET', amount: '1.00' });
      const before = await pending();
      expect(await broken.app.get(OutboxPublisher).runOnce(new Date(Date.now() + 3_600_000))).toBe(0);
      const rows = await sql<{ attempts: number; next_attempt_at: Date }>(
        orm,
        `SELECT attempts, next_attempt_at FROM outbox_messages WHERE published_at IS NULL`,
      );
      expect(rows.length).toBe(before);
      for (const row of rows) {
        expect(row.attempts).toBe(1);
        expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
      }
    } finally {
      await broken.close();
    }
    expect(await allEventIds()).not.toHaveLength(0);
  });
});
