# Distributed Wagering Processor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serviço financeiro que processa `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` de vários provedores e continua correto com mensagens duplicadas, fora de ordem e concorrentes, em várias instâncias.

**Architecture:** O PostgreSQL é a única fonte de garantia. Cada operação roda em **uma** transação SQL que trava a linha da wallet (`SELECT … FOR UPDATE`), aplica a regra de domínio, grava transação + ledger + inbox + outbox e só então confirma; constraints e triggers no schema são a última barreira. HTTP e SQS chamam o **mesmo** use case; workers (outbox, pending-reference) usam `FOR UPDATE SKIP LOCKED` e podem rodar em N instâncias.

**Tech Stack:** Bun 1.x (runtime, package manager, test runner), TypeScript strict, NestJS 11, MikroORM 6 (`@mikro-orm/postgresql`, `@mikro-orm/migrations`) com `EntitySchema`, PostgreSQL 16, AWS SQS via LocalStack 3.8 (`@aws-sdk/client-sqs`), `prom-client`, Docker Compose.

**Spec:** `docs/CHALLENGE.md` (cópia literal do README do desafio). Seções citadas como §N.

## Global Constraints

- Dinheiro nunca é `number`/`float`: domínio usa `bigint` em centavos; contratos usam string `"25.00"`; banco usa `NUMERIC(20,2)` + `CHAR(3)` (§5.1, §6.1).
- `Money.from` aceita só `^\d+(\.\d{1,2})?$` e serializa sempre com 2 casas; rejeita `NaN`, `Infinity`, notação científica, vazio, >2 casas, negativos. Nunca arredonda (§6.1).
- Idempotência só no banco: `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`, inbox `PK(consumer_name, message_id)` (§5.2).
- Sem lock global: lock por linha de wallet (§5.6, §8).
- Evento só existe como linha de outbox gravada na mesma transação; publicação acontece depois do commit (§5.4, §11).
- Ledger append-only garantido por trigger (`UPDATE`/`DELETE`/`TRUNCATE` → erro) (§5.5).
- Unicidade, imutabilidade e não-negatividade em constraints do schema (§5.9).
- Domínio sem imports de NestJS ou MikroORM; construtor `private` + `create`/`from`/`rehydrate`; `rehydrate` não revalida (§6.0).
- Prisma proibido. Testes de integração e concorrência usam Postgres e LocalStack reais; mocks só em testes de unidade (§13, §14).
- Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; nunca o payload financeiro completo (§12).
- Moeda padrão `BRL`, modelo multi-moeda; conflito de moeda testado (§6.1).
- Código em inglês, docs em português. Cada task termina acrescentando uma seção curta, em linguagem simples, em `docs/DIARIO.md`.

## Review Focus

1. Valores limítrofes em `money.amount` (`"0.00"` numa `BET`, `"025.00"`, `" 25.00"`, `"-0.00"`, `"1e3"`, `"25.001"`): `BET/WIN/REFUND/ROLLBACK` exigem valor > 0; espaços e expoente → 400. Teste em Task 2 e Task 7.
2. Mesmo `messageId` SQS com payload diferente: não é replay, vai para DLQ como erro permanente. Teste em Task 10.
3. Mesmo `(providerId, externalTransactionId)` enviado com outra `Idempotency-Key`: 409 `IDEMPOTENCY_CONFLICT`, sem efeito. Teste em Task 7.
4. Referência com o mesmo `externalTransactionId` de **outro** provider: não resolve (lookup é por `(providerId, referenceExternalTransactionId)`), fica `PENDING_REFERENCE`. Teste em Task 8.
5. Postgres fora do ar ou `lock_timeout` estourado: HTTP responde 503 `TRANSIENT_FAILURE` (nunca 500 genérico) e o consumer devolve a mensagem com backoff. Teste em Task 7 (lock timeout) e Task 10.

---

## File Structure

