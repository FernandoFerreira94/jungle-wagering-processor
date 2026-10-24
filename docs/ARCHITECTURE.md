# Arquitetura e decisões

Este documento registra **o que foi decidido, por quê e o que custa**. As seções citadas como §N são do enunciado ([`CHALLENGE.md`](CHALLENGE.md)).

## 1. Princípio central

**O PostgreSQL é a única fonte de garantia.** Cada operação financeira roda em **uma transação SQL** que:

1. trava a linha da wallet;
2. aplica a regra de domínio;
3. grava a transação, o lançamento no ledger, o novo saldo, o registro de inbox e os eventos de outbox;
4. confirma tudo junto.

Fila FIFO, deduplicação do SQS e ordem de entrega ajudam, mas não são garantia (§5.3, §8). Se o código da aplicação errar, constraints e triggers no schema são a última barreira (§5.9).

## 2. Camadas e módulos

```
HTTP (controllers) ─┐
SQS (WagerConsumer) ─┼─► ProcessWagerUseCase ─► domínio puro (Wallet, WagerTransaction, decideWager, Money)
Worker de pendências ┘          │
                                └─► repositórios (MikroORM EntityManager) ─► PostgreSQL
OutboxPublisher (worker) ─► outbox_messages ─► SQS wager-events.fifo
```

| Pasta | Responsabilidade |
|---|---|
| `src/shared` | `Money`, erros, JSON canônico, logger, métricas, validação |
| `src/wallet` | aggregate `Wallet`, `WalletLedgerEntry`, API de wallets e reconciliação |
| `src/wagering` | `WagerTransaction`, regras (`decideWager`), use case, worker de pendências, API |
| `src/messaging` | inbox, outbox, eventos de integração, gateway SQS, consumer, publisher |
| `src/database` | records do MikroORM (`EntitySchema`), migration, transação, erros do Postgres |
| `src/auth` | ponto de extensão de autenticação (`ProviderIdentityPort`, `ProviderAuthGuard`) |

**O domínio não importa NestJS nem MikroORM** (§6.0). As classes de domínio têm construtor `private`, nascem por `create`/`open` (que validam) e voltam do banco por `rehydrate` (que não revalida). O mapeamento domínio ↔ banco fica nos repositórios, com records separados (`src/database/entities.ts`). O domínio é testado sem I/O, e o ORM não vaza para as regras.

**Um único caminho de escrita.** HTTP, SQS e o worker de pendências chamam o mesmo `ProcessWagerUseCase`. As regras são as mesmas nos dois canais, e a mesma operação pelos dois canais tem um efeito só (teste `HTTP and SQS with the same idempotency key have a single effect`).

**Instâncias iguais, papéis por variável de ambiente.** Toda instância pode rodar HTTP, consumer, outbox publisher e worker de pendências (`ROLE_*`). No Compose as três rodam tudo, o que prova que o desenho funciona com N cópias de cada papel.

## 3. Por que MikroORM

O enunciado prefere MikroORM, e ele resolve o que este problema precisa:

- `em.transactional()` / `fork()`: uma transação explícita por operação, com o `EntityManager` isolado por requisição.
- `LockMode.PESSIMISTIC_WRITE`: gera `SELECT … FOR UPDATE` sem SQL manual.
- `EntitySchema`: mapeia classes simples (records) sem decorators. O domínio fica livre do ORM.
- Migrator com SQL explícito: constraints, índices parciais e triggers ficam visíveis e revisáveis na migration.

**Trade-off:** não uso o Unit of Work para as entidades de domínio. Os repositórios fazem `insert`/`nativeUpdate` explícitos. Perco o "flush automático", mas cada escrita fica visível no código, e o update da wallet pode ser condicionado à versão (seção 5).

## 4. Dinheiro (`Money`)

| Onde | Representação |
|---|---|
| Domínio | `bigint` em centavos + moeda (`Money`, imutável, construtor privado) |
| API e eventos | `{ "amount": "25.00", "currency": "BRL" }`, sempre string com 2 casas |
| Banco | `NUMERIC(20,2)` + `CHAR(3)`; o MikroORM lê e escreve `decimal` como **string** |

