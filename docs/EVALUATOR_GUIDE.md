# Guia do avaliador

Este guia liga cada critério do enunciado ao código e ao teste que o prova. Decisões e trade-offs estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Roteiro de 10 minutos

1. **Subir e rodar tudo (3 min)**
   ```bash
   docker compose up -d --build
   bun install && bun run typecheck && bun run test
   ```
2. **Ver o invariante no banco (2 min):** `src/database/migrations/Migration20261022000000.ts`. Constraints, índice de reversão única, triggers append-only e o constraint trigger "saldo = ledger".
3. **Ver o caminho de escrita (3 min):** `src/wagering/process-wager.use-case.ts`, método `process`: inbox → lock da wallet → idempotência → `decideWager` → ledger + wallet + outbox, numa transação.
4. **Ver a prova de fogo (2 min):** `tests/concurrency/crash-recovery.test.ts`. Uma instância morre entre o commit e o ack; depois, duas instâncias levam `SIGKILL` no meio de 210 apostas e o sistema termina consistente.

## Falhas eliminatórias

| Eliminatória | Por que não acontece | Prova |
|---|---|---|
| `number` para dinheiro | `Money` usa `bigint` em centavos; contratos usam string; banco usa `NUMERIC(20,2)` lido como string | `tests/unit/money.test.ts`; `grep -rnE "parseFloat\|toFixed" src` não encontra nada. Os `Number(...)` restantes em `src` são contagens e limites, nunca valores |
| Saldo negativo por race | lock por wallet + `CHECK (balance >= 0)` + `CHECK (balance_after >= 0)` | concorrência §2 (`two 80.00 BETs on a 100.00 wallet`); `schema.test.ts › wallet balance can never be negative` |
| Débito ou crédito duplicado | `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`, `UNIQUE(transaction_id)` no ledger, inbox, `ux_wager_single_reversal` | concorrência §1 (`50 times in parallel`), §4 (300 mensagens), §5 (crash após commit), §8 (`kill -9`) |
| Idempotência só em memória | toda checagem é no banco, dentro da transação | `schema.test.ts › the same idempotency key or provider transaction cannot be stored twice`; concorrência §1 com 3 processos |
| Correto só com uma instância | nada depende de estado em memória; workers usam `SKIP LOCKED` | toda a suíte `tests/concurrency` roda **3 processos reais** |
| Evento publicado antes do commit | evento só existe como linha da outbox gravada na mesma transação | `outbox-publisher.test.ts › events committed by one instance are published by another`; `wagering-api.test.ts › a failure in the middle rolls back transaction, ledger, wallet and outbox together` |
| Sem ledger auditável | ledger append-only por trigger; um lançamento por transação; reconciliação | `schema.test.ts › ledger rows cannot be updated, deleted or truncated`; `wallet-api.test.ts › reconciliation …` |
| Mocks de Postgres/SQS | integração e concorrência usam Postgres 16 e LocalStack reais | `tests/support/db.ts`, `tests/support/sqs.ts`, `tests/support/instances.ts` |

## Critérios de avaliação → código → teste

### Correção financeira (20)

| Item | Código | Teste |
|---|---|---|
| `Money` (escala, entradas inválidas, moeda) | `src/shared/money.ts` | `tests/unit/money.test.ts` |
| Invariantes da wallet | `src/wallet/wallet.ts` | `tests/unit/wallet.test.ts` |
| Regras de BET/WIN/LOSS/REFUND/ROLLBACK | `src/wagering/wager-rules.ts` | `tests/unit/wager-rules.test.ts` (uma linha da tabela de §7 por teste); `tests/integration/wagering-api.test.ts` |
| Reversão com código próprio (§7.9) | `FailureCode.ReversalInsufficientFunds` | `wagering-api.test.ts › ROLLBACK of a WIN that would make the balance negative…` |
| Replay devolve o saldo da época (§7.7) | coluna `result_balance` | `wagering-api.test.ts › a replay returns the original result, including the balance seen at that time` |
| Ledger e saldo sempre iguais | constraint trigger `trg_wallet_balance_matches_ledger` | `schema.test.ts › wallet balance must match the last ledger entry at commit time`; `tests/support/invariant.ts` em todo teste de concorrência |
| Reconciliação | `src/wallet/wallet.service.ts › reconcile` | `wallet-api.test.ts › reconciliation flags a divergence and does not fix it` |

### Concorrência (20)

Os 8 cenários de §13 estão em `tests/concurrency/`, com 3 instâncias reais:

| §13 | Teste |
|---|---|
| 1. mesma aposta 50× | `concurrency.test.ts › 1.` |
| 2. disputa de saldo (cenário de §8) | `concurrency.test.ts › 2.` (repetido em 10 wallets) |
| 3. wallets distintas em paralelo | `concurrency.test.ts › 3.` |
| 4. ≥ 3 instâncias | `concurrency.test.ts › 4.` (300 mensagens com duplicatas) e a suíte inteira |
| 5. morto após commit, antes do ack | `crash-recovery.test.ts › 5.` (`FAULT_CRASH_AFTER_COMMIT`, exit 137) |
| 6. publishers na mesma outbox | `concurrency.test.ts › 6.` (3 processos) e `outbox-publisher.test.ts › two publishers…` |
| 7. REFUND/ROLLBACK antes da referência | `concurrency.test.ts › 7.` |
| 8. reinício com consistência final | `crash-recovery.test.ts › 8.` (`SIGKILL` em 2 de 3 instâncias no meio da carga) |

