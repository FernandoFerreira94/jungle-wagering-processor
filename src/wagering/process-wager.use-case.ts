import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { AppConfig } from '../config';
import { Database } from '../database/database';
import { isLockTimeout, isUniqueViolation } from '../database/pg-errors';
import { InboxMessage } from '../messaging/inbox-message';
import { InboxRepository } from '../messaging/inbox.repository';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../messaging/integration-events';
import { OutboxRepository } from '../messaging/outbox.repository';
import { IdempotencyConflictError, InboxPayloadConflictError, NotFoundError } from '../shared/errors';
import { newId } from '../shared/ids';
import { JsonLogger } from '../shared/json-logger';
import { Metrics } from '../shared/metrics';
import type { MoneyProps } from '../shared/money';
import { APP_CONFIG } from '../tokens';
import type { Wallet } from '../wallet/wallet';
import { WalletRepository } from '../wallet/wallet.repository';
import type { WalletLedgerEntry } from '../wallet/ledger-entry';
import { FailureCode } from './failure-code';
import type { WagerCommand } from './wager-command';
import { decideWager } from './wager-rules';
import { WagerTransaction, WagerTransactionStatus } from './wager-transaction';
import { WagerTransactionRepository } from './wager-transaction.repository';

export type WagerSource = 'http' | 'sqs' | 'worker';

export interface WagerContext {
  source: WagerSource;
  correlationId: string;
  /** Presente quando a entrada é a fila: deduplicação persistente por (consumerName, messageId). */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/** Restrições de unicidade que indicam corrida com outra instância: basta reler para responder. */
const RACE_CONSTRAINTS = ['uq_wager_idempotency_key', 'uq_wager_provider_external', 'ux_wager_single_reversal'];

/**
 * Único caminho de escrita de transações de aposta (HTTP, SQS e worker de pendências).
 * Uma transação SQL: inbox → lock da wallet → idempotência → regra → transação + ledger + wallet + outbox.
 */
@Injectable()
export class ProcessWagerUseCase {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(WagerTransactionRepository) private readonly transactions: WagerTransactionRepository,
    @Inject(InboxRepository) private readonly inbox: InboxRepository,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async execute(cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    const stopTimer = this.metrics.processingDuration.startTimer({ source: ctx.source });
    try {
      const result = await this.withRaceRetry(() => this.db.transaction((em) => this.process(em, cmd, ctx)));
      this.record(result, cmd, ctx);
      return result;
    } catch (error) {
      if (isLockTimeout((error as Error).cause ?? error)) this.metrics.lockConflicts.inc({ type: 'lock_timeout' });
      throw error;
    } finally {
      stopTimer();
    }
  }

  /** Nova tentativa para uma transação em PENDING_REFERENCE. `null` se outra instância já resolveu. */
  async retryPending(transactionId: string, correlationId: string): Promise<WagerResult | null> {
    let kind = '';
    const result = await this.withRaceRetry(() =>
      this.db.transaction(async (em) => {
        const peek = await this.transactions.findById(em, transactionId);
        if (!peek || peek.status !== WagerTransactionStatus.PendingReference) return null;
        // Mesma ordem de lock do caminho principal: wallet, depois transação.
        const wallet = await this.wallets.lockById(em, peek.walletId);
        const tx = await this.transactions.lockById(em, transactionId);
        if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return null;
        kind = tx.kind;
        const now = new Date();
        const outcome = await this.decideAndApply(em, tx, wallet, { correlationId, now }, true);
        await this.transactions.update(em, tx);
        await this.persistEffects(em, wallet, outcome);
        return this.resultOf(tx, false);
      }),
    );
    if (result && result.status !== WagerTransactionStatus.PendingReference) {
      this.metrics.transactions.inc({ kind, status: result.status });
      this.logger.info('pending reference resolved', { correlationId, transactionId, status: result.status, failureCode: result.failureCode });
    }
    return result;
  }