```
src/
  main.ts                         bootstrap; liga HTTP/consumer/workers por env
  app.module.ts
  config.ts                       loadConfig(): AppConfig (env → objeto tipado)
  shared/
    money.ts                      Money (value object)
    errors.ts                     DomainError e subclasses; erros de aplicação
    canonical-json.ts             canonicalJson(), sha256Hex()
    json-logger.ts                JsonLogger implements LoggerService
    metrics.ts                    Metrics (registro prom-client + métricas nomeadas)
    http-exception.filter.ts      mapeia erros → status HTTP
  auth/
    provider-identity.port.ts     ProviderIdentityPort + NoopProviderIdentity
    provider-auth.guard.ts        ProviderAuthGuard (no-op, ponto de extensão)
  database/
    mikro-orm.config.ts
    entities.ts                   EntitySchema de todas as tabelas (records)
    migrations/Migration20261022000000.ts
    database.module.ts
    pg-errors.ts                  isUniqueViolation(), isTransient()
  wallet/
    wallet.ts                     Wallet (aggregate)
    ledger-entry.ts               WalletLedgerEntry
    wallet.repository.ts          load/lock/save wallet + ledger
    wallet.service.ts             createWallet, getWallet, listLedger, reconcile
    wallet.controller.ts
  wagering/
    failure-code.ts               FailureCode enum + metadados (retryable)
    wager-transaction.ts          WagerTransaction (entity)
    wager-rules.ts                decideWager(): Decision (regras §7, pura)
    wager-command.ts              parseWagerCommand(), payloadHashOf()
    wager-transaction.repository.ts
    process-wager.use-case.ts     ProcessWagerUseCase (HTTP + SQS + worker)
    pending-reference.worker.ts
    wagering.controller.ts
  messaging/
    inbox-message.ts
    outbox-message.ts
    integration-events.ts         IntegrationEvent + 4 subclasses
    outbox.repository.ts
    outbox-publisher.worker.ts
    sqs.ts                        SqsGateway (send, receive, delete, visibility, dlq)
    wager-consumer.ts             WagerConsumer (inbox, ack pós-commit, retry, DLQ, SIGTERM)
  health/health.controller.ts
  metrics/metrics.controller.ts   GET /metrics
localstack/init/ready.d/01-queues.sh
docker-compose.yml, Dockerfile, .env.example
tests/
  unit/*.test.ts
  integration/*.test.ts
  concurrency/*.test.ts
  support/                        env de teste, reset de schema, spawn de instâncias, helpers SQS, invariante
load/load-test.ts                 bun run test:load (opcional)
docs/ARCHITECTURE.md, docs/EVALUATOR_GUIDE.md, docs/DIARIO.md, README.md
```

Scripts em `package.json`: `start`, `typecheck` (`tsc --noEmit`), `migration:up`, `migration:down`, `test:unit` (`bun test tests/unit`), `test:integration`, `test:concurrency`, `test` (tudo), `test:load`.

---

### Task 1: Esqueleto, infraestrutura e config

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.env.example`, `docker-compose.yml`, `Dockerfile`, `localstack/init/ready.d/01-queues.sh`, `src/config.ts`, `tests/unit/config.test.ts`, `docs/DIARIO.md`

**Interfaces:**
- Produces: `loadConfig(env = process.env): AppConfig` com `{ port: number; databaseUrl: string; aws: { endpoint: string; region: string }; queues: { transactions: string; dlq: string; events: string }; roles: { http: boolean; consumer: boolean; outbox: boolean; pendingWorker: boolean }; consumerName: string; maxReceiveCount: number; pendingReference: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } }`.

- [ ] **Step 1:** Teste `loadConfig` com env vazio retorna defaults (`port 3000`, filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`, todos os roles `true`, `maxReceiveCount 5`, `pendingReference {maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 60000}`) e com `ROLE_CONSUMER=false` desliga só o consumer.
- [ ] **Step 2:** `bun test tests/unit/config.test.ts` → FAIL.
- [ ] **Step 3:** Implementar `src/config.ts`. `tsconfig` com `strict`, `noUncheckedIndexedAccess`, `experimentalDecorators`, `emitDecoratorMetadata`. Compose: `postgres:16-alpine` (DBs `wagering` e `wagering_test` via script de init), `localstack/localstack:3.8` (`SERVICES=sqs`) com o script criando para os prefixos `""` e `test-`: `wager-transactions-dlq.fifo`, `wager-transactions.fifo` (redrive `maxReceiveCount=5`, `VisibilityTimeout=30`), `wager-events.fifo`; serviço `migrate` (one-shot) e `app-1`, `app-2`, `app-3` (mesma imagem, portas 3001–3003) via âncora YAML com `depends_on` em healthchecks.
- [ ] **Step 4:** `bun test tests/unit/config.test.ts` → PASS; `bun run typecheck` → 0 erros; `docker compose up -d postgres localstack` sobe e `awslocal sqs list-queues` lista 6 filas.
- [ ] **Step 5:** Diário (fase 1) + commit `chore: project skeleton, compose and config`.

### Task 2: Money e hash canônico

**Files:**
- Create: `src/shared/money.ts`, `src/shared/errors.ts`, `src/shared/canonical-json.ts`, `tests/unit/money.test.ts`, `tests/unit/canonical-json.test.ts`

