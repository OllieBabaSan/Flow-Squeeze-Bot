# Flow/Squeeze Automation

Automation, paper-execution, observation, and benchmarking service for the separate Flow/Squeeze Bot. It has no wallet, signing, credential, or live-order code.

The physical directory name `flow-squeeze-paper` is retained temporarily for compatibility with existing Windows scheduled tasks. The canonical project entry is `C:\Users\user\Desktop\Automations\FlowSqueezeAutomation`.

## Data flow

```text
Crypto Alerts Flow/Squeeze event
→ Hyperliquid listing check
→ alert freshness and extension gates
→ spread and liquidity gates
→ directional confirmation window
→ simulated taker entry
→ hard stop / time stop / trailing stop / target / maximum hold
→ append-only decision and outcome records
```

The bot tails the Flow/Squeeze Alerts signal stream. Configure the parent product's absolute signal path with `FLOW_SIGNAL_FILE`, or pass `--signal-file C:\\path\\to\\flow-alert-history.jsonl`. The `signalFile` value in `config.json` remains a compatibility fallback for the current local deployment; new installations should not assume that the two products are sibling directories. On its first start it records the current end of that file and begins prospectively with the next alert; it does not pretend old alerts were available in real time.

New signals use a versioned one-way interface containing a stable signal ID,
schema and detector versions, publication status, creation time, file-recording
time, market snapshot, and detection evidence. The paper bot accepts legacy
unversioned records for continuity and fails closed on unknown future schema
versions. `SIGNAL_RECEIVED` records measure total alert-creation-to-receipt lag,
producer recording lag, and file-record-to-consumer lag. `npm run report`
summarizes median, p90, p95, maximum, and threshold breaches for each segment.

Only assets in Hyperliquid's current primary perpetual universe are eligible. The service uses Hyperliquid's public `metaAndAssetCtxs` and `l2Book` info requests. No exchange account is queried.

## Initial paper mandate

- 1,000 USDC virtual equity
- 1% planned risk per trade
- 800 USDC maximum position notional
- 2,000 USDC maximum aggregate notional
- Three concurrent positions maximum
- 2% daily loss lockout
- 0.045% taker fee per side, matching Hyperliquid's published base tier at implementation time
- 2 bps modeled slippage per side in addition to crossing the spread
- 1.25% hard stop and 2.5% target
- Twenty-minute no-movement time stop for bullish Flow; ten minutes for bearish Flow and Squeeze Pressure
- Four-hour maximum holding time
- Trailing protection after a 1% favorable move

All parameters are in `config.json`.

Position size does not determine whether the signal has predictive value. Reports therefore emphasize normalized R-multiple, MFE, MAE, fees, slippage, and rejection outcomes, and project the same exits at 0.5%, 1%, and 2% risk.

## Entry gates

A signal is rejected or allowed to expire when:

- The token is not listed as a Hyperliquid perpetual.
- The market is delisted.
- The initial alert is already more than 120 seconds old when observed.
- Hyperliquid 24-hour notional volume is below $10 million.
- The touch spread exceeds 20 bps.
- Price has already moved more than 1% beyond the first Hyperliquid observation in the alert direction.
- Price moves more than 0.5% against the alert before entry.
- Directional confirmation does not arrive within five minutes.
- Account-level exposure or loss gates are active.

Ordinary Flow needs at least 0.2% additional movement in the alert direction. Squeeze Pressure needs at least 0.35% plus falling Hyperliquid open interest; it is not treated as a confirmed squeeze merely because price moved.

The bot uses the first contemporaneous Hyperliquid observation as its reference. This avoids comparing Bybit open-interest units or a Bybit price basis directly with Hyperliquid.

Rejected eligible markets are followed for 5, 15, 30, 60, and 240 minutes. That counterfactual cohort tests whether filters avoided losses or discarded profitable moves.

Open paper positions are sampled once per minute in `POSITION_OBSERVATION` events. These observations allow alternative early-exit rules to be evaluated without changing the active prospective strategy.

