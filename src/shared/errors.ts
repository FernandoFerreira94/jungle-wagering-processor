/** Violação de regra ou invariante do domínio. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super('CURRENCY_MISMATCH', `Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'Insufficient funds');
  }
}

/** Erro de programação: transição a partir de estado terminal. */
export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSACTION_STATE', `Cannot move transaction from ${from} to ${to}`);
  }
}

// ---- erros de aplicação (cada um tem um status HTTP próprio)

export class ValidationError extends Error {
  constructor(readonly details: string[]) {
    super(`Invalid request: ${details.join('; ')}`);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('A wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency key reused with a different payload: ${key}`);
    this.name = 'IdempotencyConflictError';
  }
}

/** Mesmo messageId de fila com conteúdo diferente: erro permanente, vai para a DLQ. */
export class InboxPayloadConflictError extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} was already received with a different payload`);
    this.name = 'InboxPayloadConflictError';
  }
}

/** Falha temporária de infraestrutura (banco fora, lock timeout): pode tentar de novo. */
export class TransientFailureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientFailureError';
  }
}
