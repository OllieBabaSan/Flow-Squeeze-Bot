# Flow/Squeeze Alerts

Standalone Node.js monitor for evidence-based Flow and Squeeze Pressure alerts.
It polls Bybit and Hyperliquid perpetual markets, validates price movement with
turnover and open-interest data, verifies token identity, posts qualified alerts
to Discord, and follows Squeeze Pressure through confirmation or invalidation.
It also monitors Binance, OKX, and Bitget contracts that overlap Hyperliquid and
writes qualified signals from those venues to the canonical history as passive
`SHADOW` observations. Shadow observations do not post to Discord. Binance is a
primary paper-strategy source; OKX and Bitget are passive source benchmarks.

This package contains no X ingestion, news ingestion, editorial model,
Directional Pressure Bot, trading, wallet, or exchange-order functionality. It
does not import files or read runtime state from another bot.

## Install

Requirements: Node.js 22.13 or newer.

```powershell
npm install
Copy-Item .env.example .env.local
notepad .env.local
npm test
npm run dry-run
```

Add the Discord webhook to `.env.local`, then run `npm start`. The process owns
its files under `data/`: state, lock, log, alert ledger, outcomes, and the
versioned `flow-alert-history.jsonl` signal stream consumed by the optional
Flow/Squeeze Automation product.

`npm run dry-run` performs one market scan without publishing to Discord.

## Alert meaning

- Bullish Flow: rising price with new open-interest participation.
- Bearish Flow: falling price with new open-interest participation.
- Bullish Squeeze Pressure: crowded shorts are being resisted as price rises.
- Bearish Squeeze Pressure: crowded longs are being resisted as price falls.

Squeeze Pressure is not called a confirmed squeeze until follow-up evidence
supports covering or forced liquidations while price continues against the
crowded side.

## Security

Never commit `.env.local`, webhook URLs, API keys, logs, or runtime state. This
bot requires no exchange credentials, wallet seed phrase, or private key.
