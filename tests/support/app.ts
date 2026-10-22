import './test-env';
import type { INestApplication } from '@nestjs/common';
import { loadConfig, type AppConfig } from '../../src/config';
import { createApp } from '../../src/main';
import { JsonLogger } from '../../src/shared/json-logger';
import { newId } from '../../src/shared/ids';

export interface TestApp {
  app: INestApplication;
  url: string;
  config: AppConfig;
  close(): Promise<void>;
}

/** App real (Postgres + LocalStack) com workers desligados: os testes os acionam manualmente. */
export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    port: 0,
    roles: { http: true, consumer: false, outbox: false, pendingWorker: false },
    ...overrides,
  };
  const sink = process.env.TEST_LOG ? (line: string) => console.error(line) : () => {};
  const app = await createApp(config, new JsonLogger(sink, 'error'));
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return { app, url: `http://127.0.0.1:${address.port}`, config, close: () => app.close() };
}

export async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

export async function createWallet(base: string, amount = '1000.00', currency = 'BRL') {
  const playerId = newId();
  const res = await api(base, 'POST', '/wallets', { playerId, initialBalance: { amount, currency } });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id as string, playerId };
}
