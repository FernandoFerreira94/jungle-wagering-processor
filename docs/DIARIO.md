# Diário de construção

Este diário conta, em linguagem simples, o que foi feito em cada fase e por quê. É para quem quer entender a história do projeto sem ler código. Os detalhes técnicos ficam no [ARCHITECTURE.md](ARCHITECTURE.md).

## Fase 1 — A base da casa

Antes de escrever qualquer regra de negócio, montamos o terreno. O projeto usa exatamente a stack pedida: Bun para rodar e testar, TypeScript no modo mais rigoroso, NestJS como framework, PostgreSQL como banco e uma fila SQS simulada pelo LocalStack, tudo subindo com Docker Compose.

O Compose sobe o banco, a fila e **três cópias do sistema** ao mesmo tempo (portas 3001, 3002 e 3003). Isso é de propósito: o desafio exige que tudo continue certo com várias instâncias, então já nascemos assim. Antes das cópias subirem, um passo separado prepara as tabelas do banco.

As filas são criadas automaticamente: a fila principal de transações, a "fila de problemas" (DLQ), para onde vão mensagens que falharam demais, e uma fila de eventos, para avisar outros sistemas. Os testes usam filas e um banco próprios, separados dos usados pela aplicação, para um nunca sujar o outro.

Cada cópia pode ligar ou desligar suas funções (receber HTTP, ler a fila, publicar eventos, reprocessar pendências) por variável de ambiente. Isso ajuda a simular falhas nos testes.

## Fase 2 — Como o dinheiro é guardado

Dinheiro nunca é guardado como número "quebrado" (aquele tipo de número do computador que faz 0,1 + 0,2 virar 0,30000000004). Aqui cada valor vira **centavos inteiros**, e na entrada e na saída é sempre um texto como `"25.00"`.

O sistema é chato de propósito com o que aceita: `"25.001"`, `"1e3"`, `"-1.00"`, texto vazio ou com espaço são recusados. Nada é arredondado escondido. Também não dá para somar real com dólar: isso dá erro na hora.

Criamos ainda uma "impressão digital" de cada pedido. Os campos importantes são colocados sempre na mesma ordem e passam por um resumo matemático (SHA-256). Se o mesmo pedido chegar de novo, a impressão digital é igual. Se alguém reaproveitar o mesmo identificador com dados diferentes, a impressão digital denuncia.

## Fase 3 — As regras do jogo

Aqui ficam as regras de negócio puras, sem banco e sem framework, como uma "lei" que pode ser testada sozinha.

- **Carteira (wallet):** guarda o saldo e um número de versão que sobe a cada mudança. Ela nunca deixa o saldo ficar negativo e, toda vez que o saldo muda, devolve junto o lançamento do extrato. Não existe mudar saldo sem extrato.
- **Lançamento do extrato (ledger):** nasce pronto e nunca muda. Ele confere a própria conta: saldo antes ± valor = saldo depois. Se a conta não fecha, ele nem é criado.
- **Transação:** é cada pedido do provedor. Ela começa "pendente" e termina em um de três estados finais (processada, rejeitada ou falha). Chegando num estado final, não muda mais.
- **O juiz das regras:** uma função que olha a transação, a carteira e a aposta original (quando é um estorno) e decide: aplicar, só registrar (caso da perda), rejeitar com um motivo, ou esperar a aposta original chegar.

Cada rejeição tem um **código de motivo** fixo (por exemplo `INSUFFICIENT_FUNDS` para aposta sem saldo e `REVERSAL_INSUFFICIENT_FUNDS` para um estorno que deixaria o saldo negativo). Assim o provedor sabe se vale tentar de novo.

Uma decisão nossa: **cada aposta só pode ser estornada uma vez**, seja por reembolso (REFUND) ou por cancelamento (ROLLBACK). O enunciado só proíbe repetir o mesmo tipo, mas permitir os dois daria crédito em dobro, o que ele mesmo proíbe.

## Fase 4 — Caixa de entrada e caixa de saída

Dois conceitos que garantem que nenhuma mensagem se perca nem seja contada duas vezes:

