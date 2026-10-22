# Teste de carga

```bash
docker compose up -d postgres localstack
bun run test:load            # padrão: 30 s, 48 clientes, 3 instâncias
LOAD_HOT_SHARE=0 bun run test:load
```

Variáveis: `LOAD_DURATION_S`, `LOAD_CONCURRENCY`, `LOAD_WALLETS`, `LOAD_HOT_SHARE`, `LOAD_DUP_SHARE`, `LOAD_INSTANCES`.

## Ambiente

- Container Linux, 4 vCPU, 15 GB RAM. Tudo na mesma máquina: as 3 instâncias, o gerador de carga, o PostgreSQL 16 e o LocalStack 3.8 (Docker).
- Bun 1.4.2, pool de 10 conexões por instância.
- Banco limpo a cada execução (migrations aplicadas do zero).

Como tudo divide a mesma CPU, os números são **relativos**: servem para comparar cenários e achar gargalos, não para prometer capacidade de produção.

## Metodologia

- 3 processos reais do serviço (`bun src/main.ts`), todos com todos os papéis (HTTP, consumer, outbox, pending worker).
- Carga em **loop fechado**: N clientes, cada um manda a próxima requisição assim que recebe a resposta, por um tempo fixo. Cada requisição vai para uma instância aleatória.
- Mistura: 70% `BET` de 1.00 e 30% `WIN` de 0.50, em 100 wallets "frias" com saldo de 100000.00.
- **Hot wallet:** `LOAD_HOT_SHARE` das requisições novas vão para uma única wallet disputada.
- **Duplicatas:** `LOAD_DUP_SHARE` das requisições reenviam uma transação já aceita (mesma idempotency key), simulando retry do provedor.
- Latência medida no cliente, da chamada até a resposta completa.
- O atraso da outbox (idade do evento não publicado mais antigo) é amostrado a cada 500 ms direto no banco.
- No final: espera a outbox esvaziar e confere `wallet.balance == créditos − débitos do ledger` em todas as wallets.

## Resultados

| Cenário | Requisições | Throughput | p50 | p95 | p99 | Erros | Atraso máx. da outbox | Invariante |
|---|---|---|---|---|---|---|---|---|
| 20% hot wallet, 10% duplicatas, 30 s | 6 808 | 225 req/s | 128 ms | 805 ms | 1 214 ms | 0% | 11 s | OK |
| sem hot wallet, 10% duplicatas, 20 s | 5 654 | 281 req/s | 158 ms | 341 ms | 424 ms | 0% | — | OK |

- Todas as respostas foram `200`, incluindo cerca de 680 replays idempotentes (`idempotent_replays_total`).
- `lock_conflicts_total` ficou em zero: nenhuma espera de lock passou do `lock_timeout` (5 s) e nenhuma corrida terminou em violação de unicidade.

## Análise

**A hot wallet domina a cauda da latência.** Com 20% da carga em uma só wallet, cerca de 10 requisições ficam na fila do `SELECT … FOR UPDATE` daquela linha ao mesmo tempo. Por isso o p95 e o p99 dobram em relação ao cenário sem hot wallet. É o custo esperado do lock pessimista: a wallet disputada é **serializada** e fica correta, sem retry nem `409`. As outras wallets não são afetadas. Num cenário real de jogo, uma wallet é de um jogador e raramente recebe mais que algumas operações por segundo.

**O gargalo encontrado foi a outbox, e foi corrigido.** Na primeira execução, a outbox chegou a 28 s de atraso. O publisher enviava um evento por vez e dormia 200 ms entre lotes, mesmo com fila cheia. Mudamos duas coisas:

1. Publicar grupos (`aggregateId`) diferentes em paralelo, mantendo a ordem dentro de cada grupo.
2. Se o lote veio com trabalho, buscar o próximo lote na hora.

O atraso caiu para cerca de 10 s e a outbox esvazia logo depois que a carga para. Com 2 eventos por transação, o sistema gera cerca de 450 eventos/s, e o LocalStack responde cada `SendMessage` em alguns milissegundos na mesma CPU sobrecarregada.

**Próximo passo, se for preciso:** usar `SendMessageBatch` (10 por chamada) no publisher. Não fizemos agora porque a correção não depende disso: o evento nunca se perde, só atrasa, e o atraso é visível na métrica `outbox_lag_seconds`.

## Limitações do experimento

- O gerador de carga roda na mesma máquina que o serviço e disputa CPU com ele.
- O LocalStack não reproduz a latência nem os limites do SQS real.
- A carga foi só HTTP. O consumo da fila foi exercitado nos testes de concorrência (300 mensagens com duplicatas), não aqui.