**Interfaces:**
- Produces: `interface MoneyProps { amount: string; currency: string }`; `class Money { static from(p: MoneyProps): Money; static zero(currency: string): Money; static fromMinor(minor: bigint, currency: string): Money; readonly minor: bigint; readonly currency: string; add; subtract; negate; isZero; isPositive; isNegative; isLessThan; equals; toJSON(): MoneyProps; toString(): string }`.
- Produces: `class DomainError extends Error { code: string }`, `InvalidMoneyError`, `CurrencyMismatchError`, `InvalidTransactionStateError`, `ValidationError(details: string[])`.
- Produces: `canonicalJson(value: unknown): string` (chaves ordenadas recursivamente, `undefined` omitido); `sha256Hex(s: string): string` (via `Bun.CryptoHasher`/`node:crypto`).

- [ ] **Step 1:** Testes: `Money.from({amount:"25.5",currency:"BRL"}).toString() === "25.50 BRL"`, `toJSON().amount === "25.50"`; `"0.10"+"0.20" === "0.30"`; rejeita `"NaN"`, `"Infinity"`, `"1e3"`, `""`, `" 25.00"`, `"25.001"`, `"-1.00"`, moeda `"brl"`/`"BR"`; `add` BRL+USD lança `CurrencyMismatchError`; imutabilidade (`a.add(b)` não altera `a`); `negate().isNegative()`; `canonicalJson({b:1,a:{d:2,c:undefined}}) === '{"a":{"d":2},"b":1}'`; mesmo objeto com chaves em outra ordem → mesmo `sha256Hex`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar. `Money` guarda `bigint` centavos; parse via regex dos Global Constraints; moeda `^[A-Z]{3}$`.
- [ ] **Step 4:** `bun test tests/unit` → PASS.
- [ ] **Step 5:** Diário (fase 2) + commit `feat: Money value object and canonical hashing`.

### Task 3: Domínio de wallet, ledger, transação e regras

**Files:**
- Create: `src/wallet/wallet.ts`, `src/wallet/ledger-entry.ts`, `src/wagering/failure-code.ts`, `src/wagering/wager-transaction.ts`, `src/wagering/wager-rules.ts`, `tests/unit/wallet.test.ts`, `tests/unit/ledger-entry.test.ts`, `tests/unit/wager-transaction.test.ts`, `tests/unit/wager-rules.test.ts`

**Interfaces:**
- Produces: `Wallet.open({id, playerId, initialBalance}): Wallet` (version 1); `Wallet.rehydrate(state)`; `wallet.debit(money, transactionId, at): WalletLedgerEntry` e `credit(...)` — lançam `InsufficientFundsError` sem mudar estado; incrementam `version` e `updatedAt`.
- Produces: `enum LedgerDirection`; `WalletLedgerEntry.create({id, walletId, transactionId, direction, money, balanceBefore, balanceAfter, createdAt})` valida `isBalanced()`.
- Produces: `enum FailureCode { INSUFFICIENT_FUNDS, REVERSAL_INSUFFICIENT_FUNDS, CURRENCY_MISMATCH, WALLET_PLAYER_MISMATCH, REFERENCE_NOT_FOUND, REFERENCE_KIND_NOT_ALLOWED, REFERENCE_MISMATCH, REFERENCE_AMOUNT_MISMATCH, REFERENCE_NOT_PROCESSED, REFERENCE_ALREADY_REVERSED, INTERNAL_ERROR }` + `FAILURE_CODE_INFO: Record<FailureCode, { retryable: boolean; description: string }>`.
- Produces: enums `WagerTransactionKind`, `WagerTransactionStatus` (§6.3); `WagerTransaction.create(props)` (nasce `PENDING`, valida referência obrigatória e valor > 0 exceto `LOSS` ≥ 0, recusa `OPENING` vindo de fora via `createOpening` separado); `markProcessed(refId, at, balanceAfter: Money)`, `markPendingReference()`, `reject(code, balanceAt?: Money)`, `fail(code)`; `isTerminal`, `affectsBalance`, `requiresReference`, `matchesPayload`, `ledgerDirectionFor(reference?)`; campo `resultBalance` (saldo observado, para replay §7.7).
- Produces: `decideWager({ tx, wallet, reference, referenceAlreadyReversed }): Decision` onde `Decision = { kind: 'apply'; direction: LedgerDirection } | { kind: 'no-balance-effect' } | { kind: 'reject'; code: FailureCode } | { kind: 'wait-reference' }`.

