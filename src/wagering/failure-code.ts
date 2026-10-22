/** Códigos estáveis e legíveis por máquina para toda rejeição ou falha persistida. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  InternalError = 'INTERNAL_ERROR',
}

/**
 * `retryable`: o provedor pode reenviar a MESMA operação com uma NOVA chave
 * depois que a condição mudar (ex.: saldo). Reenviar com a mesma chave sempre
 * devolve o resultado original.
 */
export const FAILURE_CODE_INFO: Record<FailureCode, { retryable: boolean; description: string }> = {
  [FailureCode.InsufficientFunds]: { retryable: true, description: 'BET maior que o saldo disponível' },
  [FailureCode.ReversalInsufficientFunds]: { retryable: true, description: 'Reversão deixaria o saldo negativo' },
  [FailureCode.CurrencyMismatch]: { retryable: false, description: 'Moeda da operação diferente da wallet' },
  [FailureCode.WalletPlayerMismatch]: { retryable: false, description: 'A wallet não pertence ao player informado' },
  [FailureCode.ReferenceNotFound]: { retryable: false, description: 'Referência não chegou dentro do limite de espera' },
  [FailureCode.ReferenceKindNotAllowed]: { retryable: false, description: 'Tipo da referência não pode ser revertido por esta operação' },
  [FailureCode.ReferenceMismatch]: { retryable: false, description: 'Referência de outro player, wallet, moeda ou rodada' },
  [FailureCode.ReferenceAmountMismatch]: { retryable: false, description: 'Valor diferente do valor da referência' },
  [FailureCode.ReferenceNotProcessed]: { retryable: false, description: 'Referência foi rejeitada ou falhou' },
  [FailureCode.ReferenceAlreadyReversed]: { retryable: false, description: 'Referência já foi revertida' },
  [FailureCode.InternalError]: { retryable: false, description: 'Erro permanente de infraestrutura; auditável' },
};
