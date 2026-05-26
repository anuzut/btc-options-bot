# BTC Options Bot — 100% Free

Monitors BTC/USD options conditions for Delta Exchange India.
Sends Telegram alerts when entry conditions align.
Runs on GitHub Actions — no server, no cost, forever free.

## What It Does
- Checks every 5 minutes automatically
- Fetches: BTC price, RSI 4H, ATR, Funding Rate, Deribit DVOL/IVR
- Computes: 2SD strike levels, spread widths, delta estimates
- Determines: Iron Condor / Bull Put Spread / Bear Call Spread
- Sends: Full Telegram alert with strikes, DTE, entry/exit levels

## Alerts Logic
- ENTER TRADE → Telegram sent immediately every time
- WAIT/AVOID → Telegram sent once per hour + on manual trigger
- Bot error → Telegram sent with error details

## Setup (one time, 10 minutes)

### 1. Create GitHub repo
- Go to github.com → New repository
- Name: btc-options-bot
- Public ✓ (required for free Actions minutes)
- Upload these 3 files: bot.js, .github/workflows/monitor.yml

### 2. Add Secrets
- Go to repo → Settings → Secrets and variables → Actions
- Add secret: TELEGRAM_TOKEN = your bot token
- Add secret: CHAT_ID = your chat id

### 3. Enable Actions
- Go to repo → Actions tab → Enable workflows

### 4. Test it
- Actions tab → BTC Options Monitor → Run workflow
- Check your Telegram within 30 seconds

## Data Sources (all free)
- Binance REST API — BTC price, RSI, ATR (no key needed)
- Binance Futures API — Funding rate (no key needed)  
- Deribit Public API — DVOL volatility index (no key needed)

## No paid APIs used. No credit card. Free forever.