- [ ] **Step 1:** Testes das invariantes: wallet `version` 1 após `open`, sobe só quando saldo muda; débito maior que saldo lança e não altera; moeda diferente lança `CurrencyMismatchError`; ledger com aritmética errada lança; transições a partir de estado terminal lançam `InvalidTransactionStateError`; `matchesPayload`. Testes de `decideWager` (tabela §7): BET sem saldo → `INSUFFICIENT_FUNDS`; WIN → CREDIT; LOSS → `no-balance-effect`; REFUND de BET → CREDIT; REFUND de WIN → `REFERENCE_KIND_NOT_ALLOWED`; ROLLBACK de WIN → DEBIT, sem saldo → `REVERSAL_INSUFFICIENT_FUNDS`; referência de outra rodada/player/wallet/moeda → `REFERENCE_MISMATCH`; valor diferente → `REFERENCE_AMOUNT_MISMATCH`; referência ausente → `wait-reference`; referência `PENDING_REFERENCE` → `wait-reference`; referência `REJECTED` → `REFERENCE_NOT_PROCESSED`; já revertida → `REFERENCE_ALREADY_REVERSED`; moeda da tx ≠ wallet → `CURRENCY_MISMATCH`; player ≠ dono da wallet → `WALLET_PLAYER_MISMATCH`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar. Interpretação documentada: uma referência só pode ser revertida **uma vez no total** (REFUND ou ROLLBACK), porque REFUND + ROLLBACK da mesma BET duplicaria crédito (§3 invariantes). WIN/LOSS podem trazer referência opcional; se trazem, ela precisa resolver para uma BET da mesma rodada.
- [ ] **Step 4:** `bun test tests/unit` → PASS.
- [ ] **Step 5:** Diário (fase 3) + commit `feat: wallet, ledger and wager domain rules`.

### Task 4: Inbox, outbox e eventos de integração

**Files:**
- Create: `src/messaging/inbox-message.ts`, `src/messaging/outbox-message.ts`, `src/messaging/integration-events.ts`, `tests/unit/outbox-message.test.ts`, `tests/unit/integration-events.test.ts`

