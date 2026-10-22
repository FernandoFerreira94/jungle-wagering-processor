/*
 * Playground: tela simples para experimentar o sistema à mão. NÃO faz parte do serviço entregue.
 * Serve a página e repassa as chamadas para as 3 instâncias (evita CORS) e para a fila SQS.
 *   docker compose --profile playground up -d   →   http://localhost:8080
 */
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const INSTANCES = (process.env.PLAYGROUND_INSTANCES ?? 'http://app-1:3000,http://app-2:3000,http://app-3:3000').split(',');
const PORT = Number(process.env.PORT ?? 8080);
const sqs = new SQSClient({ endpoint: process.env.AWS_ENDPOINT_URL, region: process.env.AWS_REGION ?? 'us-east-1' });
const page = Bun.file(new URL('./index.html', import.meta.url));

async function sendToQueue(request: Request): Promise<Response> {
  const { message, groupId, times } = (await request.json()) as { message: unknown; groupId: string; times?: number };
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
  for (let i = 0; i < Math.min(times ?? 1, 5); i++) {
    await sqs.send(
      new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(message), MessageGroupId: groupId, MessageDeduplicationId: crypto.randomUUID() }),
    );
  }
  return Response.json({ sent: times ?? 1 });
}

/** /api/{1|2|3}/<caminho> → instância N. */
async function proxy(request: Request, url: URL): Promise<Response> {
  const [, , n, ...rest] = url.pathname.split('/');
  const target = INSTANCES[Number(n) - 1];
  if (!target) return new Response('unknown instance', { status: 404 });
  const started = performance.now();
  const upstream = await fetch(`${target}/${rest.join('/')}${url.search}`, {
    method: request.method,
    headers: { 'content-type': 'application/json', ...(request.headers.get('idempotency-key') ? { 'idempotency-key': request.headers.get('idempotency-key')! } : {}) },
    body: request.method === 'GET' ? undefined : await request.text(),
  }).catch(() => null);
  if (!upstream) return Response.json({ error: 'INSTANCE_DOWN' }, { status: 502 });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'x-elapsed-ms': (performance.now() - started).toFixed(0) },
  });
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/queue' && request.method === 'POST') return sendToQueue(request);
    if (url.pathname.startsWith('/api/')) return proxy(request, url);
    return new Response('not found', { status: 404 });
  },
});
console.log(`playground em http://localhost:${PORT}`);