Three proposed loss-control rules also run as counterfactual exits only: a five-minute failure breaker, a ten-minute failure breaker, and a failed-winner giveback breaker. `COUNTERFACTUAL_EXIT_TRIGGER` records the first executable shadow exit for each independent rule. When the unchanged paper position eventually closes, `COUNTERFACTUAL_EXIT_OUTCOME` compares shadow and actual net P&L and flags any actual winner the rule would have cut. These events never close positions, alter equity, or change active strategy parameters.

Strength optimization is also shadow-only. The monitor compares 0.50% and 0.625% trailing givebacks with the unchanged 0.75% control. Partial-profit models cross four triggers (+0.75%, +1%, +1.25%, and +1.5%) with three fractions (25%, 50%, and 75%); each model lets the remainder follow the actual exit. Profitable trailing/target exits are followed every five minutes through 60 minutes. `STRENGTH_SHADOW_*` and `WINNER_POST_EXIT_OUTCOME` events report whether each variant improved net P&L. These models do not alter positions or equity.

Binance USD-M Flow signals are collected as a shadow source and evaluated in a separate paper lane using Hyperliquid confirmation and simulated execution. Its state and events live under `data-binance`, and `npm run report:binance` reports that cohort without contaminating the original control account.

## V2 prospective validation (started October 24, 2026)

The original control and Binance paper accounts are frozen after failing the two-week viability gate. Their ledgers remain unchanged for audit and retrospective design work. The legacy dYdX REST observer is also retired because request latency prevents a defensible executable lead-lag comparison; streaming dYdX remains in the shared benchmark.

V2 isolates the two source venues with the best current rationale and independently tests the cost of confirmation. All four cohorts execute only as simulated Hyperliquid orders and begin with fresh $1,000 ledgers:

- Bybit confirmed: existing Flow confirmation; squeeze pressure also requires covering evidence.
- Bybit immediate: no additional price confirmation for ordinary Flow; squeeze pressure still requires covering evidence.
- Binance confirmed: the same confirmed rules, isolated from Bybit.
- Binance immediate: the same immediate rules, isolated from Bybit.

V2 actively uses the bounded early-failure breakers at five and ten minutes and a 0.50% trailing giveback. Hard stops and profit targets retain priority. Position risk, maximum notional, liquidity gates, fee assumptions, and all other inherited controls remain unchanged. Partial-profit variants remain research shadows rather than active rules.

The alert publisher scans every 20 seconds and V2 consumers poll the append-only alert ledger every second. This is lower latency than the baseline but is not a direct exchange-to-strategy streaming transport. The prospective comparison must therefore continue measuring publisher latency and alert-to-entry delay.

```powershell
npm run report:v2:bybit:confirmed
npm run report:v2:bybit:immediate
npm run report:v2:binance:confirmed
npm run report:v2:binance:immediate
powershell -ExecutionPolicy Bypass -File scripts\install-v2-paper-tasks.ps1
```

Kraken and Hyperliquid-origin alerts are excluded from active V2 trading because the baseline did not justify continued risk simulation. OKX and Bitget remain passive source benchmarks until prospective evidence warrants a separately declared paper cohort. Lighter, GMX, and streaming dYdX remain passive execution-venue research in the shared benchmark.

### V2R infrastructure repair (started October 25, 2026)

The first V2 run is retained as a failed-instrumentation record. Its four independent one-second consumers each requested the complete Hyperliquid catalog, causing sustained HTTP 429 responses. It produced no trades and is not counted as prospective strategy evidence.

V2R uses one shared read-only Hyperliquid cache. The cache refreshes the complete catalog once every 15 seconds, polls each actively required order book once per second, and atomically publishes one timestamped snapshot to all four cohorts. Network refreshes run independently from the one-second snapshot writer so a slow venue response cannot freeze an otherwise valid cache. Consumers still strip stale books and fail closed when the snapshot or catalog exceeds its configured safety age. This makes the immediate-versus-confirmed comparison use identical observable market data without treating a slow book request as a complete cache outage.