**Interfaces:**
- Produces: `InboxMessage.receive({messageId, consumerName, payloadHash, receivedAt})`, `markProcessed(at)`, `isProcessed()`.
- Produces: `OutboxMessage.enqueue(event)`, `isPending()`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now)` com atraso `min(1000 * 2^attempts, 60000)` ms.
- Produces: `abstract class IntegrationEvent<T>` (§11) + `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`, cada um com `static from(...)` e `eventType`/`version = 1` no tipo; `EventContext = { correlationId: string; causationId?: string; now: Date }`.

- [ ] **Step 1:** Testes: `scheduleRetry` 3× gera atrasos 2s, 4s, 8s e para em 60s; `markPublished` torna `isPending()` falso; `WalletBalanceChanged.from(...).toJSON()` tem `eventType`, `version: 1`, `occurredAt` ISO e `data.money` como `MoneyProps` string.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Diário (fase 4) + commit `feat: inbox, outbox and integration events`.

### Task 5: Schema, migration e constraints

**Files:**
- Create: `src/database/mikro-orm.config.ts`, `src/database/entities.ts`, `src/database/migrations/Migration20261022000000.ts`, `src/database/database.module.ts`, `src/database/pg-errors.ts`, `scripts/migrate.ts`, `tests/support/test-env.ts`, `tests/support/db.ts`, `tests/integration/schema.test.ts`

**Interfaces:**
- Produces: records `WalletRecord`, `LedgerEntryRecord`, `WagerTransactionRecord`, `InboxRecord`, `OutboxRecord` (classes simples + `EntitySchema`, `decimal` mapeado como string).
- Produces: `resetDatabase(): Promise<void>` (migrator down até 0 + up) e `testOrm(): Promise<MikroORM>`.
- Produces: `isUniqueViolation(e, constraint?: string): boolean` (SQLSTATE 23505), `isTransient(e): boolean` (conexão, `55P03` lock_not_available, `40001`, `40P01`).

Tabelas e garantias (todas no schema):
- `wallets`: `UNIQUE(player_id, currency)`, `CHECK(balance >= 0)`, `CHECK(version >= 1)`, `CHECK(currency ~ '^[A-Z]{3}$')`.
- `wager_transactions`: `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`, `CHECK` de `kind`/`status`, `CHECK(amount >= 0)`, `CHECK(kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)`, `CHECK(status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL)`, colunas `result_balance`, `reference_attempts`, `next_reference_attempt_at`; índice único parcial `ux_single_reversal ON (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`; índice parcial para o worker `WHERE status = 'PENDING_REFERENCE'`.
- `wallet_ledger_entries`: `seq BIGSERIAL` (cursor), `UNIQUE(transaction_id)`, `CHECK(amount > 0)`, `CHECK(balance_after >= 0)`, `CHECK` da aritmética por direção, triggers `BEFORE UPDATE OR DELETE` (row) e `BEFORE TRUNCATE` (statement) que lançam exceção.
- `inbox_messages`: `PRIMARY KEY(consumer_name, message_id)`.
- `outbox_messages`: `payload JSONB`, `attempts`, `next_attempt_at`, `published_at`; índice parcial `WHERE published_at IS NULL`.
- Trigger `wager_transactions_terminal_guard`: `UPDATE` em linha com status terminal → exceção (imutabilidade do estado terminal no banco).

- [ ] **Step 1:** Testes de integração (Postgres real, `wagering_test`): `UPDATE wallets SET balance = -1` falha com check; segunda wallet mesmo `player_id`+`currency` falha; `UPDATE`/`DELETE`/`TRUNCATE` no ledger falham; ledger com aritmética errada falha; dois REFUND `PROCESSED` para a mesma referência falham em `ux_single_reversal`; `UPDATE` de transação `PROCESSED` falha; `migration:down` remove tudo e `up` recria.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar migration com SQL explícito em `up()`/`down()`. **Step 4:** `bun run test:integration -- schema` → PASS.
- [ ] **Step 5:** Diário (fase 5) + commit `feat: database schema with financial constraints`.

### Task 6: Wallets, consultas, reconciliação, health e auth

**Files:**
- Create: `src/app.module.ts`, `src/main.ts`, `src/wallet/wallet.repository.ts`, `src/wallet/wallet.service.ts`, `src/wallet/wallet.controller.ts`, `src/shared/http-exception.filter.ts`, `src/auth/provider-identity.port.ts`, `src/auth/provider-auth.guard.ts`, `src/health/health.controller.ts`, `tests/support/app.ts`, `tests/integration/wallet-api.test.ts`

**Interfaces:**
- Produces: `WalletRepository.lockById(em, id): Promise<Wallet | null>` (`LockMode.PESSIMISTIC_WRITE`), `save(em, wallet)`, `appendLedger(em, entry)`, `pageLedger(walletId, cursor?: string, limit = 50)` (cursor = base64url de `seq`), `sumLedger(walletId): Promise<{ balance: Money; entries: number }>`.
- Produces: `WalletService.create({playerId, initialBalance}): Promise<WalletView>` — saldo > 0 gera transação `OPENING` + ledger `CREDIT` + outbox `WalletBalanceChanged` na mesma transação; `reconcile(walletId): Promise<ReconciliationView>` — divergência: log `error`, métrica `reconciliation_mismatches_total`, `consistent: false`, sem correção.
- Produces: `createTestApp(overrides?): Promise<{ app: INestApplication; url: string }>`.
- Mapeamento HTTP (`HttpExceptionFilter`, igual em todos os endpoints): 400 `VALIDATION_ERROR`; 404 `NOT_FOUND`; 409 `IDEMPOTENCY_CONFLICT` / `WALLET_ALREADY_EXISTS`; 422 rejeição de negócio com `failureCode`; 202 `PENDING_REFERENCE`; 503 `TRANSIENT_FAILURE`; 200 sucesso/replay; 201 criação de wallet.

- [ ] **Step 1:** Testes HTTP: criar wallet `1000.00 BRL` → 201, `version 1`, ledger com 1 `CREDIT`; duplicada → 409; `initialBalance "0.00"` → sem ledger; `GET /wallets/:id`; ledger paginado com `limit=1` devolve `nextCursor` estável; reconciliação consistente; reconciliação com divergência forçada (`UPDATE wallets SET balance = balance + 1` direto no SQL) → `consistent: false`, `difference "1.00"`; `/health/live` 200; `/health/ready` 200 com infra no ar.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar; `ProviderAuthGuard` aplicado aos controllers de negócio, nunca no health. **Step 4:** PASS.
- [ ] **Step 5:** Diário (fase 6) + commit `feat: wallet API, reconciliation, health and auth extension point`.

### Task 7: Use case de processamento e endpoint HTTP

**Files:**
- Create: `src/wagering/wager-command.ts`, `src/wagering/wager-transaction.repository.ts`, `src/wagering/process-wager.use-case.ts`, `src/wagering/wagering.controller.ts`, `tests/integration/wagering-api.test.ts`

**Interfaces:**
- Consumes: `decideWager`, `WalletRepository`, `OutboxMessage`, eventos.
- Produces: `parseWagerCommand(body: unknown, idempotencyKey: string | undefined): WagerCommand` (lança `ValidationError`; `kind: OPENING` → 400); `payloadHashOf(cmd): string` sobre `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId}`.
- Produces: `ProcessWagerUseCase.execute(cmd: WagerCommand, inbox?: { consumerName: string; messageId: string; payloadHash: string }): Promise<WagerResult>`; `WagerResult = { transactionId: string; status: WagerTransactionStatus; balance: MoneyProps | null; failureCode?: FailureCode; idempotentReplay: boolean }`. Lança `IdempotencyConflictError`, `NotFoundError` (wallet), `TransientFailureError`.
- Produces: `ProcessWagerUseCase.retryPending(transactionId): Promise<WagerResult | null>` (usado na Task 8).

Algoritmo (uma transação, `SET LOCAL lock_timeout = '5s'`):
1. Inbox (se houver): `INSERT … ON CONFLICT DO NOTHING`; já existente com mesmo hash → retorna resultado gravado da transação; hash diferente → `InboxPayloadConflictError`.
2. Trava wallet `FOR UPDATE` (não existe → `NotFoundError`).
3. Busca por `idempotency_key`, depois por `(provider_id, external_transaction_id)`: existe com mesmo hash e mesma key → replay (`idempotentReplay: true`); senão → `IdempotencyConflictError`.
4. Resolve referência por `(provider_id, reference_external_transaction_id)` e se já há reversão `PROCESSED` dela.
5. `decideWager` → aplica (`debit`/`credit` + ledger + `WalletBalanceChanged`), registra (`LOSS`), rejeita (`WagerTransactionRejected`) ou deixa `PENDING_REFERENCE` (`WagerTransactionPendingReference`); `WagerTransactionProcessed` para todo `PROCESSED`.
6. Grava transação, wallet, ledger, outbox, inbox `processed_at`; commit. Violação de unicidade no commit (corrida com outra instância) → refaz a leitura e devolve replay.

- [ ] **Step 1:** Testes HTTP: sem `Idempotency-Key` → 400; BET 25.00 sobre 1000.00 → 200, saldo 975.00; replay → 200, `idempotentReplay: true`, mesmo `balance` mesmo após outra BET mudar o saldo; mesma key, payload diferente → 409; mesmo `(provider, externalId)` com outra key → 409; BET sem saldo → 422 `INSUFFICIENT_FUNDS`, sem ledger; WIN → crédito; LOSS → 200, sem ledger, evento `WagerTransactionProcessed` na outbox e nenhum `WalletBalanceChanged`; REFUND da BET → crédito; segundo REFUND/ROLLBACK da mesma BET → 422 `REFERENCE_ALREADY_REVERSED`; ROLLBACK de WIN com saldo insuficiente → 422 `REVERSAL_INSUFFICIENT_FUNDS`; moeda USD em wallet BRL → 422 `CURRENCY_MISMATCH`; `amount "0.00"` em BET → 400; atomicidade: falha forçada após gravar ledger (hook de teste no repositório de outbox lançando erro) → nada persistido; lock segurado por outra conexão por >5s → 503 `TRANSIENT_FAILURE`; `GET /wagering/transactions/:id` e `GET /providers/:p/wagering/transactions/:ext`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Diário (fase 7) + commit `feat: wager processing use case and HTTP endpoint`.

### Task 8: Worker de referências fora de ordem

**Files:**
- Create: `src/wagering/pending-reference.worker.ts`, `tests/integration/pending-reference.test.ts`

**Interfaces:**
- Consumes: `ProcessWagerUseCase.retryPending`.
- Produces: `PendingReferenceWorker.runOnce(now = new Date()): Promise<number>` (lote de 50 ids `WHERE status='PENDING_REFERENCE' AND next_reference_attempt_at <= now`; cada id em transação própria: trava wallet, depois a transação `FOR UPDATE SKIP LOCKED`), `start()`/`stop()` com intervalo de 500 ms.
- Backoff `min(baseDelayMs * 2^attempts, maxDelayMs)`; esgotou `maxAttempts` (10, ~8,5 min no total) → `REJECTED` `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
- Erro inesperado não transitório ao reprocessar uma pendência 3 vezes seguidas → `FAILED` `INTERNAL_ERROR` (terminal, auditável). Teste: hook de teste que lança na resolução da referência.

