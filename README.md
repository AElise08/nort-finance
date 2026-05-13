# Nort Finance WhatsApp Bot

WhatsApp bot for personal finance tracking. It records expenses and income, checks monthly balance, schedules reminders, tracks goals and installments, transcribes audio, reads receipt/product images, and uses AI to answer whether a purchase fits the user's budget.

## Why this project matters

Nort Finance is a practical backend/product project: it connects WhatsApp automation, Supabase persistence, scheduled jobs, AI interpretation, audio transcription, and image understanding into one finance assistant.

## Tech stack

- Node.js
- WhatsApp Web client with QR code login
- Supabase
- Mistral AI for financial text interpretation
- Groq for audio/image workflows
- `node-cron` for reminders and scheduled routines
- PM2 for production process management

## Features

- Create or link a user account through WhatsApp.
- Record natural-language messages like "gastei 45 no mercado" or "recebi 800 de freela".
- Show monthly balance, pending items, recurring expenses, goals, and installments.
- Schedule reminders from text messages.
- Transcribe WhatsApp audio messages.
- Analyze photos of receipts or products.
- Answer purchase decisions using the user's financial context.

## Technical highlights

- Built a conversational finance workflow outside a traditional web UI.
- Integrated multiple AI providers for text, audio, and image use cases.
- Designed the project for VPS deployment with PM2.
- Documented security risks around Supabase service keys and WhatsApp session folders.

## Security notes

Never publish `.env` or local WhatsApp session/cache folders.

Do not commit:

```txt
.env
.wwebjs_auth/
.wwebjs_cache/
logs/
node_modules/
```

The Supabase `SERVICE_KEY` is privileged. Rotate it immediately if it appears in GitHub, logs, screenshots, chats, or shared terminals.

## Environment variables

```env
SUPABASE_URL=https://your-project.supabase.co
ANON_KEY=your_supabase_anon_key
SERVICE_KEY=your_supabase_service_role_key
MISTRAL_KEY=your_mistral_key
GROQ_KEY=your_groq_key
```

## Getting started

```bash
git clone https://github.com/AElise08/nort-finance.git
cd nort-finance
npm install
npm run check:syntax
npm start
```

On first run, the terminal displays a QR code. Scan it with WhatsApp using:

```txt
Linked devices > Link a device
```

## Production with PM2

```bash
npm run pm2:start
pm2 status
pm2 logs nort-finance
pm2 save
pm2 startup
```

## Example messages

```txt
gastei 45 no mercado
recebi 800 de freela
uber 18 ontem
me lembra amanha as 9h de pagar aluguel
quero juntar R$ 2000 para viagem
contribui 100 pra meta viagem
posso comprar um celular por R$ 1800?
```

## Supabase tables

The code expects finance-related tables such as:

```txt
profiles
categories
transactions
reminders
recurring_rules
goals
goal_contributions
installment_plans
installments
```

This public version does not include a production-ready SQL schema yet.

## License

MIT
