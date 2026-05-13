## Nort Finance WhatsApp Bot

Bot de WhatsApp para finanças pessoais. Ele conversa com a pessoa pelo WhatsApp, registra gastos e receitas, mostra saldo, agenda lembretes, controla despesas fixas, metas e compras parceladas, transcreve áudio, lê imagens de comprovantes/produtos e usa IA para responder se uma compra cabe no orçamento.

Este projeto foi pensado para rodar em uma VPS ou servidor. Ele usa WhatsApp Web por QR Code, Supabase como banco/autenticação, Mistral para interpretar textos financeiros e Groq para áudio/imagem.

## O que o bot faz

- Cria ou vincula uma conta pelo WhatsApp.
- Registra frases como "gastei 45 no mercado" ou "recebi 800 de freela".
- Mostra saldo do mês, pendências, fixas, metas e parceladas.
- Agenda lembretes como "me lembra amanhã às 9h de pagar o aluguel".
- Transcreve áudio enviado no WhatsApp.
- Analisa foto de comprovante ou produto.
- Responde perguntas como "posso comprar isso por R$ 600?" usando o contexto financeiro da pessoa.

## Antes de começar

Você vai precisar criar contas/serviços em quatro lugares:

1. Uma VPS ou servidor Linux, por exemplo Ubuntu.
2. Um projeto no Supabase.
3. Uma chave da Mistral.
4. Uma chave da Groq.

Também precisa de um número de WhatsApp que será usado pelo bot. Na primeira execução, o terminal mostra um QR Code. Você escaneia esse QR Code com o WhatsApp, como no WhatsApp Web.

## Aviso de segurança

Nunca publique o arquivo `.env`. Ele guarda chaves privadas.

Nunca publique estas pastas:

- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `logs/`
- `node_modules/`

A chave `SERVICE_KEY` do Supabase é muito poderosa. Quem tiver essa chave pode acessar dados do projeto. Use somente em servidor confiável e troque a chave imediatamente se ela aparecer em GitHub, print, chat, log ou terminal compartilhado.

## 1. Preparar a VPS

Entre na sua VPS por SSH:

```bash
ssh root@SEU_IP_DA_VPS
```

Atualize o servidor:

```bash
apt update && apt upgrade -y
```

Instale Node.js, Git, Chromium e PM2:

```bash
apt install -y git curl chromium-browser
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2
```

Confira se instalou:

```bash
node -v
npm -v
pm2 -v
```

## 2. Baixar o projeto

Clone este repositório na VPS:

```bash
git clone https://github.com/AElise08/nort-finance.git
cd nort-finance
```

Instale as dependências:

```bash
npm install
```

## 3. Criar o projeto no Supabase

1. Acesse https://supabase.com.
2. Crie um projeto novo.
3. Vá em Project Settings > API.
4. Copie estes valores:
   - Project URL
   - anon public key
   - service_role key

Esses valores serão usados no arquivo `.env`.

### Tabelas esperadas

O código espera que seu Supabase tenha estas tabelas:

- `profiles`
- `categories`
- `transactions`
- `reminders`
- `recurring_rules`
- `goals`
- `goal_contributions`
- `installment_plans`
- `installments`

Este repositório ainda não inclui um arquivo SQL pronto com o schema. Antes de rodar em produção, você precisa criar essas tabelas no Supabase com as colunas usadas pelo código. Procure no arquivo `index.js` pelos nomes das tabelas para ver os campos usados em cada uma.

## 4. Criar as chaves de IA

### Mistral

1. Acesse https://console.mistral.ai.
2. Crie uma API key.
3. Guarde o valor para `MISTRAL_KEY`.

### Groq

1. Acesse https://console.groq.com.
2. Crie uma API key.
3. Guarde o valor para `GROQ_KEY`.

## 5. Configurar o arquivo .env

Crie o arquivo `.env` a partir do exemplo:

```bash
cp .env.example .env
nano .env
```

Preencha assim, usando os seus próprios valores:

```env
SUPABASE_URL=https://seu-projeto.supabase.co
ANON_KEY=sua_anon_key_do_supabase
SERVICE_KEY=sua_service_role_key_do_supabase
MISTRAL_KEY=sua_chave_da_mistral
GROQ_KEY=sua_chave_da_groq
```

Salve no nano com `CTRL + O`, aperte Enter, e saia com `CTRL + X`.

Confirme que o arquivo `.env` não será enviado para o GitHub:

```bash
git check-ignore -v .env
```

Se aparecer uma linha citando `.gitignore`, está certo.

## 6. Testar antes de ligar o bot

Confira se o JavaScript está válido:

```bash
npm run check:syntax
```

Se não aparecer erro, rode o bot:

```bash
npm start
```

Na primeira execução, vai aparecer um QR Code no terminal. Abra o WhatsApp no celular e vá em:

Aparelhos conectados > Conectar aparelho

Escaneie o QR Code. Quando conectar, o terminal deve mostrar que o Nort Finance está online.

Para parar o bot no terminal, use `CTRL + C`.

## 7. Rodar em produção com PM2

Depois que o teste funcionar, rode com PM2:

```bash
npm run pm2:start
```

Ver status:

```bash
pm2 status
```

Ver logs:

```bash
pm2 logs nort-finance
```

Reiniciar:

```bash
pm2 restart nort-finance
```

Parar:

```bash
pm2 stop nort-finance
```

Fazer o bot voltar sozinho se a VPS reiniciar:

```bash
pm2 save
pm2 startup
```

O comando `pm2 startup` vai imprimir outro comando grande. Copie e execute esse comando também.

## Como usar no WhatsApp

Depois de conectado, mande uma mensagem para o número do bot. Ele vai perguntar se você já tem conta ou se quer criar.

Exemplos de mensagens:

```text
gastei 45 no mercado
recebi 800 de freela
uber 18 ontem
me lembra amanhã às 9h de pagar aluguel
quero juntar R$ 2000 para viagem
contribui 100 pra meta viagem
posso comprar um celular por R$ 1800?
```

Você também pode enviar áudio ou foto de comprovante/produto.

## Variáveis de ambiente

| Variável | Para que serve |
| --- | --- |
| `SUPABASE_URL` | URL do seu projeto Supabase. |
| `ANON_KEY` | Chave pública anon do Supabase, usada no login. |
| `SERVICE_KEY` | Chave service role do Supabase, usada pelo servidor para ações privilegiadas. |
| `MISTRAL_KEY` | Chave da Mistral para interpretar textos e gerar respostas financeiras. |
| `GROQ_KEY` | Chave da Groq para transcrever áudio e analisar imagem. |

## Problemas comuns

### O QR Code não aparece

Confira se as dependências foram instaladas:

```bash
npm install
```

Confira se o Chromium existe no caminho usado pelo projeto:

```bash
which chromium-browser
```

Se o comando não encontrar nada, instale o Chromium ou ajuste `executablePath` no arquivo `index.js`.

### O bot diz que faltam variáveis de ambiente

Abra o `.env` e confira se todos os campos foram preenchidos:

```bash
nano .env
```

### O bot conecta mas não salva dados

Verifique se as tabelas existem no Supabase e se a `SERVICE_KEY` está correta.

### O bot parou depois de um tempo

Veja os logs:

```bash
pm2 logs nort-finance
```

Reinicie:

```bash
pm2 restart nort-finance
```

## Checklist antes de publicar mudanças

Antes de dar commit ou push, rode:

```bash
git status --ignored
npm run check:syntax
```

Confirme que `.env`, `.wwebjs_auth/`, `.wwebjs_cache/`, `logs/` e `node_modules/` aparecem como ignorados.

## Licença

MIT
