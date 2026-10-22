# Como testar na sua máquina

Este roteiro é para quem nunca rodou o projeto. Você só precisa do **Docker** instalado; não é preciso instalar Bun, Node nem banco de dados.

## Como o sistema funciona, em 1 minuto

Pense numa **casa de apostas que atende vários jogos ao mesmo tempo**.

- Cada **jogador** tem uma **carteira** com saldo.
- Os **jogos** (os "provedores") avisam o sistema do que aconteceu: o jogador **apostou** (BET, tira dinheiro), **ganhou** (WIN, põe dinheiro), **perdeu** (LOSS, não mexe no saldo), ou a aposta foi **cancelada** (REFUND ou ROLLBACK, devolve).
- Esses avisos chegam por dois caminhos: **direto pela API** (HTTP) ou **por uma fila de mensagens** (SQS).
- O sistema roda em **3 cópias ao mesmo tempo**, como numa empresa de verdade. Qualquer cópia pode receber qualquer aviso.

O difícil, e o que o desafio avalia, é que no mundo real os avisos chegam **repetidos**, **fora de ordem** e **ao mesmo tempo**. Mesmo assim o sistema nunca pode:

- cobrar duas vezes a mesma aposta;
- deixar o saldo negativo;
- perder dinheiro de vista: todo centavo fica num **extrato** que não pode ser apagado, e o saldo sempre bate com ele.

## Passo 1: instalar o Docker

Baixe e instale o **Docker Desktop**: https://www.docker.com/products/docker-desktop/. Depois de instalar, abra o programa e espere ele dizer que está rodando.

## Passo 2: baixar o projeto

Num terminal (no Windows, o PowerShell):

```bash
git clone https://github.com/FernandoFerreira94/jungle-wagering-processor.git
cd jungle-wagering-processor
```

Sem git, baixe o .zip pelo botão **Code → Download ZIP** no GitHub, descompacte e abra o terminal dentro da pasta.

## Passo 3: ligar tudo

```bash
docker compose up -d --build
```

Na primeira vez demora alguns minutos, porque baixa o banco, a fila e monta o sistema. Esse comando sobe:

- o **banco de dados** (PostgreSQL);
- a **fila de mensagens** (LocalStack, um "SQS de mentira" que roda local);
- as **3 cópias do sistema**, nas portas 3001, 3002 e 3003.

Para conferir se está no ar, abra no navegador: http://localhost:3001/health/ready. Deve aparecer `"status":"ok"`.

## Passo 4: ver funcionando

```bash
docker compose exec app-1 bun scripts/demo.ts
```

O roteiro conversa com as 3 cópias e mostra, passo a passo, com ✔ verde:

1. cria a carteira de um jogador com R$ 100,00;
2. faz uma aposta de R$ 25,00;
3. repete a mesma aposta, como se a internet do jogo tivesse falhado, e mostra que **não cobra duas vezes**;
4. manda duas apostas de R$ 60,00 **ao mesmo tempo** em cópias diferentes, com só R$ 75,00 de saldo, e mostra que **só uma passa**;
5. registra uma vitória de R$ 40,00;
6. manda um cancelamento **antes** da aposta que ele cancela: o sistema espera a aposta chegar e então aplica o cancelamento sozinho;
7. manda uma aposta **pela fila, duas vezes**, e ela é cobrada uma vez só;
8. mostra o **extrato** e confere que o saldo bate com ele.

O resultado esperado termina com **"Tudo certo."**

## Passo 5: testar com uma tela (opcional)

Existe uma tela simples para você brincar com o sistema. Ela **não faz parte da entrega**: fica na pasta `playground/` e só sobe se você pedir.

```bash
docker compose --profile playground up -d
```

Abra http://localhost:8080 no navegador. Na tela você pode:

- criar uma carteira e ver o **saldo** e o **extrato** se atualizando sozinhos;
- mandar apostas, vitórias, derrotas e cancelamentos, escolhendo **qual das 3 cópias** recebe;
- clicar em **"Repetir a última"** para simular o provedor reenviando, e ver que não cobra de novo;
- usar os **cenários prontos**: duas apostas ao mesmo tempo, a mesma aposta 20 vezes em paralelo, cancelamento antes da aposta, mensagem duplicada na fila e mesma chave com valor diferente;
- clicar em **"Conferir saldo × extrato"**.

Cada resposta aparece em "O que aconteceu", explicada em português (verde: aplicada; amarelo: esperando; vermelho: recusada, com o motivo).

## Passo 6 (opcional): ver por dentro

- **O que cada cópia está fazendo:** `docker compose logs -f app-1 app-2 app-3`. Cada linha é um acontecimento, em JSON, sem valores de dinheiro.
- **Números do sistema:** http://localhost:3001/metrics (quantas apostas, repetições detectadas, mensagens com problema etc.).
- **Rodar os testes automáticos** (precisa do Bun instalado: https://bun.sh):
  ```bash
  bun install
  bun run test
  ```
  São mais de 160 testes, incluindo derrubar cópias do sistema no meio do trabalho.

## Passo 7: desligar

```bash
docker compose --profile playground down   # desliga tudo, inclusive a tela
docker compose down -v     # desliga e apaga os dados do banco
```

## Se algo der errado

- **"port is already allocated":** outra coisa no seu computador usa a porta 5432, 4566 ou 3001–3003. Feche o programa que usa a porta (por exemplo, um PostgreSQL instalado) e rode o passo 3 de novo.
- **"Cannot connect to the Docker daemon":** o Docker Desktop não está aberto.
- **O roteiro mostra ✘:** rode `docker compose logs app-1 --tail 50` e me mande o resultado.