- [ ] **Step 1:** Testes: ROLLBACK chega antes da BET → 202 `PENDING_REFERENCE`; BET chega; `runOnce` → ROLLBACK `PROCESSED`, saldo volta ao inicial, 2 lançamentos; referência com mesmo `externalTransactionId` de outro provider não resolve; `maxAttempts` esgotado (config de teste `maxAttempts: 2`, `baseDelayMs: 1`) → `REJECTED REFERENCE_NOT_FOUND` + evento; dois workers simultâneos não processam a mesma pendência duas vezes.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Diário (fase 8) + commit `feat: pending reference worker with backoff`.

### Task 9: Outbox publisher

**Files:**
- Create: `src/messaging/sqs.ts`, `src/messaging/outbox.repository.ts`, `src/messaging/outbox-publisher.worker.ts`, `tests/support/sqs.ts`, `tests/integration/outbox-publisher.test.ts`

**Interfaces:**
- Produces: `SqsGateway { send(queue, body, {groupId, dedupId}); receive(queue, max, waitSeconds, visibility?); delete(queue, receiptHandle); changeVisibility(queue, receiptHandle, seconds); queueUrl(name) }`.
- Produces: `OutboxPublisher.runOnce(now = new Date()): Promise<number>` — numa transação: `SELECT … WHERE published_at IS NULL AND next_attempt_at <= now ORDER BY occurred_at LIMIT 50 FOR UPDATE SKIP LOCKED`, envia para `wager-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`), `markPublished` ou `scheduleRetry`, commit. `start()`/`stop()` com intervalo de 200 ms.
- Produces (testes): `purgeQueues()`, `drainQueue(name): Promise<object[]>`.

