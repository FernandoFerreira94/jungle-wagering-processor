import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

export interface SqsGatewayOptions {
  endpoint: string;
  region: string;
}

/** Fachada fina sobre o SDK: só o que a aplicação usa, com cache de URL das filas. */
export class SqsGateway {
  private readonly client: SQSClient;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(options: SqsGatewayOptions) {
    this.client = new SQSClient({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  queueUrl(name: string): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => r.QueueUrl as string);
      url.catch(() => this.urls.delete(name));
      this.urls.set(name, url);
    }
    return url;
  }

  async send(queue: string, body: string, fifo: { groupId: string; deduplicationId: string }): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MessageBody: body,
        MessageGroupId: fifo.groupId,
        MessageDeduplicationId: fifo.deduplicationId,
      }),
    );
  }

  async receive(queue: string, max: number, waitSeconds: number, visibilitySeconds?: number): Promise<Message[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    return result.Messages ?? [];
  }

  async delete(queue: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(queue), ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queue),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async ping(queue: string): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: await this.queueUrl(queue), AttributeNames: ['QueueArn'] }),
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}
