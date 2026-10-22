import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxRecord } from '../database/entities';
import { InboxMessage } from './inbox-message';

export class InboxRepository {
  /**
   * INSERT … ON CONFLICT DO NOTHING. Se outra instância processa a mesma mensagem agora,
   * o Postgres segura este INSERT até a outra transação terminar.
   * Devolve `null` quando a mensagem é nova, ou o registro já existente.
   */
  async receive(em: EntityManager, message: InboxMessage): Promise<InboxMessage | null> {
    const inserted = await em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (inserted.length > 0) return null;
    const existing = await em.findOneOrFail(
      InboxRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { refresh: true },
    );
    return InboxMessage.rehydrate({ ...existing, processedAt: existing.processedAt ?? undefined });
  }

  async markProcessed(em: EntityManager, message: InboxMessage, at: Date): Promise<void> {
    message.markProcessed(at);
    await em.nativeUpdate(
      InboxRecord,
      { consumerName: message.consumerName, messageId: message.messageId, processedAt: null },
      { processedAt: message.processedAt },
    );
  }
}
