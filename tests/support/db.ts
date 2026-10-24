import { assertTestEnvironment } from './test-env';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config';
import { ormConfig } from '../../src/database/mikro-orm.config';

export async function testOrm(): Promise<MikroORM> {
  assertTestEnvironment();
  return MikroORM.init(ormConfig(loadConfig().databaseUrl, 20));
}

/** Schema do zero: desfaz e reaplica as migrations (o ledger não aceita TRUNCATE). */
export async function resetDatabase(): Promise<void> {
  const orm = await testOrm();
  try {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();
  } finally {
    await orm.close();
  }
}

/** SQL direto, como faria alguém mexendo no banco por fora da aplicação. */
export async function sql<T = Record<string, unknown>>(orm: MikroORM, query: string, params: unknown[] = []): Promise<T[]> {
  return orm.em.getConnection().execute(query, params);
}