- [ ] **Step 1:** Testes: 20 eventos + dois publishers em paralelo → todos com `published_at`, cada `eventId` chega ao menos uma vez e nenhum fica pendente; crash depois do commit financeiro e antes de publicar (app com `ROLE_OUTBOX=false` processa; outro publisher publica) → evento chega; publisher que envia e “morre” antes do commit (gateway de teste lança após `send`) → transação desfeita, próximo ciclo republica, `eventId` igual (duplicata segura); SQS indisponível (endpoint inválido) → `attempts` sobe e `next_attempt_at` avança.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Diário (fase 9) + commit `feat: transactional outbox publisher`.

### Task 10: Consumer SQS

**Files:**
- Create: `src/messaging/wager-consumer.ts`, `tests/integration/wager-consumer.test.ts`

**Interfaces:**
- Consumes: `ProcessWagerUseCase.execute(cmd, inbox)`, `SqsGateway`.
- Produces: `WagerConsumer.pollOnce(): Promise<number>`, `start()`, `stop(): Promise<void>` (SIGTERM: para de receber, espera as mensagens em andamento até 20 s, devolve visibilidade `0` das não iniciadas).
- Classificação: sucesso, replay ou rejeição de negócio (`REJECTED`, `PENDING_REFERENCE`, wallet inexistente gravada só na inbox) → `delete` após commit; `TransientFailureError`/erro de conexão → `changeVisibility(min(2^receiveCount, 300))`, a redrive policy manda para a DLQ após `maxReceiveCount`; mensagem malformada, `type` desconhecido ou conflito de payload (idempotência ou inbox) → `send` explícito para a DLQ + `delete`.
- Env de teste `FAULT_CRASH_AFTER_COMMIT=true`: `process.exit(137)` entre o commit e o `delete` (só lido pelo consumer; documentado como injeção de falha).

- [ ] **Step 1:** Testes: mensagem válida → transação `PROCESSED`, inbox gravada, fila vazia; mesma mensagem enviada 2× (mesmo `messageId`, dedup ids distintos) → um débito; mesma `messageId` com payload diferente → DLQ; JSON inválido → DLQ; Postgres inacessível para o consumer (URL inválida) → mensagem volta e, após `maxReceiveCount`, aparece na DLQ; `stop()` durante processamento conclui a mensagem em andamento; HTTP e SQS com a mesma `idempotencyKey` → um único efeito.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Diário (fase 10) + commit `feat: SQS consumer with inbox, retry and DLQ`.

### Task 11: Observabilidade

**Files:**
- Create: `src/shared/json-logger.ts`, `src/shared/metrics.ts`, `src/metrics/metrics.controller.ts`, `tests/unit/json-logger.test.ts`, `tests/integration/metrics.test.ts`
- Modify: use case, workers e consumer para registrar métricas e logs.

