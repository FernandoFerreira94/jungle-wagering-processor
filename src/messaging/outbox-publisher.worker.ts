import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '../config';
import { Database } from '../database/database';
import { JsonLogger } from '../shared/json-logger';
import { Metrics } from '../shared/metrics';
import { PollingLoop } from '../shared/polling-loop';
import { APP_CONFIG } from '../tokens';
import { OutboxRepository } from './outbox.repository';
import { SqsGateway } from './sqs';

const BATCH_SIZE = 50;
const INTERVAL_MS = 200;

/**
 * Publica eventos da outbox depois do commit. Vários publishers podem rodar juntos:
 * `FOR UPDATE SKIP LOCKED` dá a cada um um lote diferente. Se o processo morrer depois de
 * enviar e antes de marcar como publicado, o lote volta a ficar disponível e é reenviado
 * com o mesmo eventId (o consumidor deduplica; a fila FIFO também deduplica por 5 min).
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {
    this.loop = new PollingLoop('outbox-publisher', INTERVAL_MS, () => this.runOnce(), logger);
  }

  onApplicationBootstrap(): void {
    if (this.config.roles.outbox) this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** Publica um lote. Devolve quantos eventos foram publicados. */
  async runOnce(now = new Date()): Promise<number> {
    const published = await this.db.transaction(async (em) => {
      const batch = await this.outbox.claimDue(em, now, BATCH_SIZE);
      let count = 0;
      for (const message of batch) {
        try {
          await this.sqs.send(this.config.queues.events, JSON.stringify(message.payload), {
            groupId: message.aggregateId,
            deduplicationId: message.id,
          });
          message.markPublished(new Date());
          count += 1;
        } catch (error) {
          message.scheduleRetry(new Date());
          this.metrics.outboxFailures.inc();
          this.logger.warn('outbox publish failed', { eventId: message.id, eventType: message.eventType, attempts: message.attempts, error });
        }
        await this.outbox.save(em, message);
      }
      return count;
    });
    this.metrics.outboxPublished.inc(published);
    await this.refreshGauges();
    return published;
  }

  private async refreshGauges(): Promise<void> {
    const stats = await this.db.read((em) => this.outbox.stats(em));
    this.metrics.outboxPending.set(stats.pending);
    this.metrics.outboxLag.set(stats.pending === 0 ? 0 : stats.oldestAgeSeconds);
  }
}
