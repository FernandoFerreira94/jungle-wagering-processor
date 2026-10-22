import type { LoggerService } from '@nestjs/common';

type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/** Chaves que nunca vão para o log: valores financeiros, payloads e credenciais. */
const REDACTED_KEYS = new Set(['money', 'amount', 'balance', 'balanceBefore', 'balanceAfter', 'payload', 'body', 'data', 'authorization', 'password', 'token']);

/** Uma linha JSON por evento, pronta para qualquer agregador de logs. */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info',
  ) {}

  info(msg: string, fields: LogFields = {}): void {
    this.emit('info', msg, fields);
  }

  warn(msg: string, fields: LogFields = {}): void {
    this.emit('warn', msg, fields);
  }

  error(msg: string, fields: LogFields = {}): void {
    this.emit('error', msg, fields);
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.emit('debug', msg, fields);
  }

  // ---- LoggerService (logs internos do NestJS)
  log(message: unknown, context?: string): void {
    this.emit('info', String(message), { context });
  }
  verbose(message: unknown, context?: string): void {
    this.emit('debug', String(message), { context });
  }

  private emit(level: Level, msg: string, fields: LogFields | string | undefined): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const extra = typeof fields === 'object' && fields !== null ? sanitize(fields) : { context: fields };
    this.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
  }
}

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function sanitize(fields: LogFields): LogFields {
  const clean: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || REDACTED_KEYS.has(key)) continue;
    clean[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  return clean;
}