- **Caixa de entrada (inbox):** cada mensagem que chega da fila fica anotada no banco com o seu identificador. Se a mesma mensagem chegar de novo, o sistema vê a anotação e não repete o trabalho.
- **Caixa de saída (outbox):** quando algo importante acontece (aposta processada, saldo mudou, aposta rejeitada, aposta esperando a original), o aviso não é enviado na hora. Ele é **anotado no banco junto com a mudança de saldo**, no mesmo "pacote". Um carteiro separado lê essas anotações depois e envia. Assim nunca sai aviso de algo que não foi salvo, e nada salvo fica sem aviso.

Se o envio falhar, o carteiro espera um pouco mais a cada tentativa (2 s, 4 s, 8 s… até no máximo 1 minuto) e tenta de novo, para não martelar um serviço que está fora do ar. Cada aviso tem um identificador único, então quem recebe consegue ignorar repetições.

## Fase 5 — O banco como última linha de defesa

O desafio pede que as garantias mais importantes estejam **no próprio banco**, não só no código. Assim, mesmo que alguém escreva um código errado (ou mexa direto no banco), o banco recusa. Foi isso que montamos:

- O saldo de uma carteira **não pode ficar negativo**. O banco recusa.
- Só existe **uma carteira por jogador e moeda**.
- O mesmo pedido (mesma chave de idempotência, ou mesmo par provedor + id da transação) **não pode ser gravado duas vezes**.
- O extrato **não pode ser editado, apagado nem esvaziado**. Cada linha confere a própria conta (antes ± valor = depois).
- Na hora de confirmar, o banco confere se **o saldo da carteira é igual à última linha do extrato**. Se não for, nada é salvo.
- Uma aposta **só pode ser estornada uma vez**, mesmo com várias cópias do sistema tentando ao mesmo tempo.
- Uma transação que já terminou (processada, rejeitada ou falha) **não muda mais**, e nenhuma transação é apagada.

A estrutura do banco é criada por uma "migração" versionada, que também sabe se desfazer. Os testes desta fase mexem direto no banco, como um invasor faria, e confirmam que cada regra barra a tentativa.

## Fase 6 — Abrindo as portas: carteiras, consultas e saúde

Agora o sistema conversa com o mundo por HTTP:

- **Criar carteira** (`POST /wallets`). Se ela já nasce com saldo, esse saldo vira uma transação interna de "abertura" com a sua linha no extrato, tudo salvo junto. Tentar criar uma segunda carteira para o mesmo jogador e moeda dá conflito (409).
- **Consultar** a carteira e o extrato. O extrato vem em páginas, com um "marcador" opaco para pedir a próxima página sem pular nem repetir linhas.
- **Conferência (reconciliação):** recalcula o saldo somando o extrato e compara com o saldo guardado. Se divergir, **não corrige escondido**: registra no log, conta numa métrica e avisa na resposta. No teste, "corrompemos" o banco de propósito para provar que isso funciona.
- **Saúde:** `/health/live` diz se o processo está vivo e `/health/ready` diz se o banco e a fila respondem. Esses dois não pedem login.

Os erros seguem um padrão único em todos os endpoints: 400 para pedido malformado, 404 para não encontrado, 409 para conflito, 422 para regra de negócio, 202 para "aceito, esperando" e 503 para "falha temporária, tente de novo". Assim o provedor sabe o que fazer só pelo número.

**Sobre login:** o desafio diz que autenticação não vale pontos e que, se feita, deve usar um provedor de identidade externo (como o Keycloak). Decidimos **não implementar agora** e deixar uma "tomada" pronta no código (`ProviderAuthGuard` + `ProviderIdentityPort`), com o desenho completo documentado. Isso mantém o foco no que vale nota.

## Fase 7 — O coração: processar cada aposta

Esta é a peça principal. Toda operação (aposta, ganho, perda, reembolso, cancelamento) passa pelo **mesmo caminho**, venha ela pelo HTTP ou pela fila. O caminho é sempre este, dentro de um único "pacote" no banco:

