import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRecord } from '../database/entities';
import type { IntegrationEvent } from './integration-events';
import { OutboxMessage } from './outbox-message';

export class OutboxRepository {
  /** Grava o evento na transação corrente; só será publicado depois do commit. */
  async add(em: EntityManager, ...events: IntegrationEvent<unknown>[]): Promise<void> {
    for (const event of events) {
      await em.insert(OutboxRecord, toRecord(OutboxMessage.enqueue(event)));
    }
  }

  /** Lote de eventos vencidos, travados para esta instância (as outras pulam). */
  async claimDue(em: EntityManager, now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await em.execute<OutboxRow[]>(
      `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
         FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= ?
        ORDER BY occurred_at
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(fromRow);
  }

  async save(em: EntityManager, message: OutboxMessage): Promise<void> {
    await em.nativeUpdate(
      OutboxRecord,
      { id: message.id },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt, publishedAt: message.publishedAt ?? null },
    );
  }

  async stats(em: EntityManager): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const [row] = await em.execute<{ pending: string; oldest: Date | null }[]>(
      `SELECT count(*) AS pending, min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
    );
    const oldest = row?.oldest ? new Date(row.oldest).getTime() : Date.now();
    return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: Math.max(0, (Date.now() - oldest) / 1000) };
  }
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

function toRecord(message: OutboxMessage): OutboxRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload as Record<string, unknown>,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
    publishedAt: message.publishedAt ?? null,
  };
}

function fromRow(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    publishedAt: row.published_at ? new Date(row.published_at) : undefined,
  });
}
