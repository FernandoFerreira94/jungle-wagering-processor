export interface AppConfig {
  port: number;
  databaseUrl: string;
  aws: { endpoint: string; region: string };
  queues: { transactions: string; dlq: string; events: string };
  roles: { http: boolean; consumer: boolean; outbox: boolean; pendingWorker: boolean };
  consumerName: string;
  maxReceiveCount: number;
  lockTimeoutMs: number;
  /** Base do backoff (s) ao devolver uma mensagem à fila: base · 2^(tentativa − 1), teto de 300 s. */
  sqsRetryBaseSeconds: number;
  pendingReference: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): AppConfig {
  const prefix = env.QUEUE_PREFIX ?? '';
  return {
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    aws: {
      endpoint: env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      region: env.AWS_REGION ?? 'us-east-1',
    },
    queues: {
      transactions: `${prefix}wager-transactions.fifo`,
      dlq: `${prefix}wager-transactions-dlq.fifo`,
      events: `${prefix}wager-events.fifo`,
    },
    roles: {
      http: bool(env.ROLE_HTTP, true),
      consumer: bool(env.ROLE_CONSUMER, true),
      outbox: bool(env.ROLE_OUTBOX, true),
      pendingWorker: bool(env.ROLE_PENDING_WORKER, true),
    },
    consumerName: env.CONSUMER_NAME ?? 'wager-transactions-consumer',
    maxReceiveCount: int(env.SQS_MAX_RECEIVE_COUNT, 5),
    lockTimeoutMs: int(env.LOCK_TIMEOUT_MS, 5000),
    sqsRetryBaseSeconds: int(env.SQS_RETRY_BASE_SECONDS, 2),
    pendingReference: {
      maxAttempts: int(env.PENDING_REFERENCE_MAX_ATTEMPTS, 10),
      baseDelayMs: int(env.PENDING_REFERENCE_BASE_DELAY_MS, 1000),
      maxDelayMs: int(env.PENDING_REFERENCE_MAX_DELAY_MS, 60000),
    },
  };
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid integer env value: ${value}`);
  return parsed;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}
