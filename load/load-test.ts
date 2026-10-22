import '../tests/support/test-env';
import { newId } from '../src/shared/ids';
import { createWallet, submitWager } from '../tests/support/app';
import { resetDatabase, sql, testOrm } from '../tests/support/db';
import { eventually, startInstances, stopAll } from '../tests/support/instances';
import { drainAll, testSqs } from '../tests/support/sqs';

/*
 * Teste de carga: 3 instâncias reais, carga HTTP em loop fechado por um tempo fixo.
 * Mistura: wallets "frias" + uma wallet "quente" disputada + reenvios duplicados.
 * Ao final confere o invariante saldo == ledger e espera a outbox esvaziar.
 */

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const DURATION_S = env('LOAD_DURATION_S', 30);
const CONCURRENCY = env('LOAD_CONCURRENCY', 48);
const WALLETS = env('LOAD_WALLETS', 100);
const HOT_SHARE = env('LOAD_HOT_SHARE', 0.2);
const DUP_SHARE = env('LOAD_DUP_SHARE', 0.1);
const INSTANCES = env('LOAD_INSTANCES', 3);

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

async function scrape(urls: string[], metric: string): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const url of urls) {
    const text = await (await fetch(`${url}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (!line.startsWith(metric)) continue;
      const [series, value] = line.split(' ');
      totals[series!] = (totals[series!] ?? 0) + Number(value);
    }
  }
  return totals;
}

async function main() {
  await resetDatabase();
  const sqs = testSqs();
  await drainAll(sqs);
  const orm = await testOrm();
  const instances = await startInstances(INSTANCES);
  const urls = instances.map((i) => i.url);
  const pick = () => urls[Math.floor(Math.random() * urls.length)]!;

  const cold = await Promise.all(Array.from({ length: WALLETS }, (_, i) => createWallet(urls[i % urls.length]!, '100000.00')));
  const hot = await createWallet(urls[0]!, '100000.00');
  const walletIds = [hot.walletId, ...cold.map((w) => w.walletId)];

  const latencies: number[] = [];
  const statuses: Record<number, number> = {};
  const sent: { walletId: string; playerId: string; externalTransactionId: string; kind: string; amount: string }[] = [];
  let networkErrors = 0;
  let maxLag = 0;

  const lagSampler = setInterval(async () => {
    const [row] = await sql<{ lag: string | null }>(
      orm,
      `SELECT EXTRACT(EPOCH FROM now() - min(occurred_at))::float8 AS lag FROM outbox_messages WHERE published_at IS NULL`,
    );
    maxLag = Math.max(maxLag, Number(row?.lag ?? 0));
  }, 500);

  const deadline = Date.now() + DURATION_S * 1000;
  const worker = async () => {
    while (Date.now() < deadline) {
      const duplicate = sent.length > 0 && Math.random() < DUP_SHARE;
      const input = duplicate
        ? sent[Math.floor(Math.random() * sent.length)]!
        : (() => {
            const target = Math.random() < HOT_SHARE ? hot : cold[Math.floor(Math.random() * cold.length)]!;
            const kind = Math.random() < 0.7 ? 'BET' : 'WIN';
            return { ...target, externalTransactionId: `load-${newId()}`, kind, amount: kind === 'BET' ? '1.00' : '0.50' };
          })();
      const started = performance.now();
      try {
        const res = await submitWager(pick(), input);
        latencies.push(performance.now() - started);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (!duplicate && res.status === 200) sent.push(input);
      } catch {
        networkErrors++;
      }
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedS = (performance.now() - t0) / 1000;

  const drainStart = Date.now();
  await eventually(
    async () => Number((await sql<{ c: string }>(orm, `SELECT count(*) c FROM outbox_messages WHERE published_at IS NULL`))[0]?.c) === 0,
    120_000,
    'outbox to drain',
  );
  const drainS = (Date.now() - drainStart) / 1000;
  clearInterval(lagSampler);

  const mismatches = await sql<{ id: string }>(
    orm,
    `SELECT w.id FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ANY(?::uuid[])
      GROUP BY w.id, w.balance
     HAVING w.balance <> COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'CREDIT'), 0)
                       - COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'DEBIT'), 0)`,
    [`{${walletIds.join(',')}}`],
  );
  const lockConflicts = await scrape(urls, 'lock_conflicts_total{');
  const replays = await scrape(urls, 'idempotent_replays_total{');

  await stopAll(instances);
  await orm.close();
  sqs.destroy();

  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.length + networkErrors;
  const errors = networkErrors + Object.entries(statuses).filter(([s]) => Number(s) >= 500).reduce((n, [, c]) => n + c, 0);
  const report = {
    config: { DURATION_S, CONCURRENCY, WALLETS, HOT_SHARE, DUP_SHARE, INSTANCES },
    requests: total,
    throughputRps: Number((total / elapsedS).toFixed(1)),
    latencyMs: {
      p50: Number(percentile(sorted, 50).toFixed(1)),
      p95: Number(percentile(sorted, 95).toFixed(1)),
      p99: Number(percentile(sorted, 99).toFixed(1)),
      max: Number((sorted.at(-1) ?? 0).toFixed(1)),
    },
    statuses,
    errorRate: Number((errors / Math.max(total, 1)).toFixed(4)),
    lockConflicts,
    idempotentReplays: replays,
    outbox: { maxLagSeconds: Number(maxLag.toFixed(2)), drainAfterLoadSeconds: Number(drainS.toFixed(2)) },
    invariant: mismatches.length === 0 ? 'OK' : `FAILED (${mismatches.length} wallets)`,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(mismatches.length === 0 ? 0 : 1);
}

await main();
