// Ambiente isolado dos testes: banco e filas próprios, nunca os da aplicação.
const databaseUrl = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://wagering:wagering@localhost:5432/wagering');
if (!process.env.TEST_DATABASE_URL && !databaseUrl.pathname.endsWith('_test')) databaseUrl.pathname += '_test';
process.env.DATABASE_URL = databaseUrl.toString();
process.env.QUEUE_PREFIX = 'test-';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

/** Antes de conectar ou limpar recursos, recusa configurações da aplicação. */
export function assertTestEnvironment(): void {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test') || process.env.QUEUE_PREFIX !== 'test-') {
    throw new Error('Tests require a database ending in _test and the test- queue prefix');
  }
}
assertTestEnvironment();