- `Money.from` aceita só `^\d+(\.\d{1,2})?$` e moeda `^[A-Z]{3}$`. Ele rejeita `NaN`, `Infinity`, notação científica, espaços, vazio, negativo e mais de 2 casas. **Nunca arredonda**: um valor que precisaria de arredondamento é inválido.
- Nenhum `number` toca dinheiro, nem na leitura do banco: a string do `NUMERIC` vira `bigint` por `Money.fromDecimal`.
- Contratos e saldo são limitados a `999999999999999999.99`, compatível com `NUMERIC(20,2)`. Totais internos do ledger podem ser maiores; crédito que excederia o limite é rejeitado com `BALANCE_LIMIT_EXCEEDED`, sem efeito financeiro.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`. A wallet tem uma moeda, e um jogador pode ter uma wallet por moeda (`UNIQUE(player_id, currency)`).

## 5. Concorrência e transações

**Estratégia: lock pessimista por wallet + update condicionado pela versão.**

1. Cada operação abre uma transação com `SET LOCAL lock_timeout = 5s` (`LOCK_TIMEOUT_MS`).
2. `SELECT … FROM wallets WHERE id = ? FOR UPDATE` trava **só aquela wallet**. Wallets diferentes andam em paralelo, e não existe lock global (§5.6).
3. Com a linha travada, a idempotência é checada, a regra é aplicada em memória e o saldo é gravado com `UPDATE … WHERE id = ? AND version = ?`. Se `affected ≠ 1`, a transação aborta. Isso não deveria acontecer com o lock, mas é defesa em profundidade contra *lost update*.
4. Commit.

**Por que pessimista e não otimista?** O enunciado tem uma *hot wallet* como cenário obrigatório (duas apostas no mesmo saldo).

- Com lock otimista, quem perde a corrida precisa refazer tudo. Sob disputa isso vira tempestade de retries, e o perdedor pode esgotar as tentativas e devolver erro mesmo havendo saldo.
- Com lock pessimista, as operações da mesma wallet fazem **fila** no banco e todas terminam com uma resposta definitiva. Uma wallet é de um jogador e recebe poucas operações por segundo, então serializar por wallet custa pouco.
- **Custo:** latência na cauda quando uma wallet é muito disputada (ver [`LOAD_TEST.md`](LOAD_TEST.md): p99 dobra com 20% da carga numa wallet só). O `lock_timeout` limita a espera: estourou, a resposta é `503 TRANSIENT_FAILURE`, segura para reenviar com a mesma chave.

**Ordem de lock fixa (wallet → transação)** em todos os caminhos, inclusive no worker de pendências. Assim não há deadlock entre o caminho principal e o worker.

**Corridas que o lock não cobre.** Duas instâncias podem tentar inserir a mesma operação em wallets diferentes (payload adulterado) ou a mesma reversão. As constraints únicas resolvem: quem perde recebe violação de unicidade (`uq_wager_idempotency_key`, `uq_wager_provider_external`, `ux_wager_single_reversal`). O use case refaz a transação **uma vez**, e a segunda leitura encontra o que a outra instância gravou, devolvendo replay ou rejeição (`withRaceRetry`).

## 6. Schema: garantias no banco (§5.9)

| Garantia | Como |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `CHECK (balance_after >= 0)` no ledger |
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Idempotência persistente | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única por referência | índice único parcial `ux_wager_single_reversal (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| Um lançamento por transação | `UNIQUE (transaction_id)` no ledger |
| Aritmética do ledger | `CHECK` por direção: `balance_after = balance_before ± amount`; `amount > 0` |
| Ledger append-only | triggers `BEFORE UPDATE OR DELETE` (linha) e `BEFORE TRUNCATE` (statement) que lançam exceção |
| Saldo = ledger | constraint trigger `DEFERRABLE INITIALLY DEFERRED` em `wallets`: no commit, `balance` precisa ser igual ao `balance_after` do último lançamento |
| Inserções diretas no ledger | migration `20261024000000`: lock por wallet, continuidade de `balance_before`, sequência crescente e mesma moeda; trigger diferido também no ledger exige saldo correspondente no commit |
| Estado terminal imutável | trigger em `wager_transactions`: bloqueia `DELETE`, mudança de campos de negócio e qualquer mudança em linha `PROCESSED`/`REJECTED`/`FAILED` |
| Coerência de status | `CHECK` de `kind`/`status`; `failure_code` presente se e só se `REJECTED`/`FAILED`; `processed_at` em estados terminais; reversão exige referência; valor > 0 (exceto `LOSS`, que aceita 0) |
| Inbox | `PRIMARY KEY (consumer_name, message_id)` |

Índices de apoio: ledger por `(wallet_id, seq)` para paginação, pendências por `next_reference_attempt_at` (parcial) e outbox por `next_attempt_at WHERE published_at IS NULL` (parcial).

Todas as garantias têm teste em `tests/integration/schema.test.ts`, executando SQL direto, "por fora" da aplicação.

**Paginação do ledger** usa `seq BIGSERIAL` como cursor (base64url de `{s: seq}`). É estável sob inserção concorrente, ao contrário de offset.

## 7. Idempotência

- **Chave:** header `Idempotency-Key` no HTTP, ou `data.idempotencyKey` na mensagem SQS. É obrigatória e tem até 255 caracteres.
- **`payloadHash`:** SHA-256 (hex) do **JSON canônico** (chaves ordenadas recursivamente, campos ausentes omitidos) dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (já normalizado, `"25.5"` vira `"25.50"`) e `referenceExternalTransactionId`. A chave e os metadados de transporte não entram (§9).
- **Mesma chave e mesmo hash:** replay. Devolve **o resultado original**, inclusive o saldo observado naquele momento (`result_balance`, §7.7), com `idempotentReplay: true`.
- Em rejeição por moeda, o saldo observado é reidratado na moeda da wallet, inclusive em consulta/replay; a moeda da operação rejeitada continua preservada separadamente.
- **Mesma chave e hash diferente**, ou mesmo `(providerId, externalTransactionId)` com outra chave: `409 IDEMPOTENCY_CONFLICT`, sem efeito.
- Tudo é verificado **dentro da transação, com a wallet travada**, e garantido pelas constraints únicas. Não há cache em memória (§5.2).

## 8. Máquina de estados de `WagerTransaction`

```
PENDING ──► PROCESSED
   │──────► REJECTED
   │──────► FAILED
   └──────► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

- `PENDING` existe só em memória, durante a transação SQL. Nenhuma linha é confirmada nesse estado.
- Estados terminais (`PROCESSED`, `REJECTED`, `FAILED`) são imutáveis: o domínio lança `InvalidTransactionStateError` e o trigger do banco recusa.
- `REJECTED` e `FAILED` sempre têm `failureCode`. `REJECTED` não altera saldo nem gera ledger (§7.6).

### Referências fora de ordem (§7.1)

- `REFUND`/`ROLLBACK` (ou `WIN`/`LOSS` com referência) cuja referência ainda não existe vira `PENDING_REFERENCE` e responde `202`.
- O worker de pendências roda em toda instância a cada 500 ms. Ele busca as pendências vencidas e reprocessa cada uma na sua própria transação, travando a wallet e depois a transação. Se outra instância já resolveu, ela é ignorada.
- **Backoff:** `min(1000 ms × 2^tentativa, 60 s)`, até **10 tentativas** (cerca de 4 minutos no total). **Por quê:** na prática a referência atrasa por segundos (a mensagem da BET está logo atrás na fila ou num retry). Alguns minutos cobrem atrasos e retries do SQS com folga, sem deixar o provedor sem resposta por muito tempo. Os valores são configuráveis.
- **Limite esgotado:** `REJECTED` com `REFERENCE_NOT_FOUND`, e o evento `WagerTransactionRejected` é publicado.
- Depois dos locks, o use case confere novamente `nextReferenceAttemptAt`: um lote antigo de outra instância não consome tentativas antes da hora.
- **Erro permanente inesperado** ao reprocessar (bug ou dado corrompido): `FAILED` com `INTERNAL_ERROR`, de imediato. É terminal e auditável, e não fica girando para sempre. Erro transitório só adia a tentativa.
- O evento `WagerTransactionPendingReference` sai só na **primeira** vez que a transação fica pendente, não a cada nova tentativa.

## 9. Regras de negócio e interpretações adotadas

A tabela de §7 está em `src/wagering/wager-rules.ts` (`decideWager`, função pura), com um teste por linha em `tests/unit/wager-rules.test.ts`.

Interpretações que o enunciado deixa abertas:

1. **Uma referência pode ser revertida uma única vez no total, por `REFUND` ou por `ROLLBACK`.** O enunciado proíbe reverter duas vezes "pelo mesmo tipo". Permitir `REFUND` + `ROLLBACK` da mesma `BET` creditaria o valor duas vezes, o que fere o invariante de "nenhum crédito duplicado". A segunda reversão é rejeitada com `REFERENCE_ALREADY_REVERSED`. Isso é garantido também pelo índice `ux_wager_single_reversal`.
2. **`WIN`/`LOSS` podem trazer referência opcional.** Se trazem, ela precisa resolver para uma `BET` do mesmo provider, player, wallet, moeda e rodada. Se ainda não chegou, a transação espera como qualquer outra.
3. **`LOSS` aceita valor `0.00`** (registra o resultado da rodada sem valor). As demais operações exigem valor > 0.
4. **`ROLLBACK` de `WIN`** debita. Se isso deixaria o saldo negativo, a resposta é `REVERSAL_INSUFFICIENT_FUNDS`, código distinto de `INSUFFICIENT_FUNDS` (§7.9).
5. **Reversão de referência `REJECTED`/`FAILED`:** `REFERENCE_NOT_PROCESSED`. Referência em `PENDING_REFERENCE`: a reversão também espera.
6. **Saldo inicial da wallet** gera uma transação interna `OPENING` (provider `internal`, chave `internal:opening:{walletId}`) com o crédito no ledger. Assim o invariante "saldo = ledger" vale desde o primeiro centavo. `OPENING` não pode ser enviado de fora (400).
7. **Wallet inexistente:** HTTP `404`. Pelo SQS a mensagem vai para a DLQ (motivo `wallet_not_found`): não há onde aplicar nem registrar a operação, e alguém precisa olhar.
8. **Moeda diferente da wallet:** `REJECTED` com `CURRENCY_MISMATCH`, auditável, sem efeito. **Wallet de outro player:** `WALLET_PLAYER_MISMATCH`.

## 10. Taxonomia de `failureCode`

`retryable = true` significa que o provedor pode tentar de novo **com uma nova chave**, depois que a condição mudar. Reenviar com a mesma chave sempre devolve o resultado original.

| Código | Quando | Retryable |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | sim |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão (ex.: `ROLLBACK` de `WIN`) deixaria saldo negativo | sim |
| `BALANCE_LIMIT_EXCEEDED` | crédito excederia o maior saldo suportado | sim |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet | não |
| `WALLET_PLAYER_MISMATCH` | wallet não pertence ao player | não |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite de espera | não |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo da referência não pode ser revertido por esta operação (ex.: `REFUND` de `WIN`) | não |
| `REFERENCE_MISMATCH` | referência de outro player, wallet, moeda ou rodada | não |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência (reversão parcial fora de escopo) | não |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada ou falhou | não |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | não |
| `INTERNAL_ERROR` | falha permanente ao reprocessar uma pendência (`FAILED`) | não |

Fonte única: `src/wagering/failure-code.ts`.

## 11. Mapeamento HTTP

O mesmo mapeamento vale em todos os endpoints (`HttpExceptionFilter`). Cada situação que muda a decisão do provedor tem um status próprio (§9):

| Situação | Status | O provedor deve… |
|---|---|---|
| Processada ou replay | 200 | seguir |
| Wallet criada | 201 | seguir |
| `PENDING_REFERENCE` | 202 | consultar depois ou aguardar o evento |
| Payload inválido | 400 `VALIDATION_ERROR` | corrigir, não reenviar igual |
| Não encontrado | 404 | corrigir |
| Conflito de idempotência / wallet já existe | 409 | não reenviar; investigar |
| Rejeição de negócio | 422 + `failureCode` | decidir pelo código |
| Falha transitória (lock timeout, banco ou fila fora) | 503 `TRANSIENT_FAILURE` + `Retry-After: 1` | reenviar com a **mesma** chave |
| `FAILED` ou erro inesperado | 500 | escalar |

## 12. Mensageria

### Consumer SQS (§10)

- Long polling em `wager-transactions.fifo`. Mensagens de grupos diferentes são processadas em paralelo, e as do mesmo grupo em ordem.
- **Inbox** `(consumer_name, message_id)` gravada com `INSERT … ON CONFLICT DO NOTHING` **na mesma transação** do efeito financeiro. Se a mensagem já existe com o mesmo conteúdo (hash do `data`), é replay. Com conteúdo diferente, é erro permanente.
- **Ack (`DeleteMessage`) só depois do commit.** Se o processo morre entre o commit e o ack, a mensagem volta. A inbox e a idempotência garantem que não há segundo efeito. Isso é provado com uma queda real (`FAULT_CRASH_AFTER_COMMIT`).

| Tipo de erro | Exemplos | Ação |
|---|---|---|
| Negócio (terminal) | `REJECTED`, `PENDING_REFERENCE` | ack |
| Transitório | lock timeout, conexão, serialização | `ChangeMessageVisibility` com backoff `min(2 s × 2^(n−1), 300 s)`; após `maxReceiveCount = 5` a redrive policy move para a DLQ |
| Permanente | JSON inválido, `type` desconhecido, validação, conflito de idempotência, `messageId` com outro conteúdo, wallet inexistente | envio explícito para a DLQ + delete, sem gastar retries |

- **SIGTERM:** para de buscar mensagens, espera as que estão em andamento terminarem e devolve as que nem começaram com visibilidade 0, para outra instância pegar na hora. O Compose dá 30 s de *grace period*.
- `MessageGroupId = walletId` na entrada: a ordem FIFO por wallet reduz disputa de lock, mas a correção não depende dela.

### Transactional outbox (§11)

- Eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são gravados em `outbox_messages` **na mesma transação** da mudança. Não existe publicação antes do commit (§5.4).
- O publisher roda em toda instância. Cada ciclo abre uma transação, pega até 50 eventos vencidos com `FOR UPDATE SKIP LOCKED` (cada publisher pega um lote diferente), publica em `wager-events.fifo` e marca `published_at`.
- Grupos (`aggregateId`) diferentes são publicados em paralelo e cada grupo em ordem. Se um evento falha, ele e os seguintes do mesmo grupo esperam juntos, com backoff `min(1 s × 2^attempts, 60 s)`. Se havia trabalho, o próximo ciclo começa na hora.
- **Entrega at-least-once:** se o publisher morre depois de enviar e antes do commit, o lote volta e é reenviado **com o mesmo `eventId`**. `MessageDeduplicationId = eventId` deduplica no SQS por 5 minutos, e depois disso o consumidor deve deduplicar por `eventId`. Nunca há perda; pode haver duplicata segura.
- `data` dos eventos carrega `MoneyProps` (string), nunca `Money` (§11).

## 13. Autenticação (§2): desenho, não implementação

**Decisão:** não implementar agora. Autenticação não pontua e competiria com correção, concorrência e idempotência. O ponto de extensão está no código:

- `ProviderIdentityPort.authenticate(headers): Promise<ProviderIdentity | null>`;
- `ProviderAuthGuard` aplicado aos controllers de negócio (wallets e wagering), **nunca** ao health;
- adaptador atual: `NoopProviderIdentity`, que aceita tudo.

**Desenho que eu adotaria:**

- **Keycloak** no Compose, um *client* por provedor com **client credentials** (OAuth2, máquina-a-máquina).
- Um `KeycloakProviderIdentity` validaria o JWT (assinatura via JWKS em cache, `iss`, `aud`, `exp`) e extrairia o `providerId` de uma claim (ex.: `azp` ou claim própria).
- O use case passaria a exigir que `command.providerId === identity.providerId`. Um provedor não pode enviar operações em nome de outro, e isso vira `403`.
- Mensagens SQS são canal interno confiável (§2), mas o `providerId` delas continua passando pelas mesmas validações de domínio.
- Health e `/metrics` ficam abertos na rede interna.

## 14. Observabilidade (§12)

- **Logs JSON** (`JsonLogger`): uma linha por evento com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Chaves sensíveis (`money`, `amount`, `balance`, `payload`, `data`, `authorization`, `password`, `token`) são removidas automaticamente, inclusive em objetos aninhados. O `correlationId` vem do header `x-correlation-id` (ou é gerado) e, no SQS, é o `messageId`.
- Exceções carregam somente classe e código seguro nos logs. `Error.message` é omitido porque o driver pode incluir SQL interpolado e payloads financeiros.
- **Métricas Prometheus** em `/metrics`: contadores por tipo e status, replays, duplicatas de inbox, retries e DLQ por motivo, conflitos de lock (`lock_timeout`, `unique_race`), tamanho e atraso da outbox, histograma de latência por canal e divergências de reconciliação.
- **Health:** `/health/live` (processo) e `/health/ready` (Postgres e SQS respondem).
- **Reconciliação:** `POST /wallets/:id/reconciliation` lê saldo e ledger sob `FOR SHARE` e compara. Divergência gera log `error`, métrica e `consistent: false`, **sem correção automática**: corrigir dinheiro é decisão humana.

## 15. Testes

| Nível | O que prova | Infra |
|---|---|---|
| Unidade (`tests/unit`) | `Money`, invariantes da wallet, regras por tipo, estados, hash, eventos, logger | nenhuma |
| Integração (`tests/integration`) | constraints e triggers, atomicidade, API, inbox e redelivery, publishers concorrentes, retry e DLQ, pendências, métricas | Postgres e LocalStack reais |
| Concorrência (`tests/concurrency`) | os 8 cenários de §13 com **3 processos reais**, inclusive `SIGKILL` no meio da carga | Postgres e LocalStack reais |

Todo teste de concorrência termina conferindo `wallet.balance == créditos − débitos == último balance_after` e que a cadeia do ledger não tem buracos. A suíte de concorrência passou 5 vezes seguidas sem falha.

## 16. Limitações conhecidas e próximos passos

- **Autenticação** é só o ponto de extensão (seção 13).
- **Hot wallet:** o lock serializa operações da mesma wallet. É correto, mas a latência na cauda cresce com a disputa. Se um caso real exigir mais vazão numa wallet, o próximo passo seria agrupar operações por wallet num único consumidor (o FIFO já agrupa por `walletId`), não trocar o lock.
- **Outbox sob carga:** cerca de 10 s de atraso a ~450 eventos/s no ambiente de teste. Próximo passo: `SendMessageBatch` (10 por chamada).
- **Retenção:** `inbox_messages` e linhas publicadas de `outbox_messages` crescem para sempre. Em produção, um job apagaria inbox mais antiga que a janela máxima de redelivery e outbox publicada há mais de N dias. O ledger nunca é apagado.
- **Ordem dos eventos de saída** é por agregado e "melhor esforço" sob falha. O consumidor deve usar `eventId` para deduplicar e `occurredAt` (ou `walletVersion`, em `WalletBalanceChanged`) para ordenar.
- **DLQ:** não há ferramenta de reprocessamento (*redrive*). Hoje isso seria feito manualmente pelo console ou CLI do SQS, depois de corrigir a causa.
- **Reversão parcial** está fora de escopo (§7.5).
- **LocalStack** não reproduz latência e limites do SQS real.
- **Um único Postgres:** é o limite de escala vertical. Particionar por `walletId` seria o caminho, e o desenho (lock por wallet, nada global) já permite.
