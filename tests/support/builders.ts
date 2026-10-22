import { Money } from '../../src/shared/money';
import { newId } from '../../src/shared/ids';
import { Wallet } from '../../src/wallet/wallet';
import { WagerTransaction, WagerTransactionKind, type CreateWagerTransactionProps } from '../../src/wagering/wager-transaction';

export const NOW = new Date('2026-10-22T12:00:00.000Z');
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export function aWallet(balance = '100.00', overrides: Partial<{ id: string; playerId: string }> = {}): Wallet {
  return Wallet.open({
    id: overrides.id ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    initialBalance: brl(balance),
    now: NOW,
  });
}

export function aTransaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${newId()}`;
  return WagerTransaction.create({
    id: newId(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    createdAt: NOW,
    ...overrides,
  });
}

/** Transação já aplicada, como viria do banco. */
export function aProcessed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const tx = aTransaction(overrides);
  tx.markProcessed(undefined, NOW, brl('0.00'));
  return tx;
}