Changing cache-age values are normalized into a stable incident fingerprint. One outage therefore produces one initial `CYCLE_ERROR`, optional periodic summaries, and one `CYCLE_RECOVERED` record containing its duration and failed-cycle count instead of producing a different incident for every elapsed millisecond.

## Deployment provenance

The Automation source is maintained in this repository under `paper-bot/`. A deployment should be copied from a committed tree and accompanied by a `SOURCE_PROVENANCE.json` file containing the repository URL, commit, branch, `paper-bot` tree ID, deployment time, and deployed-file hashes. Runtime data, locks, credentials, and environment files must remain outside that source manifest.

The live Netcup services intentionally keep runtime state in `/var/lib/flow-squeeze` through data-directory symlinks. Replacing or verifying committed source must not replace those symlinks or modify their targets.

```powershell
npm run report:v2r:bybit:confirmed
npm run report:v2r:bybit:immediate
npm run report:v2r:binance:confirmed
npm run report:v2r:binance:immediate
powershell -ExecutionPolicy Bypass -File scripts\install-v2r-tasks.ps1
```

The V2R prospective clock begins only after the shared cache and all four fresh cohorts are healthy. The original baseline, legacy Binance account, legacy dYdX REST observer, and broken first V2 processes remain disabled.

## Passive dYdX lead-lag observer

The read-only dYdX observer follows new eligible Bybit and Binance alerts when the token is listed on both dYdX and Hyperliquid. It captures synchronized, size-aware executable books at receipt and after 1, 5, 15, 30, 60, 120, 300, 600, and 1,200 seconds. It records bid/ask, spread, depth-weighted buy and sell VWAP for an $800 notional, fill ratio, reference prices, open interest, schedule delay, and paired-request duration.

This observer does not create paper positions, modify either paper account, use credentials, sign transactions, or place orders. Its independent evidence is stored under `data-dydx-observer`.

## Shared streaming benchmark

The shared benchmark tails every eligible Bybit and Binance alert that overlaps Hyperliquid, whether or not the paper strategy enters. It dynamically subscribes to full Hyperliquid L2 snapshots and, where listed, reconstructs the dYdX L2 book from its initial snapshot and streaming deltas. It preserves book-change evidence for the dense first two minutes and normalized samples from sub-second receipt through 20 minutes. State and events are isolated under `data-streaming-benchmark`.

```powershell
npm run report:stream
powershell -ExecutionPolicy Bypass -File scripts\install-streaming-benchmark-task.ps1
```

The benchmark is public-market-data only. It has no credentials, accounts, signing, simulated account, or order capability.

```powershell
npm run observe:dydx:once
npm run observe:dydx
npm run report:dydx
powershell -ExecutionPolicy Bypass -File scripts\install-dydx-observer-task.ps1
```

## Run

```powershell
npm test
npm run once
npm start
```

Install persistent hidden monitoring:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-paper-task.ps1
```

The Windows task is named `FlowSqueezePaperMonitor`.

Generate a report:

```powershell
npm run report
```

State and evidence:

```text
data/state.json       active state and virtual account
data/events.jsonl     append-only signals, rejections, entries, exits, and outcomes
```

## Minimum evaluation gate

Two weeks is the minimum wall-clock observation period, not an automatic live-trading approval. Do not add live-order capability unless the prospective cohort also has:

- At least 50 completed paper trades
- Positive net PnL after modeled spread, fees, and slippage
- Profit factor of at least 1.2
- Maximum drawdown no worse than 10%
- No stale-data, duplicate-process, state-corruption, or risk-limit violations
- Separate results for Flow versus Squeeze Pressure and bullish versus bearish signals
- Evidence that freshness, extension, and confirmation gates improve outcomes relative to rejected opportunities
- Stable results that are not dominated by one token or one exceptional trade

If the two-week period does not produce enough trades, testing continues. Live integration requires a separate design review, paper-to-live parity review, credential model, kill switch, and explicit authorization.

## Hyperliquid references

- Perpetual metadata and contexts: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
- WebSocket and public feeds: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
- API rate limits: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
- Current fee schedule: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
