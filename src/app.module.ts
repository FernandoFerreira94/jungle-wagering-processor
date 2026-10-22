import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { NoopProviderIdentity } from './auth/provider-identity.port';
import { ProviderAuthGuard } from './auth/provider-auth.guard';
import type { AppConfig } from './config';
import { Database } from './database/database';
import { ormConfig } from './database/mikro-orm.config';
import { HealthController } from './health/health.controller';
import { OutboxRepository } from './messaging/outbox.repository';
import { SqsGateway } from './messaging/sqs';
import { MetricsController } from './metrics/metrics.controller';
import { JsonLogger } from './shared/json-logger';
import { Metrics } from './shared/metrics';
import { APP_CONFIG, PROVIDER_IDENTITY } from './tokens';
import { InboxRepository } from './messaging/inbox.repository';
import { PendingReferenceWorker } from './wagering/pending-reference.worker';
import { ProcessWagerUseCase } from './wagering/process-wager.use-case';
import { WageringController } from './wagering/wagering.controller';
import { WagerTransactionRepository } from './wagering/wager-transaction.repository';
import { WalletController } from './wallet/wallet.controller';
import { WalletRepository } from './wallet/wallet.repository';
import { WalletService } from './wallet/wallet.service';

/** Fecha conexões por último, depois que workers e consumer pararam. */
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: JsonLogger): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: JsonLogger, useValue: logger },
        { provide: Metrics, useValue: new Metrics() },
        { provide: MikroORM, useFactory: () => MikroORM.init(ormConfig(config.databaseUrl)) },
        { provide: Database, useFactory: (orm: MikroORM) => new Database(orm, config.lockTimeoutMs), inject: [MikroORM] },
        { provide: SqsGateway, useValue: new SqsGateway(config.aws) },
        { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
        {
          provide: InfrastructureLifecycle,
          useFactory: (orm: MikroORM, sqs: SqsGateway) => new InfrastructureLifecycle(orm, sqs),
          inject: [MikroORM, SqsGateway],
        },
        ProviderAuthGuard,
        WalletRepository,
        WagerTransactionRepository,
        OutboxRepository,
        InboxRepository,
        WalletService,
        ProcessWagerUseCase,
        PendingReferenceWorker,
      ],
    };
  }
}
