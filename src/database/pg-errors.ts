/** Leitura dos SQLSTATE do PostgreSQL, atravessando o wrapper de exceções do MikroORM. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: unknown; sqlState?: unknown; cause?: unknown } | null;
  if (!e || typeof e !== 'object') return undefined;
  if (typeof e.sqlState === 'string') return e.sqlState;
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  return e.cause ? sqlState(e.cause) : undefined;
}

function constraintName(error: unknown): string | undefined {
  const e = error as { constraint?: unknown; cause?: unknown } | null;
  if (!e || typeof e !== 'object') return undefined;
  if (typeof e.constraint === 'string') return e.constraint;
  return e.cause ? constraintName(e.cause) : undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (sqlState(error) !== '23505') return false;
  return constraint === undefined || constraintName(error) === constraint;
}

const TRANSIENT_STATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '53300', // too_many_connections
]);

const TRANSIENT_NETWORK = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'];

/** Falha que pode passar sozinha: tentar de novo faz sentido. */
export function isTransient(error: unknown): boolean {
  const state = sqlState(error);
  if (state && (TRANSIENT_STATES.has(state) || state.startsWith('08'))) return true;
  const text = `${(error as { code?: unknown })?.code ?? ''} ${(error as Error)?.message ?? ''}`;
  return TRANSIENT_NETWORK.some((code) => text.includes(code)) || /connection|terminat|timeout/i.test(text);
}

export function isLockTimeout(error: unknown): boolean {
  return sqlState(error) === '55P03';
}
