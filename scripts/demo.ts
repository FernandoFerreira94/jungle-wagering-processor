/*
 * Demonstração guiada do sistema, contra as 3 instâncias do Docker Compose.
 * Roda dentro do container (não precisa instalar nada na máquina):
 *   docker compose exec app-1 bun scripts/demo.ts
 */
import { SQSClient, GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';

const INSTANCES = (process.env.DEMO_INSTANCES ?? 'http://app-1:3000,http://app-2:3000,http://app-3:3000').split(',');
const [A, B, C] = [INSTANCES[0]!, INSTANCES[1] ?? INSTANCES[0]!, INSTANCES[2] ?? INSTANCES[0]!];
const run = Date.now().toString(36);

let step = 0;
const title = (text: string) => console.log(`\n\x1b[1m${++step}. ${text}\x1b[0m`);
const say = (text: string) => console.log(`   ${text}`);
const ok = (cond: boolean, text: string) => {
  console.log(`   ${cond ? '\x1b[32m✔' : '\x1b[31m✘'} ${text}\x1b[0m`);
  if (!cond) process.exitCode = 1;
};
const name = (url: string) => (url === A ? 'cópia 1' : url === B ? 'cópia 2' : 'cópia 3');

async function call(base: string, method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function main() {
  const playerId = crypto.randomUUID();

  title('Criando a carteira de um jogador com R$ 100,00');
  const wallet = await call(A, 'POST', '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  const walletId = wallet.body.id as string;
  ok(wallet.status === 201, `carteira criada na ${name(A)}, saldo ${wallet.body.balance.amount}`);

  const tx = (externalTransactionId: string, kind: string, amount: string, reference?: string) => ({
    providerId: 'provider-demo',
    externalTransactionId: `${run}-${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: `${run}-${reference}` } : {}),
  });
  const send = (base: string, body: ReturnType<typeof tx>) =>
    call(base, 'POST', '/wagering/transactions', body, `${body.providerId}:${body.externalTransactionId}`);

  title('Aposta (BET) de R$ 25,00');
  const bet = await send(A, tx('bet-1', 'BET', '25.00'));
  ok(bet.status === 200 && bet.body.balance.amount === '75.00', `${bet.body.status}, saldo agora ${bet.body.balance.amount}`);

  title('O provedor manda a MESMA aposta de novo (falha de rede, retry), para outra cópia');
  const replay = await send(B, tx('bet-1', 'BET', '25.00'));
  ok(replay.body.idempotentReplay === true, `a ${name(B)} reconheceu a repetição (idempotentReplay = true)`);
  ok(replay.body.balance.amount === '75.00', `saldo continua ${replay.body.balance.amount}: não cobrou duas vezes`);

  title('Duas apostas de R$ 60,00 AO MESMO TEMPO, em cópias diferentes (só há R$ 75,00)');
  const [x, y] = await Promise.all([send(B, tx('bet-2', 'BET', '60.00')), send(C, tx('bet-3', 'BET', '60.00'))]);
  for (const [r, base] of [[x, B], [y, C]] as const) say(`${name(base)}: HTTP ${r.status} ${r.body.status} ${r.body.failureCode ?? ''}`);
  ok([x, y].filter((r) => r.body.status === 'PROCESSED').length === 1, 'exatamente uma passou');
  ok([x, y].some((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS'), 'a outra foi recusada por saldo insuficiente');
  const afterRace = (await call(A, 'GET', `/wallets/${walletId}`)).body.balance.amount;
  ok(afterRace === '15.00', `saldo ${afterRace}: nunca ficou negativo`);

  title('Vitória (WIN) de R$ 40,00');
  const win = await send(C, tx('win-1', 'WIN', '40.00'));
  ok(win.body.balance.amount === '55.00', `crédito aplicado, saldo ${win.body.balance.amount}`);

  title('Cancelamento (ROLLBACK) chegando ANTES da aposta que ele cancela');
  const early = await send(A, tx('rollback-1', 'ROLLBACK', '10.00', 'bet-late'));
  ok(early.status === 202 && early.body.status === 'PENDING_REFERENCE', 'ficou esperando a aposta original (HTTP 202)');
  const late = await send(B, tx('bet-late', 'BET', '10.00'));
  say(`a aposta original chegou: saldo ${late.body.balance.amount}`);
  say('aguardando o worker resolver o cancelamento pendente...');
  let resolved = '';
  for (let i = 0; i < 30 && resolved !== 'PROCESSED'; i++) {
    await Bun.sleep(500);
    resolved = (await call(C, 'GET', `/providers/provider-demo/wagering/transactions/${run}-rollback-1`)).body.status;
  }
  const afterRollback = (await call(A, 'GET', `/wallets/${walletId}`)).body.balance.amount;
  ok(resolved === 'PROCESSED' && afterRollback === '55.00', `cancelamento aplicado sozinho, saldo voltou para ${afterRollback}`);

  title('Aposta de R$ 5,00 pela FILA (SQS), entregue duas vezes');
  const sqs = new SQSClient({ endpoint: process.env.AWS_ENDPOINT_URL, region: process.env.AWS_REGION ?? 'us-east-1' });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
  const data = tx('bet-queue', 'BET', '5.00');
  const message = JSON.stringify({
    messageId: `${run}-msg-1`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
  });
  for (let i = 0; i < 2; i++) {
    await sqs.send(
      new SendMessageCommand({ QueueUrl, MessageBody: message, MessageGroupId: walletId, MessageDeduplicationId: crypto.randomUUID() }),
    );
  }
  let viaQueue: { status?: string } = {};
  for (let i = 0; i < 30 && viaQueue.status !== 'PROCESSED'; i++) {
    await Bun.sleep(500);
    viaQueue = (await call(A, 'GET', `/providers/provider-demo/wagering/transactions/${data.externalTransactionId}`)).body ?? {};
  }
  await Bun.sleep(2000);
  const afterQueue = (await call(A, 'GET', `/wallets/${walletId}`)).body.balance.amount;
  ok(viaQueue.status === 'PROCESSED' && afterQueue === '50.00', `processada uma vez só, saldo ${afterQueue}`);

  title('Extrato e conferência');
  const ledger = (await call(B, 'GET', `/wallets/${walletId}/ledger?limit=50`)).body.items as {
    direction: string;
    money: { amount: string };
    balanceAfter: { amount: string };
  }[];
  for (const entry of ledger) say(`${entry.direction.padEnd(6)} ${entry.money.amount.padStart(7)}  → saldo ${entry.balanceAfter.amount}`);
  const check = (await call(C, 'POST', `/wallets/${walletId}/reconciliation`)).body;
  ok(check.consistent === true, `saldo gravado ${check.storedBalance.amount} = soma do extrato ${check.calculatedBalance.amount}`);

  console.log(process.exitCode ? '\n\x1b[31mAlgo não saiu como esperado.\x1b[0m' : '\n\x1b[32mTudo certo.\x1b[0m');
  sqs.destroy();
}

await main();
