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
