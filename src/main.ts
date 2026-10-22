import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadConfig, type AppConfig } from './config';
import { correlationMiddleware } from './shared/correlation';
import { HttpExceptionFilter } from './shared/http-exception.filter';
import { JsonLogger } from './shared/json-logger';

export async function createApp(config: AppConfig = loadConfig(), logger = new JsonLogger()): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, logger), { logger, bodyParser: true });
  app.use(correlationMiddleware);
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  app.enableShutdownHooks();
  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const logger = new JsonLogger();
  const app = await createApp(config, logger);
  if (config.roles.http) await app.listen(config.port);
  else await app.init();
  logger.info('service started', { port: config.port, roles: config.roles });
}
