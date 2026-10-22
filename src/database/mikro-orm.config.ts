import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ALL_SCHEMAS } from './entities';
import { Migration20261022000000 } from './migrations/Migration20261022000000';

export function ormConfig(databaseUrl: string, poolMax = 10) {
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: databaseUrl,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    discovery: { warnWhenNoEntities: false },
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      silent: true,
      migrationsList: [{ name: 'Migration20261022000000', class: Migration20261022000000 }],
    },
    pool: { min: 0, max: poolMax },
    allowGlobalContext: false,
    debug: false,
  });
}
