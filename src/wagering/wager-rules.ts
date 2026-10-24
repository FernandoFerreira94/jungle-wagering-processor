import { LedgerDirection } from '../wallet/ledger-entry';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { ALLOWED_REFERENCE_KINDS, WagerTransactionStatus, type WagerTransaction } from './wager-transaction';

export type Decision =
  | { kind: 'apply'; direction: LedgerDirection }
  | { kind: 'no-balance-effect' }
  | { kind: 'reject'; code: FailureCode }
  | { kind: 'wait-reference' };

export interface DecideWagerInput {
  tx: WagerTransaction;
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined = ainda não chegou. */
  reference?: WagerTransaction;
  /** Já existe uma reversão PROCESSED para esta referência. */
  referenceAlreadyReversed: boolean;
}

/** Regras de negócio da §7, sem I/O: decide o que fazer com uma transação. */
export function decideWager({ tx, wallet, reference, referenceAlreadyReversed }: DecideWagerInput): Decision {
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  if (tx.referenceExternalTransactionId) {
    const problem = checkReference(tx, reference, referenceAlreadyReversed);
    if (problem) return problem;
  }

  if (!tx.affectsBalance()) return { kind: 'no-balance-effect' };

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Credit && !wallet.canCredit(tx.money)) return reject(FailureCode.BalanceLimitExceeded);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }
  return { kind: 'apply', direction };
}

function checkReference(
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  alreadyReversed: boolean,
): Decision | undefined {
  if (!reference) return { kind: 'wait-reference' };
  if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
    return { kind: 'wait-reference' };
  }
  if (reference.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);

  const sameScope =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameScope) return reject(FailureCode.ReferenceMismatch);

  const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
  if (!allowed.includes(reference.kind)) return reject(FailureCode.ReferenceKindNotAllowed);

  if (tx.isReversal()) {
    if (!reference.money.equals(tx.money)) return reject(FailureCode.ReferenceAmountMismatch);
    if (alreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);
  }
  return undefined;
}

function reject(code: FailureCode): Decision {
  return { kind: 'reject', code };
}
