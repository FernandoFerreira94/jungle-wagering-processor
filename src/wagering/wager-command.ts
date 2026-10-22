import { canonicalJson, sha256Hex } from '../shared/canonical-json';
import { ValidationError } from '../shared/errors';
import type { Money } from '../shared/money';
import { Fields } from '../shared/validation';
import { WagerTransactionKind } from './wager-transaction';

export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  payloadHash: string;
}

/** Valida o contrato de entrada (HTTP ou SQS). OPENING é interno e nunca é aceito aqui. */
export function parseWagerCommand(body: unknown, idempotencyKey: unknown): WagerCommand {
  const fields = new Fields(body);
  const providerId = fields.text('providerId', { max: 100 });
  const externalTransactionId = fields.text('externalTransactionId');
  const playerId = fields.uuid('playerId');
  const walletId = fields.uuid('walletId');
  const roundId = fields.text('roundId');
  const gameId = fields.text('gameId');
  const kind = fields.oneOf('kind', SUBMITTABLE_KINDS);
  const money = fields.money('money');
  const reference = fields.text('referenceExternalTransactionId', { optional: true });
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '' || idempotencyKey.length > 255) {
    fields.errors.push('Idempotency-Key is required (max 255 characters)');
  }
  fields.assertValid();
  if (kind !== WagerTransactionKind.Loss && money!.isZero()) throw new ValidationError([`money must be greater than zero for ${kind}`]);
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
    throw new ValidationError([`referenceExternalTransactionId is required for ${kind}`]);
  }

  const command = {
    providerId,
    externalTransactionId,
    idempotencyKey: idempotencyKey as string,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money: money!,
    referenceExternalTransactionId: reference || undefined,
  };
  return { ...command, payloadHash: payloadHashOf(command) };
}

/**
 * SHA-256 (hex) do JSON canônico (chaves ordenadas, sem campos vazios) dos campos de negócio.
 * O header Idempotency-Key e metadados de transporte não entram.
 */
export function payloadHashOf(command: Omit<WagerCommand, 'payloadHash' | 'idempotencyKey'>): string {
  return sha256Hex(
    canonicalJson({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    }),
  );
}
