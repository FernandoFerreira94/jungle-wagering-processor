import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/config';
import { ormConfig } from '../src/database/mikro-orm.config';

const direction = process.argv[2] ?? 'up';
const orm = await MikroORM.init(ormConfig(loadConfig().databaseUrl, 2));
try {
  const migrator = orm.getMigrator();
  const applied = direction === 'down' ? await migrator.down() : await migrator.up();
  console.log(JSON.stringify({ level: 'info', msg: `migrations ${direction}`, migrations: applied.map((m) => m.name) }));
} finally {
  await orm.close();
}
