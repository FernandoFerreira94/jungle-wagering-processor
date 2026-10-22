import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Métricas da aplicação num registro próprio (uma instância por processo/app). */
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações por tipo e status final',
    labelNames: ['kind', 'status'] as const,
    registers: [this.registry],
  });
  readonly idempotentReplays = new Counter({
    name: 'idempotent_replays_total',
    help: 'Requisições repetidas respondidas com o resultado original',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  readonly inboxDuplicates = new Counter({
    name: 'inbox_duplicates_total',
    help: 'Mensagens SQS já registradas na inbox',
    registers: [this.registry],
  });
  readonly sqsRetries = new Counter({
    name: 'sqs_retries_total',
    help: 'Mensagens devolvidas à fila por falha transitória',
    registers: [this.registry],
  });
  readonly dlqMessages = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Lock timeouts, deadlocks e corridas de unicidade resolvidas por releitura',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });
  readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Eventos ainda não publicados',
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo',
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados',
    registers: [this.registry],
  });
  readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Falhas de publicação (serão tentadas de novo)',
    registers: [this.registry],
  });
  readonly processingDuration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do processamento de uma transação',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly pendingReferenceRetries = new Counter({
    name: 'pending_reference_retries_total',
    help: 'Novas tentativas de resolver referências fora de ordem',
    registers: [this.registry],
  });
  readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Reconciliações em que saldo e ledger divergiram',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
