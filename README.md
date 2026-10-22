# Distributed Wagering Processor

Serviço que processa operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de vários provedores sobre wallets de jogadores. Ele continua correto com mensagens **duplicadas**, **fora de ordem** e **concorrentes**, em **várias instâncias**.

- Stack: Bun, TypeScript strict, NestJS 11, MikroORM 6, PostgreSQL 16, SQS (LocalStack 3.8), Docker Compose.
- Decisões, trade-offs e limitações: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- Roteiro para avaliar, com cada critério ligado ao código e ao teste: [`docs/EVALUATOR_GUIDE.md`](docs/EVALUATOR_GUIDE.md).
- Teste de carga: [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md).
- Diário do desenvolvimento, fase por fase e em linguagem simples: [`docs/DIARIO.md`](docs/DIARIO.md).

## Pré-requisitos

- Docker com Docker Compose.
- Bun ≥ 1.4, só para rodar os testes fora do Docker (o `bun.lock` usa o formato do 1.4).

## Subir tudo

```bash
docker compose up -d --build
```

O Compose sobe:

- **postgres:** banco `wagering` (aplicação) e `wagering_test` (testes).
- **localstack:** SQS com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`, mais as cópias `test-*` para os testes.
- **migrate:** aplica as migrations e termina.
- **app-1, app-2, app-3:** três instâncias do serviço nas portas **3001, 3002 e 3003**. Todas rodam HTTP, consumer SQS, outbox publisher e o worker de referências pendentes.

```bash
curl -s localhost:3001/health/ready
```

## Testes

```bash
docker compose up -d postgres localstack   # basta a infraestrutura
bun install
bun run typecheck
bun run test              # unidade + integração + concorrência
bun run test:unit         # domínio puro (sem I/O)
bun run test:integration  # Postgres e LocalStack reais
bun run test:concurrency  # 3 processos reais, quedas com SIGKILL
bun run test:load         # opcional; ver docs/LOAD_TEST.md
```

Os testes usam o banco `wagering_test` e as filas `test-*`, nunca os da aplicação. Nenhum teste de integração ou de concorrência usa mock de Postgres ou SQS.

Para ver os logs das instâncias durante os testes: `TEST_LOG=1 bun run test:concurrency`.

Migrations à mão: `bun run migration:up` e `bun run migration:down` (usam `DATABASE_URL`).

## Exemplos

```bash
API=localhost:3001

# Criar wallet com saldo inicial (gera uma transação OPENING e um crédito no ledger)
PLAYER=$(uuidgen)
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" | jq -r .id)

# BET de 25.00
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"$PLAYER\",
       \"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",
       \"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# → 200 {"status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false,...}

# Reenviar o mesmo comando → 200 com "idempotentReplay": true e o mesmo saldo, sem novo débito.

# ROLLBACK da BET
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:tx-2' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-2\",\"playerId\":\"$PLAYER\",
       \"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",
       \"kind\":\"ROLLBACK\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"},
       \"referenceExternalTransactionId\":\"tx-1\"}"

# Consultas
curl -s $API/wallets/$WALLET
curl -s "$API/wallets/$WALLET/ledger?limit=50"           # paginado; use nextCursor
curl -s $API/providers/provider-a/wagering/transactions/tx-1
curl -s -X POST $API/wallets/$WALLET/reconciliation      # saldo gravado vs ledger
```

### Pela fila

A mensagem segue o envelope do enunciado. `MessageGroupId` = `walletId`.

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id "$(uuidgen)" \
  --message-body "{\"messageId\":\"msg-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-10-22T12:00:00Z\",
    \"data\":{\"idempotencyKey\":\"provider-a:tx-3\",\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-3\",
    \"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-2\",\"gameId\":\"fortune-chimp\",
    \"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"
```

## Status HTTP

| Situação | Status | Corpo |
|---|---|---|
| Processada ou replay | 200 | `status`, `balance`, `idempotentReplay` |
| Wallet criada | 201 | |
| Aguardando referência (`PENDING_REFERENCE`) | 202 | |
| Payload inválido / sem `Idempotency-Key` | 400 | `error: VALIDATION_ERROR`, `details` |
| Wallet ou transação inexistente | 404 | `error: NOT_FOUND` |
| Mesma chave com payload diferente | 409 | `error: IDEMPOTENCY_CONFLICT` |
| Wallet já existe para player+moeda | 409 | `error: WALLET_ALREADY_EXISTS` |
| Rejeitada por regra de negócio | 422 | `status: REJECTED`, `failureCode` |
| Falha transitória (lock, banco fora) | 503 | `error: TRANSIENT_FAILURE`, header `Retry-After: 1` |
| Falha permanente (`FAILED`) ou inesperada | 500 | |

A lista de `failureCode` está em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#taxonomia-de-failurecode).

## Observabilidade

- **Logs:** JSON, uma linha por evento, com `correlationId` (header `x-correlation-id`, gerado se ausente), `messageId`, `transactionId`, `walletId` e `providerId`. Valores financeiros e payloads não são logados.
- **Métricas:** `GET /metrics` (Prometheus). As principais são `wager_transactions_total{kind,status}`, `idempotent_replays_total`, `inbox_duplicates_total`, `sqs_retries_total`, `sqs_dlq_messages_total{reason}`, `lock_conflicts_total{type}`, `outbox_pending_messages`, `outbox_lag_seconds`, `wager_processing_duration_seconds` e `reconciliation_mismatches_total`.
- **Health:** `GET /health/live` (processo vivo) e `GET /health/ready` (Postgres e SQS acessíveis).

### Inspecionar a DLQ

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --max-number-of-messages 10 --attribute-names All --message-attribute-names All
```

Há dois caminhos até a DLQ. Um erro permanente (JSON inválido, tipo desconhecido, payload conflitante) é enviado pelo próprio consumer, com o motivo no log `message sent to DLQ` e na métrica `sqs_dlq_messages_total{reason}`. Uma falha transitória que esgota `maxReceiveCount` (5) chega pela redrive policy do SQS.

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | Postgres |
| `AWS_ENDPOINT_URL`, `AWS_REGION` | `http://localhost:4566`, `us-east-1` | SQS |
| `QUEUE_PREFIX` | vazio | Prefixo das filas (`test-` nos testes) |
| `ROLE_HTTP`, `ROLE_CONSUMER`, `ROLE_OUTBOX`, `ROLE_PENDING_WORKER` | `true` | Liga ou desliga cada papel na instância |
| `LOCK_TIMEOUT_MS` | `5000` | `lock_timeout` de cada transação |
| `SQS_VISIBILITY_SECONDS`, `SQS_RETRY_BASE_SECONDS` | `30`, `2` | Visibilidade e backoff do consumer |
| `PENDING_REFERENCE_MAX_ATTEMPTS`, `_BASE_DELAY_MS`, `_MAX_DELAY_MS` | `10`, `1000`, `60000` | Espera por referência fora de ordem |
| `LOG_LEVEL` | `info` | |
| `FAULT_CRASH_AFTER_COMMIT` | `false` | **Só para teste**: derruba o processo entre o commit e o ack |
