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
crowded side. Exhaustion requires a reversal that persists for several minutes;
a single early giveback does not close a confirmed squeeze.

When `COINMARKETCAP_API_KEY` is configured, each Squeeze Pressure candidate
establishes its own liquidation baseline. Only fresh liquidation growth after
the alert may confirm a squeeze; rolling totals that predate the alert cannot.
Candidate snapshots are recorded at 2/5/10/15/30/60/120 minutes. The same API
also records `cmc-derivatives-context-v1`, a shadow-only aggregate open-interest
context every 15 minutes. A configurable monthly credit reserve fails closed
before the API allowance is exhausted.

An invalidated Squeeze Pressure alert stops producing Discord follow-ups, but it
remains in silent CMC research tracking through the 120-minute checkpoint. This
separates user-facing lifecycle closure from evidence collection.

The optional breakout observer is research-only. Its versioned quality gate
keeps missing-activity observations in a separate cohort, and completed research
records are retained for 90 days by default before daily pruning.

`breakout-admission-v1` bounds research storage without changing alerts or the
live dashboard. It retains every `QUALIFIED_SHADOW` episode and deterministically
samples `WATCH_SHADOW`, `LOW_QUALITY_SHADOW`, and `ACTIVITY_MISSING_SHADOW`
controls at the rates in `.env.local`. A one-hour same-market/same-direction
cooldown prevents repeated episodes from dominating the cohort. Every decision,
including suppression, is written to `data/breakout-admission-shadow.jsonl` for
audit. Admitted observations use the distinct
`breakout-observer-v1-quality-shadow-v2-admission-v1` detector version.

The `flow-fast-move-shadow-v1` cohort tests whether unusually strong Flow can be
recognized safely before the ordinary 60-second confirmation point. It requires
price acceleration, expanding open interest, meaningful fresh turnover, a tight
spread, limited retracement, and market-regime alignment. It is deliberately
research-only: it does not publish to Discord or change Automation entries.
Run `npm run fast-move-paths` to review its matured paths.

Every confirmation candidate receives the same outcome horizons whether it is
passed, rejected, or later suppressed. Run `npm run confirmation-passed-paths`
and `npm run confirmation-rejected-paths` for matched comparisons. Fast-move
evaluation summaries, including every nonqualifying reason encountered before
confirmation resolves, are written to `data/flow-fast-move-evaluations.jsonl`.
Breakout observations record 1/3/5/10/15/30/60/120-minute checkpoints.
Historical terminal dispositions are joined from the append-only ledger at
report time, so older suppressed candidates remain comparable without rewriting
their original outcome records.

The breakout feed reports raw and eligible market coverage by source venue. A
fresh, locally persisted Hyperliquid symbol universe may be used for up to six
hours during a temporary Hyperliquid metadata outage; stale or missing caches
fail closed so overlap venues cannot silently expand the execution universe.

Confirmation resolutions also record same-symbol prices already observed from
other venues. This cross-venue context is diagnostic only: it helps distinguish
a genuine detector disagreement from venue timing, basis, or a short-lived
pullback and never changes whether an alert passes or fails.

## Security

Never commit `.env.local`, webhook URLs, API keys, logs, or runtime state. This
bot requires no exchange credentials, wallet seed phrase, or private key.
