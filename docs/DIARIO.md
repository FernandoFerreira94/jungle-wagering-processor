# Diário de construção

Este diário conta, em linguagem simples, o que foi feito em cada fase e por quê. É para quem quer entender a história do projeto sem ler código. Os detalhes técnicos ficam no [ARCHITECTURE.md](ARCHITECTURE.md).

## Fase 1 — A base da casa

Antes de escrever qualquer regra de negócio, montamos o terreno. O projeto usa exatamente a stack pedida: Bun para rodar e testar, TypeScript no modo mais rigoroso, NestJS como framework, PostgreSQL como banco e uma fila SQS simulada pelo LocalStack, tudo subindo com Docker Compose.

O Compose sobe o banco, a fila e **três cópias do sistema** ao mesmo tempo (portas 3001, 3002 e 3003). Isso é de propósito: o desafio exige que tudo continue certo com várias instâncias, então já nascemos assim. Antes das cópias subirem, um passo separado prepara as tabelas do banco.

As filas são criadas automaticamente: a fila principal de transações, a "fila de problemas" (DLQ), para onde vão mensagens que falharam demais, e uma fila de eventos, para avisar outros sistemas. Os testes usam filas e um banco próprios, separados dos usados pela aplicação, para um nunca sujar o outro.

Cada cópia pode ligar ou desligar suas funções (receber HTTP, ler a fila, publicar eventos, reprocessar pendências) por variável de ambiente. Isso ajuda a simular falhas nos testes.
