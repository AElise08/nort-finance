# Nort Finance WhatsApp Bot

Nort Finance is a WhatsApp bot for personal finance workflows. It connects WhatsApp Web, Supabase, Mistral, and Groq to help users record transactions, track balances, manage recurring expenses, create goals, handle installments, schedule reminders, transcribe audio, inspect receipt/product images, and ask whether a purchase fits their current financial context.

## Features

- WhatsApp onboarding with Supabase Auth account linking.
- Natural-language income and expense capture in Brazilian Portuguese.
- Audio transcription with Groq Whisper.
- Receipt and product image analysis with a multimodal Groq model.
- Purchase decision assistant powered by Mistral and finance context.
- Balance summary, pending transactions, recurring expenses, installments, goals, and reminders.
- PM2 ecosystem file for production process management.

## Tech Stack

- Node.js, CommonJS
- whatsapp-web.js
- Supabase Auth and database
- Mistral API
- Groq API
- node-cron
- PM2 for deployment

## Security Notice

This project needs server-side secrets to run. Never commit real values for SUPABASE_URL, ANON_KEY, SERVICE_KEY, MISTRAL_KEY, or GROQ_KEY. Use .env.example as a template and keep your real .env file private.

The Supabase service role key is highly privileged. Run this bot only in a trusted server environment, keep Row Level Security policies enabled for client-facing apps, and rotate any key that was ever exposed in a public repository, chat, log, or shared terminal output.

The directories .wwebjs_auth/ and .wwebjs_cache/ contain WhatsApp session data and must never be published.

## Requirements

- Node.js 20 or newer recommended.
- Chromium installed on the server at /usr/bin/chromium-browser, or update the Puppeteer executable path in index.js.
- A Supabase project with these tables: profiles, categories, transactions, reminders, recurring_rules, goals, goal_contributions, installment_plans, and installments.
- API keys for Mistral and Groq.

## Setup

1. Install dependencies:

   npm install

2. Create your environment file:

   cp .env.example .env

3. Fill .env with your own credentials.

4. Check syntax:

   npm run check:syntax

5. Start locally or on your server:

   npm start

6. For PM2:

   npm run pm2:start

On the first run, scan the WhatsApp QR code printed in the terminal.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| SUPABASE_URL | Supabase project URL. |
| ANON_KEY | Supabase anon key for password sign-in. |
| SERVICE_KEY | Supabase service role key for privileged server actions. |
| MISTRAL_KEY | Mistral API key for financial parsing and advice. |
| GROQ_KEY | Groq API key for transcription and image analysis. |

## Production Notes

- Use a process manager such as PM2.
- Protect the server and restrict SSH access.
- Keep .env, logs, WhatsApp auth/cache folders, and backups outside Git.
- Rotate provider keys regularly and immediately after accidental exposure.
- Review Supabase permissions carefully before accepting untrusted users.

## License

MIT