1. **Tranca a carteira.** Enquanto uma operação mexe numa carteira, outra operação da mesma carteira espera a vez (carteiras diferentes andam em paralelo, sem esperar umas pelas outras). Se a espera passar de 5 segundos, o sistema responde "tente de novo" (503) em vez de travar.
2. **Confere se já viu esse pedido.** Mesma chave e mesmo conteúdo: devolve a resposta original, **inclusive o saldo daquele momento**, e marca `idempotentReplay: true`. Mesma chave com conteúdo diferente: conflito (409), nada acontece.
3. **Aplica a regra** da fase 3 e grava, juntos, a transação, o novo saldo, a linha do extrato e os avisos na caixa de saída.

Se qualquer passo falhar no meio, **nada** é salvo. Testamos isso simulando uma pane depois de mexer no saldo e antes de gravar o aviso: o saldo voltou ao que era e o mesmo pedido pôde ser reenviado normalmente.

Se duas cópias do sistema receberem exatamente o mesmo pedido no mesmo instante, a segunda esbarra na regra de unicidade do banco, relê o que a primeira gravou e responde como repetição. Sem débito em dobro.

As respostas seguem o resultado: 200 processada, 422 rejeitada (com o código do motivo), 202 aguardando a aposta original, 409 conflito de chave, 503 falha temporária.

## Fase 8 — Quando o estorno chega antes da aposta

Na vida real, a mensagem de "cancele a aposta X" às vezes chega **antes** da própria aposta X. O sistema não descarta nem aplica no escuro: guarda o estorno como **"aguardando a aposta original"** (resposta 202) e avisa por evento.

Um ajudante (worker) passa de tempos em tempos e tenta de novo. Cada nova tentativa espera o dobro da anterior (1 s, 2 s, 4 s… até 1 minuto entre tentativas). Quando a aposta original chega, o estorno é aplicado normalmente. Se ela nunca chegar, depois de 10 tentativas (uns 5 minutos) o estorno é **rejeitado** com o motivo `REFERENCE_NOT_FOUND`, e isso também gera evento. Esse limite dá margem para atrasos normais de fila sem deixar pendências eternas.

Detalhes que testamos:
- A busca da aposta original é sempre **do mesmo provedor**. Um id igual vindo de outro provedor não serve.
- Várias cópias do ajudante rodando juntas aplicam o estorno **uma única vez**.
- Se der um erro permanente ao reprocessar, a transação vai para **FAILED**: estado final, auditável, que não some.

## Fase 9 — O carteiro dos avisos (outbox publisher)

O carteiro lê os avisos anotados na caixa de saída e os entrega na fila de eventos (`wager-events.fifo`). As regras dele:

- **Só entrega o que já foi salvo.** Como o aviso nasce junto com a mudança de saldo, se o sistema cair logo depois de salvar, o aviso continua lá esperando. Testamos isso: uma cópia do sistema salvou a aposta sem entregar, e **outra cópia** entregou o aviso depois.
- **Vários carteiros ao mesmo tempo não brigam.** Cada um pega um lote diferente (os outros pulam o que já está sendo entregue). Testamos com três carteiros juntos: tudo foi entregue.
- **Se ele cair no meio da entrega**, o lote volta para a pilha e é entregue de novo, **com o mesmo identificador**. Quem recebe reconhece e ignora a repetição. Entregar duas vezes é seguro; perder, nunca.
- **Se a fila estiver fora do ar**, o aviso continua pendente e o carteiro espera cada vez mais antes de tentar de novo.

## Fase 10 — Lendo a fila de apostas (SQS)

Os provedores também podem mandar apostas pela fila `wager-transactions.fifo`. O leitor da fila usa **exatamente o mesmo caminho** do HTTP (fase 7), então as regras valem igual nos dois canais. Se a mesma aposta chegar uma vez pelo HTTP e outra pela fila, ela vale uma vez só.

Como o leitor trata cada mensagem:

- **Deu certo, ou foi recusada por regra de negócio** (sem saldo, por exemplo): confirma o recebimento ("ack") e a mensagem sai da fila. O ack só acontece **depois** que tudo foi salvo.
- **Mensagem repetida:** a caixa de entrada (fase 4) reconhece pelo `messageId` e não repete o débito.
- **Mesmo `messageId` com conteúdo diferente**, JSON quebrado, tipo desconhecido ou carteira inexistente: é erro permanente. Vai direto para a **fila de problemas (DLQ)**, para alguém analisar.
- **Falha temporária** (banco ocupado ou fora do ar): devolve a mensagem para a fila e espera um pouco mais a cada tentativa. Depois de 5 tentativas, a própria fila manda a mensagem para a DLQ.
- **Desligamento (SIGTERM):** para de pegar mensagens novas, termina as que estão em andamento e devolve na hora as que nem começaram.

