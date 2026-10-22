import type { Message } from '@aws-sdk/client-sqs';
import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '../config';
import { isTransient } from '../database/pg-errors';
import { canonicalJson, sha256Hex } from '../shared/canonical-json';
import {
  DomainError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  NotFoundError,
  TransientFailureError,
  ValidationError,
} from '../shared/errors';
import { JsonLogger } from '../shared/json-logger';
import { Metrics } from '../shared/metrics';
import { APP_CONFIG } from '../tokens';
import { parseWagerCommand, type WagerCommand } from '../wagering/wager-command';
import { ProcessWagerUseCase } from '../wagering/process-wager.use-case';
import { SqsGateway } from './sqs';

const MESSAGE_TYPE = 'WagerTransactionRequested';
const WAIT_SECONDS = 5;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const MAX_VISIBILITY_SECONDS = 300;

interface Envelope {
  messageId: string;
  command: WagerCommand;
  /** Hash do conteúdo da mensagem, guardado na inbox para detectar messageId reaproveitado. */
  contentHash: string;
}

type Outcome = 'ack' | 'retry' | 'dlq';

/**
 * Consumidor de `wager-transactions.fifo`. Reaproveita o mesmo use case do HTTP.
 * ack só depois do commit · negócio → ack · transitório → volta com backoff (a redrive policy
 * leva à DLQ após maxReceiveCount) · permanente → DLQ na hora.
 */
@Injectable()
export class WagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private stopping = false;
  private loopDone?: Promise<void>;

  constructor(
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(ProcessWagerUseCase) private readonly processWager: ProcessWagerUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.roles.consumer) this.start();
  }

  /** SIGTERM: para de receber, termina o que está em andamento e devolve o resto à fila. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    this.stopping = false;
    this.loopDone ??= this.loop().finally(() => (this.loopDone = undefined));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.loopDone) return;
    await Promise.race([this.loopDone, Bun.sleep(SHUTDOWN_TIMEOUT_MS)]);
  }

  /** Recebe um lote e processa. Mensagens do mesmo grupo (wallet) seguem em ordem; grupos diferentes em paralelo. */
  async pollOnce(waitSeconds = 0): Promise<number> {
    const messages = await this.sqs.receive(
      this.config.queues.transactions,
      10,
      waitSeconds,
      this.config.sqsVisibilitySeconds,
    );
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (batch) => {
        for (const message of batch) {
          if (this.stopping) await this.release(message);
          else await this.handle(message);
        }
      }),
    );
    return messages.length;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce(WAIT_SECONDS);
      } catch (error) {
        this.logger.error('sqs poll failed', { error });
        await Bun.sleep(1000);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const sqsMessageId = message.MessageId ?? 'unknown';
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(message.Body);
    } catch (error) {
      return this.toDlq(message, 'invalid_message', { sqsMessageId, error });
    }

    const { messageId, command } = envelope;
    const log = { correlationId: messageId, messageId, walletId: command.walletId, providerId: command.providerId };
    let outcome: Outcome;
    try {
      await this.processWager.execute(command, {
        source: 'sqs',
        correlationId: messageId,
        inbox: { consumerName: this.config.consumerName, messageId, payloadHash: envelope.contentHash },
      });
      if (process.env.FAULT_CRASH_AFTER_COMMIT === 'true') {
        // Injeção de falha para os testes de crash: morre depois do commit e antes do ack.
        process.exit(137);
      }
      outcome = 'ack';
    } catch (error) {
      outcome = classify(error);
      if (outcome === 'ack') this.logger.warn('message rejected by business rule', { ...log, error });
      if (outcome === 'dlq') return this.toDlq(message, reasonOf(error), { ...log, error });
      if (outcome === 'retry') return this.retry(message, { ...log, error });
    }
    await this.sqs.delete(this.config.queues.transactions, message.ReceiptHandle as string);
  }

  private async retry(message: Message, log: Record<string, unknown>): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const delay = Math.min(this.config.sqsRetryBaseSeconds * 2 ** (receiveCount - 1), MAX_VISIBILITY_SECONDS);
    this.metrics.sqsRetries.inc();
    this.logger.warn('message returned to queue', { ...log, receiveCount, retryInSeconds: delay });
    await this.sqs.changeVisibility(this.config.queues.transactions, message.ReceiptHandle as string, delay).catch(() => {});
  }

  private async toDlq(message: Message, reason: string, log: Record<string, unknown>): Promise<void> {
    this.metrics.dlqMessages.inc({ reason });
    this.logger.error('message sent to DLQ', { ...log, reason });
    await this.sqs.send(this.config.queues.dlq, message.Body ?? '', {
      groupId: message.Attributes?.MessageGroupId ?? 'invalid',
      deduplicationId: message.MessageId ?? `${Date.now()}`,
    });
    await this.sqs.delete(this.config.queues.transactions, message.ReceiptHandle as string);
  }

  private async release(message: Message): Promise<void> {
    await this.sqs.changeVisibility(this.config.queues.transactions, message.ReceiptHandle as string, 0).catch(() => {});
  }
}

function parseEnvelope(body: string | undefined): Envelope {
  const parsed = JSON.parse(body ?? '') as { messageId?: unknown; type?: unknown; data?: Record<string, unknown> };
  if (parsed?.type !== MESSAGE_TYPE) throw new ValidationError([`type must be ${MESSAGE_TYPE}`]);
  if (typeof parsed.messageId !== 'string' || parsed.messageId === '' || parsed.messageId.length > 255) {
    throw new ValidationError(['messageId is required']);
  }
  const command = parseWagerCommand(parsed.data, parsed.data?.idempotencyKey);
  return { messageId: parsed.messageId, command, contentHash: sha256Hex(canonicalJson(parsed.data)) };
}

function classify(error: unknown): Outcome {
  if (
    error instanceof NotFoundError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InboxPayloadConflictError ||
    error instanceof ValidationError ||
    error instanceof DomainError
  ) {
    return 'dlq';
  }
  if (error instanceof TransientFailureError || isTransient(error)) return 'retry';
  // Erro inesperado: tenta de novo; se persistir, a redrive policy leva à DLQ após maxReceiveCount.
  return 'retry';
}

function reasonOf(error: unknown): string {
  if (error instanceof IdempotencyConflictError) return 'idempotency_conflict';
  if (error instanceof InboxPayloadConflictError) return 'message_id_conflict';
  // Wallet inexistente: não há onde aplicar nem registrar a operação; fica na DLQ para análise.
  if (error instanceof NotFoundError) return 'wallet_not_found';
  return 'invalid_message';
}
