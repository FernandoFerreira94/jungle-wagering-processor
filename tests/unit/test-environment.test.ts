import { describe, expect, test } from 'bun:test';

const moduleUrl = new URL('../support/test-env.ts', import.meta.url).href;
function checkEnvironment(extra: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, '-e', `await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({ database: new URL(process.env.DATABASE_URL).pathname, prefix: process.env.QUEUE_PREFIX }));`], {
    env: { ...process.env, DATABASE_URL: 'postgres://example:example@localhost:5452/wagering', QUEUE_PREFIX: '', TEST_DATABASE_URL: '', ...extra },
    stdout: 'pipe', stderr: 'pipe',
  });
}

describe('test environment isolation', () => {
  test('never inherits the application database or queue prefix', () => {
    const result = checkEnvironment();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ database: '/wagering_test', prefix: 'test-' });
  });

  test('refuses an explicit test URL that points at the application database', () => {
    const result = checkEnvironment({ TEST_DATABASE_URL: 'postgres://example:example@localhost:5452/wagering' });
    expect(result.exitCode).not.toBe(0);
  });

  test('accepts an explicit isolated database and preserves its port', () => {
    const result = checkEnvironment({ TEST_DATABASE_URL: 'postgres://example:example@localhost:5452/custom_test' });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ database: '/custom_test', prefix: 'test-' });
  });
});