Mensagens da mesma carteira são tratadas em ordem; carteiras diferentes andam em paralelo. Mesmo assim, a ordem da fila é só uma ajuda: quem garante a correção é o banco.

## Fase 11 — Enxergando o que acontece (logs e métricas)

Um sistema financeiro precisa ser fácil de investigar quando algo dá errado.

- **Logs em JSON**, uma linha por acontecimento, sempre com os identificadores que ligam os pontos: `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Valores de dinheiro, saldos e payloads completos **nunca** vão para o log. Isso é filtrado automaticamente, e um teste garante.
- **Métricas** em `/metrics` (formato Prometheus): transações por tipo e resultado, repetições detectadas, duplicatas da fila, mensagens devolvidas e enviadas para a DLQ, conflitos de trava, avisos pendentes e há quanto tempo o mais antigo espera (o "atraso" da caixa de saída), tempo de processamento e divergências da conferência.
- **Saúde** separada em "vivo" e "pronto", como já descrito na fase 6.

## Fase 12 — Prova de fogo (concorrência e quedas)

Aqui testamos o sistema do jeito que ele vai sofrer na vida real: **três cópias rodando juntas**, todas usando o mesmo banco e a mesma fila, sem nenhum dublê (banco e fila de verdade).

- **A mesma aposta enviada 50 vezes ao mesmo tempo**, espalhada pelas 3 cópias: o saldo foi debitado **uma vez só**. As outras 49 receberam a mesma resposta da primeira.
- **Saldo de 100 e duas apostas de 80 ao mesmo tempo:** uma passa e a outra é recusada por falta de saldo. O saldo nunca ficou negativo.
- **20 carteiras recebendo 10 apostas cada, tudo em paralelo:** uma carteira não atrapalha a outra e todos os saldos fecharam certos.
- **300 mensagens na fila** (150 apostas, cada uma enviada duas vezes) com as 3 cópias lendo: cada aposta foi aplicada uma vez só.
- **Três carteiros entregando avisos ao mesmo tempo:** todo aviso salvo foi entregue na fila de eventos.
- **Cancelamentos (REFUND e ROLLBACK) chegando antes da aposta original:** ficaram esperando, e quando a aposta chegou foram resolvidos sozinhos. O saldo voltou ao valor inicial.
- **A mesma aposta pelo HTTP e pela fila** (já testado na fase 10): vale uma vez.
- **Queda entre salvar e confirmar a mensagem:** forçamos uma cópia a "morrer" logo depois de salvar e antes de avisar a fila. A fila entregou a mensagem de novo para outra cópia, que reconheceu e **não debitou duas vezes**.
- **Derrubada brutal (kill -9) no meio do trabalho:** com 15 carteiras e 210 apostas em andamento, matamos duas cópias e subimos outras duas. No final, todas as apostas existiam uma vez só, todo saldo batia com o extrato, a conferência deu "consistente" e todos os avisos da caixa de saída foram entregues.

Rodamos esses testes várias vezes seguidas para garantir que não passaram "por sorte".

## Fase 13 — Teste de carga

Colocamos o sistema sob pressão por 30 segundos: 48 clientes mandando apostas sem parar para as 3 cópias, com 20% delas mirando uma única carteira "disputada" e 10% sendo reenvios repetidos.

- Cerca de **225 apostas por segundo**, **nenhum erro**, e no final todo saldo batia com o extrato.
- A carteira disputada deixa as respostas mais lentas na ponta (algumas passam de 1 segundo), porque as apostas nela entram em fila, uma de cada vez. É o preço de nunca errar o saldo.
- O teste achou um gargalo: o carteiro dos avisos (fase 9) estava lento e os avisos chegavam a esperar 28 segundos. Ajustamos para ele trabalhar em paralelo e não dormir quando há serviço. Caiu para cerca de 10 segundos. Nenhum aviso se perde; eles só chegam um pouco depois.

Os detalhes e números estão em `docs/LOAD_TEST.md`.