Estratégia de lock e o motivo da escolha: [`ARCHITECTURE.md` §5](ARCHITECTURE.md#5-concorrência-e-transações).

### Idempotência (15)

| Item | Teste |
|---|---|
| Dedup persistente | `schema.test.ts › the same idempotency key…`; concorrência §1 |
| Replay | `wagering-api.test.ts › a replay returns the original result…` |
| Payload conflitante | `wagering-api.test.ts › same key with a different payload is a conflict…`, `› same provider transaction under another key…`; `tests/unit/wager-command.test.ts` |
| HTTP + SQS, mesma chave | `wager-consumer.test.ts › HTTP and SQS with the same idempotency key have a single effect` |

### Mensageria e falhas (15)

| Item | Teste |
|---|---|
| Inbox e redelivery | `wager-consumer.test.ts › the same message delivered twice debits once`, `› a reused messageId with a different payload goes to the DLQ` |
| Retry e DLQ | `wager-consumer.test.ts › a transient failure returns the message; after maxReceiveCount it lands in the DLQ`, `› malformed messages…`, `› a message for a wallet that does not exist…` |
| Erro de negócio = ack | `wager-consumer.test.ts › a business rejection is acknowledged…` |
| Outbox: crash antes de publicar | `outbox-publisher.test.ts › events committed by one instance are published by another` |
| Outbox: crash depois de enviar | `outbox-publisher.test.ts › a publisher that dies after sending and before committing is safe…` |
| SQS fora do ar | `outbox-publisher.test.ts › when SQS is down…` |
| Shutdown (SIGTERM) | `wager-consumer.test.ts › stop() lets the message in progress finish before returning` |
| Recuperação após reinício | `crash-recovery.test.ts › 5.` e `› 8.` |
| Referência fora de ordem | `pending-reference.test.ts` (espera, limite, outro provider, dois workers, erro permanente) |

### Modelagem e arquitetura (10)

- Domínio sem framework: `src/wallet/wallet.ts`, `src/wagering/wager-transaction.ts`, `src/wagering/wager-rules.ts`, `src/shared/money.ts`. Nenhum import de NestJS ou MikroORM.
- Records do ORM separados do domínio: `src/database/entities.ts` e o mapeamento nos repositórios.
- Portas: `ProviderIdentityPort` (auth) e `SqsGateway`.
- Um único use case para HTTP, SQS e worker.

### Testes (10)

```
bun run test:unit
bun run test:integration
bun run test:concurrency
```

### Observabilidade (5)

- Logs: `src/shared/json-logger.ts`; teste `tests/unit/json-logger.test.ts` (campos de correlação presentes, dinheiro e payload removidos, inclusive aninhados).
- Métricas: `src/shared/metrics.ts`, `GET /metrics`; teste `tests/integration/metrics.test.ts`.
- Health: `src/health/health.controller.ts`; teste `wallet-api.test.ts › health endpoints are open`.

### Documentação (5)

- [`README.md`](../README.md): setup, comandos, exemplos, status HTTP, métricas, DLQ.
- [`ARCHITECTURE.md`](ARCHITECTURE.md): decisões, trade-offs e limitações.
- [`LOAD_TEST.md`](LOAD_TEST.md): diferencial opcional, com ambiente, metodologia e análise.
- [`DIARIO.md`](DIARIO.md): diário do desenvolvimento, fase por fase.

## Verificação atual (24/10/2026)

- Bun 1.4.4: 108 testes de unidade passaram, sem falhas; `bun run typecheck` passou.
- Com PostgreSQL 16 e LocalStack reais: **62 testes de integração** e **8 de concorrência** passaram, sem falhas. O comando completo `bun run test` terminou com sucesso: **178 testes**.
- `docker compose up -d --build` passou; a migration adicional `20261024000000` foi aplicada. O teste de migrations reversíveis também passou.
- Readiness nas portas 3001, 3002 e 3003: PostgreSQL e SQS `up` nas três instâncias reconstruídas.
- `docker compose exec -T app-1 bun scripts/demo.ts` passou todos os passos, incluindo replay entre instâncias, disputa de saldo, referência fora de ordem, duplicata pela fila e reconciliação final.
- As regressões cobrem moeda do saldo em replay (inclusive player incorreto), limite monetário, isolamento dos recursos de teste, logs sem SQL financeiro, backoff concorrente e proteção da cadeia do ledger.
- Esta validação é local. O teste de carga opcional não foi repetido nesta revisão; os números em `LOAD_TEST.md` pertencem ao experimento anterior.
