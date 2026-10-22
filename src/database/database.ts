import type { EntityManager } from '@mikro-orm/postgresql';
import { MikroORM } from '@mikro-orm/postgresql';
import { TransientFailureError } from '../shared/errors';
import { isTransient } from './pg-errors';

/** Ponto único para abrir transações: lock_timeout curto e falhas transitórias com tipo próprio. */
export class Database {
  constructor(readonly orm: MikroORM) {}

  async transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '5s'`);
        return work(em);
      });
    } catch (error) {
      if (isTransient(error)) throw new TransientFailureError('Database temporarily unavailable', { cause: error });
      throw error;
    }
  }

  /** Leitura fora de transação explícita. */
  async read<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await work(this.orm.em.fork());
    } catch (error) {
      if (isTransient(error)) throw new TransientFailureError('Database temporarily unavailable', { cause: error });
      throw error;
    }
  }

  async ping(): Promise<void> {
    await this.orm.em.fork().execute('SELECT 1');
  }
}