**Interfaces:**
- Produces: `JsonLogger implements LoggerService` — uma linha JSON por evento `{ts, level, msg, context, ...fields}`; remove chaves `money`, `amount`, `balance`, `payload`, `authorization`.
- Produces: `Metrics` com `wager_transactions_total{kind,status}`, `idempotent_replays_total{source}`, `inbox_duplicates_total`, `sqs_retries_total`, `sqs_dlq_messages_total{reason}`, `lock_conflicts_total`, `outbox_pending_messages`, `outbox_lag_seconds`, `wager_processing_duration_seconds` (histogram), `reconciliation_mismatches_total`; `GET /metrics`.

- [ ] **Step 1:** Testes: logger omite `amount` e mantém `walletId`; após uma BET e um replay, `/metrics` mostra `wager_transactions_total{kind="BET",status="PROCESSED"} 1` e `idempotent_replays_total{source="http"} 1`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS.
- [ ] **Step 5:** Diário (fase 11) + commit `feat: structured logs and metrics`.

### Task 12: Suíte de concorrência (§13, 8 cenários)

**Files:**
- Create: `tests/support/instances.ts`, `tests/support/invariant.ts`, `tests/concurrency/*.test.ts`

**Interfaces:**
- Produces: `startInstances(n: number, env?: Record<string,string>): Promise<Instance[]>` (`Bun.spawn(['bun','src/main.ts'])`, portas 4101+, espera `/health/ready`); `Instance { url; kill(signal?) }`.
- Produces: `assertLedgerInvariant(walletIds: string[])`: para cada wallet, `balance == SUM(credit) - SUM(debit)` e `balance == último balance_after`.

- [ ] **Step 1:** Escrever os 8 testes (`Promise.all` real): (1) mesma BET 50× em paralelo distribuída em 3 instâncias → 1 débito, 49 replays; (2) saldo 100.00, duas BET 80.00 → 1 `PROCESSED`, 1 `REJECTED INSUFFICIENT_FUNDS`, saldo 20.00, 1 débito; (3) 20 wallets × 10 BETs em paralelo → todas corretas; (4) 3 instâncias consumindo a mesma fila com 300 mensagens (inclui duplicatas) → efeitos únicos; (5) consumer com `FAULT_CRASH_AFTER_COMMIT` morre, mensagem reaparece, outra instância processa → 1 débito; (6) dois publishers na mesma outbox (reaproveita Task 9 com processos); (7) ROLLBACK e REFUND antes da referência via SQS → resolvidos pelo worker; (8) `kill -9` em instâncias no meio da carga, reinício, fila drenada → invariante e reconciliação consistentes em todas as wallets. Todos terminam em `assertLedgerInvariant`.
- [ ] **Step 2:** Rodar; os que falharem apontam bug real → corrigir na task de origem.
- [ ] **Step 3:** `bun run test:concurrency` → PASS 3 vezes seguidas (determinismo).
- [ ] **Step 4:** Diário (fase 12) + commit `test: concurrency and crash recovery suite`.

### Task 13: Teste de carga (opcional, só com tempo sobrando)

**Files:** Create `load/load-test.ts`, `docs/LOAD_TEST.md`.

- [ ] `bun run test:load`: N wallets, M requisições concorrentes contra 3 instâncias; registra ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, `lock_conflicts_total` e `outbox_lag_seconds` do `/metrics`. Commit `test: load test`.

### Task 14: Documentação e verificação final

**Files:** Create/finish `README.md`, `docs/ARCHITECTURE.md`, `docs/EVALUATOR_GUIDE.md`, `docs/DIARIO.md`.

- [ ] **Step 1:** `README.md`: o que é, pré-requisitos, `docker compose up`, comandos de teste, exemplos `curl`, como ver métricas e DLQ.
- [ ] **Step 2:** `ARCHITECTURE.md`: camadas, schema e constraints, estratégia transacional e de lock (com trade-off vs optimistic), mapeamento do `Money`, escolha do MikroORM, algoritmo do `payloadHash`, máquina de estados, taxonomia de `failureCode`, mapeamento HTTP, inbox/outbox/SQS/DLQ, decisão de autenticação (Keycloak client-credentials como desenho, `ProviderIdentityPort` como ponto de extensão), interpretações adotadas, limitações conhecidas.
- [ ] **Step 3:** `EVALUATOR_GUIDE.md`: critério → arquivo → teste; checklist das 8 eliminatórias com o teste de cada uma; roteiro de 10 minutos.
- [ ] **Step 4:** Clone limpo → `docker compose up -d --build` → `bun install` → `bun run test` → tudo verde; anotar a saída no guia.
- [ ] **Step 5:** Diário (fase final) + commit `docs: architecture, evaluator guide and diary`.
