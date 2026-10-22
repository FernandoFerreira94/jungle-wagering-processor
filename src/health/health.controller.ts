import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '../config';
import { Database } from '../database/database';
import { SqsGateway } from '../messaging/sqs';
import { APP_CONFIG } from '../tokens';

/** Sem autenticação, de propósito (§2). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; checks: Record<string, string> }> {
    const checks = {
      postgres: await this.check(() => this.db.ping()),
      sqs: await this.check(() => this.sqs.ping(this.config.queues.transactions)),
    };
    const ok = Object.values(checks).every((value) => value === 'up');
    if (!ok) throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', checks };
  }

  private async check(probe: () => Promise<void>): Promise<string> {
    try {
      await Promise.race([probe(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
