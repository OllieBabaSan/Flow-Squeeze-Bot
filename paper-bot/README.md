# Flow/Squeeze Hyperliquid Paper Bot

Independent paper-execution service for Flow/Squeeze alerts. It has no wallet, signing, credential, or live-order code.

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

The bot tails the Flow/Squeeze Alerts versioned signal stream. Set `FLOW_SIGNAL_FILE` to the parent's absolute `flow-alert-history.jsonl` path, pass `--signal-file`, or use the bundled sibling-relative `signalFile` configuration. On its first start it records the current end of that file and begins prospectively with the next alert; it does not pretend old alerts were available in real time.

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