  /** Marca como FAILED uma pendência que quebrou com erro permanente (auditável, terminal). */
  async failPending(transactionId: string, correlationId: string): Promise<void> {
    const kind = await this.db.transaction(async (em) => {
      const tx = await this.transactions.lockById(em, transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return null;
      tx.fail(FailureCode.InternalError, new Date());
      await this.transactions.update(em, tx);
      await this.outbox.add(em, WagerTransactionRejected.from(tx, { correlationId, now: new Date() }));
      return tx.kind;
    });
    if (kind) this.metrics.transactions.inc({ kind, status: WagerTransactionStatus.Failed });
  }

  private async process(em: EntityManager, cmd: WagerCommand, ctx: WagerContext): Promise<WagerResult> {
    const now = new Date();
    const inboxMessage = ctx.inbox
      ? InboxMessage.receive({ ...ctx.inbox, receivedAt: now })
      : undefined;
    if (inboxMessage) {
      const existing = await this.inbox.receive(em, inboxMessage);
      if (existing && existing.payloadHash !== inboxMessage.payloadHash) {
        throw new InboxPayloadConflictError(inboxMessage.messageId);
      }
      if (existing) this.metrics.inboxDuplicates.inc();
    }

    const wallet = await this.wallets.lockById(em, cmd.walletId);
    if (!wallet) throw new NotFoundError('Wallet', cmd.walletId);

    const previous =
      (await this.transactions.findByIdempotencyKey(em, cmd.idempotencyKey)) ??
      (await this.transactions.findByExternalId(em, cmd.providerId, cmd.externalTransactionId));
    if (previous) {
      if (previous.idempotencyKey !== cmd.idempotencyKey || !previous.matchesPayload(cmd.payloadHash)) {
        throw new IdempotencyConflictError(cmd.idempotencyKey);
      }
      if (inboxMessage) await this.inbox.markProcessed(em, inboxMessage, now);
      return this.resultOf(previous, true);
    }

    const tx = WagerTransaction.create({ id: newId(), ...cmd, createdAt: now });
    const eventCtx: EventContext = { correlationId: ctx.correlationId, causationId: ctx.inbox?.messageId, now };
    const outcome = await this.decideAndApply(em, tx, wallet, eventCtx, false);
    await this.transactions.insert(em, tx);
    await this.persistEffects(em, wallet, outcome);
    if (inboxMessage) await this.inbox.markProcessed(em, inboxMessage, now);
    return this.resultOf(tx, false);
  }

  private async decideAndApply(
    em: EntityManager,
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
    isRetry: boolean,
  ): Promise<{ entry?: WalletLedgerEntry; expectedVersion: number; events: IntegrationEvent<unknown>[] }> {
    const reference = tx.referenceExternalTransactionId
      ? ((await this.transactions.findByExternalId(em, tx.providerId, tx.referenceExternalTransactionId)) ?? undefined)
      : undefined;
    const referenceAlreadyReversed =
      reference && tx.isReversal() ? await this.transactions.hasProcessedReversal(em, reference.id) : false;
    const expectedVersion = wallet.version;
    const decision = decideWager({ tx, wallet, reference, referenceAlreadyReversed });

    switch (decision.kind) {
      case 'apply': {
        const entry = wallet.apply(decision.direction, tx.money, tx.id, ctx.now);
        tx.markProcessed(reference?.id, ctx.now, wallet.balance);
        return {
          entry,
          expectedVersion,
          events: [WagerTransactionProcessed.from(tx, ctx), WalletBalanceChanged.from(wallet, entry, ctx)],
        };
      }
      case 'no-balance-effect':
        tx.markProcessed(reference?.id, ctx.now, wallet.balance);
        return { expectedVersion, events: [WagerTransactionProcessed.from(tx, ctx)] };
      case 'reject':
        tx.reject(decision.code, ctx.now, wallet.balance);
        return { expectedVersion, events: [WagerTransactionRejected.from(tx, ctx)] };
      case 'wait-reference': {
        const { maxAttempts } = this.config.pendingReference;
        if (isRetry && tx.referenceAttempts + 1 >= maxAttempts) {
          tx.reject(FailureCode.ReferenceNotFound, ctx.now, wallet.balance);
          return { expectedVersion, events: [WagerTransactionRejected.from(tx, ctx)] };
        }
        const attempt = isRetry ? tx.referenceAttempts + 1 : 0;
        tx.markPendingReference(new Date(ctx.now.getTime() + this.referenceDelayMs(attempt)));
        if (isRetry) this.metrics.pendingReferenceRetries.inc();
        // O evento de pendência sai só na primeira vez; as novas tentativas não geram ruído.
        return { expectedVersion, events: isRetry ? [] : [WagerTransactionPendingReference.from(tx, ctx)] };
      }
    }
  }

  private async persistEffects(
    em: EntityManager,
    wallet: Wallet,
    outcome: { entry?: WalletLedgerEntry; expectedVersion: number; events: IntegrationEvent<unknown>[] },
  ): Promise<void> {
    if (outcome.entry) {
      await this.wallets.update(em, wallet, outcome.expectedVersion);
      await this.wallets.appendLedger(em, outcome.entry);
    }
    await this.outbox.add(em, ...outcome.events);
  }

  private referenceDelayMs(attempt: number): number {
    const { baseDelayMs, maxDelayMs } = this.config.pendingReference;
    return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  }

  /** Uma corrida perdida para outra instância vira replay: a segunda leitura encontra o que ela gravou. */
  private async withRaceRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!RACE_CONSTRAINTS.some((name) => isUniqueViolation(error, name))) throw error;
      this.metrics.lockConflicts.inc({ type: 'unique_race' });
      return run();
    }
  }

  private resultOf(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.resultBalance?.toJSON() ?? null,
      failureCode: tx.failureCode,
      idempotentReplay,
    };
  }

  private record(result: WagerResult, cmd: WagerCommand, ctx: WagerContext): void {
    if (result.idempotentReplay) this.metrics.idempotentReplays.inc({ source: ctx.source });
    else this.metrics.transactions.inc({ kind: cmd.kind, status: result.status });
    this.logger.info(result.idempotentReplay ? 'wager transaction replayed' : 'wager transaction handled', {
      correlationId: ctx.correlationId,
      messageId: ctx.inbox?.messageId,
      transactionId: result.transactionId,
      walletId: cmd.walletId,
      providerId: cmd.providerId,
      kind: cmd.kind,
      status: result.status,
      failureCode: result.failureCode,
      source: ctx.source,
    });
  }
}
