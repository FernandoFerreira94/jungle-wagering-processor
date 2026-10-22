import './test-env';
import { loadConfig } from '../../src/config';
import { SqsGateway } from '../../src/messaging/sqs';

export const queues = loadConfig().queues;
export const testSqs = () => new SqsGateway(loadConfig().aws);

/** Lê e apaga tudo o que estiver visível na fila, até ela ficar vazia. */
export async function drainQueue(sqs: SqsGateway, queue: string, { quietMs = 500 } = {}): Promise<any[]> {
  const bodies: any[] = [];
  let emptySince = Date.now();
  while (Date.now() - emptySince < quietMs) {
    const messages = await sqs.receive(queue, 10, 0, 30);
    if (messages.length === 0) {
      await Bun.sleep(50);
      continue;
    }
    emptySince = Date.now();
    for (const message of messages) {
      bodies.push(parseBody(message.Body));
      await sqs.delete(queue, message.ReceiptHandle as string);
    }
  }
  return bodies;
}

export async function drainAll(sqs: SqsGateway): Promise<void> {
  await Promise.all([drainQueue(sqs, queues.transactions, { quietMs: 200 }), drainQueue(sqs, queues.dlq, { quietMs: 200 }), drainQueue(sqs, queues.events, { quietMs: 200 })]);
}

export function wagerMessage(data: Record<string, unknown>, messageId = `msg-${crypto.randomUUID()}`) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
}

/** Publica na fila de entrada. Cada envio tem dedup id próprio: simula redelivery/duplicata do provedor. */
export async function sendWager(sqs: SqsGateway, message: { messageId: string; data: Record<string, unknown> } | string, groupId?: string) {
  const body = typeof message === 'string' ? message : JSON.stringify(message);
  const group = groupId ?? (typeof message === 'string' ? 'invalid' : String(message.data.walletId));
  await sqs.send(queues.transactions, body, { groupId: group, deduplicationId: crypto.randomUUID() });
}

function parseBody(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? 'null');
  } catch {
    return body;
  }
}
