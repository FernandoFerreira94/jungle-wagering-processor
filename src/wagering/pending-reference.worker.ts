import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '../config';
import { Database } from '../database/database';
import { isTransient } from '../database/pg-errors';
import { TransientFailureError } from '../shared/errors';
import { JsonLogger } from '../shared/json-logger';
import { PollingLoop } from '../shared/polling-loop';
import { APP_CONFIG } from '../tokens';
import { ProcessWagerUseCase } from './process-wager.use-case';
import { WagerTransactionRepository } from './wager-transaction.repository';

const BATCH_SIZE = 50;
const INTERVAL_MS = 500;

/**
 * Reprocessa transações em PENDING_REFERENCE (referência chegou fora de ordem) com backoff exponencial.
 * Seguro em N instâncias: cada item trava wallet e transação; quem chegar depois encontra o item resolvido.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WagerTransactionRepository) private readonly transactions: WagerTransactionRepository,
    @Inject(ProcessWagerUseCase) private readonly processWager: ProcessWagerUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {
    this.loop = new PollingLoop('pending-reference-worker', INTERVAL_MS, () => this.runOnce(), logger);
  }

  onApplicationBootstrap(): void {
    if (this.config.roles.pendingWorker) this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** Processa um lote de pendências vencidas. Devolve quantas mudaram de estado ou foram reagendadas. */
  async runOnce(now = new Date()): Promise<number> {
    const due = await this.db.read((em) => this.transactions.findDuePendingReferences(em, now, BATCH_SIZE));
    let handled = 0;
    for (const { id } of due) {
      const correlationId = `pending-reference:${id}`;
      try {
        if (await this.processWager.retryPending(id, correlationId)) handled += 1;
      } catch (error) {
        if (error instanceof TransientFailureError || isTransient(error)) {
          this.logger.warn('pending reference retry postponed', { correlationId, transactionId: id, error });
          continue;
        }
        this.logger.error('pending reference failed permanently', { correlationId, transactionId: id, error });
        await this.processWager.failPending(id, correlationId);
        handled += 1;
      }
    }
    return handled;
  }
}
