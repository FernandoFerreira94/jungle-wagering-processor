import { expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRecord } from '../../src/database/entities';
import { Money } from '../../src/shared/money';
import { FailureCode } from '../../src/wagering/failure-code';
import { WagerTransactionRepository } from '../../src/wagering/wager-transaction.repository';
import { aTransaction, brl, NOW } from '../support/builders';

test.each([FailureCode.CurrencyMismatch, FailureCode.WalletPlayerMismatch])(
  'preserves the observed balance currency when rehydrating %s', async (code) => {
    const tx = aTransaction({ money: Money.from({ amount: '1.00', currency: 'USD' }) });
    tx.reject(code, NOW, brl('100.00'));
    let stored: WagerTransactionRecord;
    // Apenas a fronteira de I/O é substituída; o mapeamento de ida e volta é o real.
    const em = {
      insert: async (_entity: unknown, record: WagerTransactionRecord) => { stored = record; },
      findOne: async () => stored,
      findOneOrFail: async () => ({ currency: 'BRL' }),
    } as unknown as EntityManager;
    const repo = new WagerTransactionRepository();
    await repo.insert(em, tx);
    const reloaded = await repo.findById(em, tx.id);
    expect(reloaded?.resultBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(reloaded?.money.toJSON()).toEqual({ amount: '1.00', currency: 'USD' });
  },
);
