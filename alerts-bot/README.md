# News Radar

## Local 24/7 monitor

The alert loop can run directly on Windows without Codex or Sites. It polls publisher feeds and the legacy Flow/Squeeze scanner every 60 seconds, while Directional Pressure runs on a separate fixed 30-second cadence. Its first run creates a news baseline without sending old stories.

Run one safe scan with `npm run radar:dry-run`. Install and start the background monitor with `powershell -ExecutionPolicy Bypass -File scripts/install-alertsbot-task.ps1`. It is registered for the current user's Windows sign-in, runs without a visible console window, and does not require administrator access. The legacy `install-local-radar.ps1` entry point delegates to the same task and removes its retired Startup entry so it cannot create a duplicate monitor.

Status is written to `data/local-radar.log`; deduplication state is stored in `data/local-radar-state.json`.

The local monitor uses a single-instance lock and reserves each Discord delivery before sending it. This prevents duplicate posts when Discord accepts a webhook but its response times out, and prevents a second background monitor from running against the same state files.

Discord market-structure alerts explicitly distinguish `FLOW` from `SQUEEZE PRESSURE`. Rising open interest without crowded opposing positioning is directional flow. Crowded shorts with rising price, or crowded longs with falling price, is only squeeze pressure—not a confirmed squeeze. The monitor follows squeeze-pressure alerts and publishes a confirmation only when price continues in the alert direction and open interest falls or direction-aligned liquidation evidence appears. It also closes the lifecycle with an invalidated, unconfirmed, exhaustion, or tracking-ended update so an initial setup is never silently treated as a confirmed squeeze.

The monitor also watches Bybit USDT perpetuals and Hyperliquid perpetuals for short-window price acceleration backed by fresh turnover and either crowded funding or rising open interest. Hyperliquid's hourly funding is normalized to an 8-hour equivalent for the shared squeeze threshold. Alerts are explicitly labeled `FLOW` or `SQUEEZE PRESSURE`, identify their source venue, and are deliberately kept separate from verified news catalysts. Set `NEWS_ALERTS_ENABLED=false` for a standalone Flow/Squeeze deployment.

Flow/Squeeze is an early-warning screen rather than a large-move reporter. It looks for an initial 0.75%–3.5% short-window displacement, at least $250,000 of fresh turnover, at least $10 million in 24-hour turnover, and new open-interest participation. Crowded funding lowers the required OI increase to 0.15%; otherwise OI must rise by at least 0.5%. Moves already beyond 3.5% are considered extended and are not published as fresh opportunities. A symbol can alert only once per 12 hours across all venues. Successfully posted alerts and their trigger metrics are appended to `data/flow-alert-history.jsonl` for ongoing outcome evaluation.

Discord alerts are limited to tokens verified by CoinGecko or CoinMarketCap. Ambiguous tickers must also match the article's project name or a corroborating live price; unresolved and untracked assets are suppressed.

Discord news alerts also include a best-effort `Chain` field derived from verified token metadata or explicit article language. When the chain cannot be established safely, the alert says `Not identified — verify source` instead of guessing. A separate `Token address` field is fetched from the verified CoinGecko or CoinMarketCap identity; native assets are explicitly identified as having no contract address, and missing registry metadata is never replaced with an inferred or model-generated address. Memecoin alerts are rejected unless that verified identity supplies a contract address.

Flow/Squeeze alerts separately identify the venue that produced the signal and currently available perpetual DEX markets. The DEX lookup uses official live catalogs from Hyperliquid, Aster, GMX, and Lighter, includes a trading link only for an active symbol match, and reports when no supported perp DEX market is located. Lighter matches also require its live mark/index price to agree with the triggering market, preventing unrelated assets that share a ticker from being linked. Catalog results are cached for 15 minutes to avoid adding repeated network load.

The local monitor can run independently of GPT Desktop through the `CryptoAlertsMonitor` Windows Scheduled Task. `scripts/install-alertsbot-task.ps1` registers one hidden task for Windows sign-in and starts a lightweight command-shell supervisor through Windows Script Host without displaying a console window. The supervisor waits for the single Node monitor and restarts it after 30 seconds if it exits; it does not use a repeating Task Scheduler trigger. The monitor's instance lock prevents duplicates. The computer must remain powered on, awake, signed in, and connected to the internet. `scripts/uninstall-alertsbot-task.ps1` removes both the task and the retired `CryptoNewsRadarLocal` Startup entry.

News discovery is intentionally recall-oriented. Fresh actionable `WATCH` and `HIGH` candidates reach Terra editorial review, and major-institution stories with one identified asset have an editorial rescue path even when the rules engine cannot classify the phrasing. Launch language includes launches, introduces, unveils, debuts, rolls out, and goes live; moving from planned or previewed to live is treated as a material development. AlertsBot uses separate broad searches for institutional launches and crypto-focused wire releases. Every newly ingested local story records its pre-editorial decision for later auditing.

Official X posts are evaluated as complete posts rather than caption text alone. The stream requests long-form notes, X Article fields, expanded URLs, and attachment metadata. Before qualification, the monitor extracts up to three linked HTML pages, includes image alt text, and supplies up to four attached images to the editorial model. Tier B stream rules admit catalyst wording as well as posts containing links or media so an opaque caption does not prevent content review. Link retrieval is bounded by `X_LINK_FETCH_TIMEOUT_MS` (6 seconds by default); failed extraction falls back to the post text and existing safety gates.

Every verified X candidate that reaches editorial review is also followed in shadow mode, whether approved or rejected. This does not affect Discord delivery. Prospective outcomes include raw return, BTC/ETH-adjusted abnormal return, direction-adjusted abnormal return, and a movement-to-catalyst ratio normalized by the token's pre-event daily range. Run `npm run radar:x-backtest` to reconstruct the historical comparison from identity-validated five-minute venue candles and write `backtest/X-SIGNAL-KEYWORD-REPORT.md` plus event-level JSON. Production keywords are not changed automatically.

Run `npm run radar:cost` for a combined X post-read and GPT-5.6 Terra editorial estimate with a 30-day projection. The operating target defaults to $50/month and can be changed with `PROJECT_MONTHLY_BUDGET_USD`; provider unit rates are configurable in `.env.local` if pricing changes. `PROJECT_FIXED_MONTHLY_COST_USD` can include an optional project-only fixed expense, but the normal ChatGPT subscription is not required by the standalone bot and defaults to zero. Provider billing dashboards remain authoritative. The live stream deliberately omits author/user expansions because monitored author IDs are already stored locally.

Standalone crypto-news intelligence dashboard. It collects fast editorial feeds, clusters duplicate stories, extracts token references, and ranks events for immediate investigation. It never places trades.

## Inputs

- CoinDesk
- The Block
- Cointelegraph
- Decrypt
- CoinNess (through CryptoPanic when configured)
- Blockworks
- DL News
- Unchained
- Bitcoin Magazine
- Trump's Truth archive feed (Truth Social posts)
- Optional CryptoPanic aggregate feed
- Optional LunarCrush X/KOL feed

Copy `.env.example` to `.env.local` and add provider keys to enable CryptoPanic or LunarCrush. Direct publisher and Truth Social archive feeds require no credentials.

## Run

```text
npm install
npm run dev
```

The feed refreshes every two minutes. The asset-catalyst engine rejects general commentary and requires a direct affected-token relationship before a story can become actionable. Scores are deterministic and explainable; HIGH means investigate promptly, not execute a trade.

Discord delivery uses a protected incoming webhook and records a reservation before delivery to suppress timeout-driven duplicates. Hosted dispatch is disabled by default; enabling it requires `HOSTED_DISPATCH_ENABLED=true`, a `DISPATCH_SECRET`, and an authenticated `POST` to `/api/discord/dispatch`. `GET` is health-only.

## Terra editorial gate

Crypto Alerts can send rule-qualified news candidates through GPT-5.6 Terra before Discord publication. Terra checks whether the article contains a useful and genuinely new catalyst, whether the proposed token is directly affected, whether the directional conclusion is supported, and whether recent alerts already covered the same underlying event. Flow/squeeze alerts remain separate and do not use the editorial model.

The gate receives extracted article text when available (with RSS summary fallback), treats all article content as untrusted evidence, and records its verdict and API usage in `data/alert-ledger.jsonl`. Sent news and flow alerts are followed for direction-adjusted 5, 15, 30, 60, and 240 minute outcomes in `data/alert-outcomes.json`. Run `npm run radar:performance` for the live flow cohort report.

To validate a lower-cost editorial cascade without weakening live decisions, 10% of primary-X candidates are also reviewed by GPT-5.6 Luna in shadow mode. Terra remains the only production verdict. Shadow decisions and usage are recorded as `editorial_shadow_decision`; change `EDITORIAL_SHADOW_SAMPLE_RATE` or set it to zero to disable the comparison.

Flow/squeeze monitoring currently publishes qualified Bybit and Hyperliquid signals. Kraken Futures runs in shadow mode: identical rules and outcome tracking apply, but Kraken candidates are not sent to Discord. `npm run radar:performance` separates results by venue so Kraken can replace Bybit only after sufficient live evidence.

## Directional Pressure

Directional Pressure is an observation-only early-move detector with separate Pressure and Expansion scores. It can notice pressure immediately, but requires persistent movement across the preceding 10–15 minutes before recording `CONFIRMED_MOMENTUM`; these windows use elapsed time rather than sample counts. Its lifecycle is `EARLY_PRESSURE`, `DEVELOPING`, `CONFIRMED_MOMENTUM`, `SUSTAINED`, `MOMENTUM_WEAKENING`, `MOMENTUM_STABILIZED`, `MOMENTUM_LOSS`, `RESUMED_MOMENTUM`, and `MOMENTUM_ENDED`. Weakening is a watch-closely notice, stabilization clears that warning, and momentum loss is the confirmed exit condition. Ordinary weakness must persist for three observations; a hard direction break can confirm on the second. After loss, the bot watches for three more minutes: confirmed momentum produces `RESUMED_MOMENTUM`; otherwise `MOMENTUM_ENDED` confirms that the move is gone and retires the episode until fresh pressure emerges. The component does not rotate holdings or place trades.

Events remain shadow-only and do not post to Discord. They include direction, likely move character, correlation with recent news/flow alerts, and direction-adjusted outcomes from 5 minutes through 24 hours. The 4–12 hour range is an intended opportunity horizon, not a holding rule: a two-hour move followed by a momentum-loss signal remains a successful outcome. Hyperliquid is the primary live market and Kraken provides confirmation and additional coverage; configure the universe with `DIRECTIONAL_PRESSURE_VENUES`.

If Directional Pressure is promoted to a live PressureBot, it must use its own Discord channel and a separate opt-in notification role. PressureBot must not mention the Crypto Alerts role or otherwise ping AlertsBot subscribers, because its higher potential alert volume should not be imposed on members who only opted into Crypto Alerts. Final channel, role, and delivery settings will be decided before Discord publication is enabled.

PressureBot maintains venue-specific evidence internally but selects one dominant public source per token. Hyperliquid is preferred when data quality is otherwise comparable, Kraken acts as confirmation or fallback, and conflicting cross-venue directions suppress publication until they resolve. The chosen venue remains sticky during an active episode to prevent source flapping. Simultaneous events are persisted as a batch; five or more `MOMENTUM_ENDED` events in one scan are assigned to one terminal digest rather than an alert cascade. Their actual event times are preserved and are never artificially staggered.

The fast outcome state contains only active observations. Once a record completes its 24-hour horizon it moves to the append-only `data/alert-outcomes-archive.jsonl`, keyed by its stable event id, while the full event ledger remains intact. This prevents historical growth from increasing every 30-second scan cost. CMC evidence that completes during the same pressure cycle is also committed in one batch.

When `COINMARKETCAP_API_KEY` is configured, shadow events also record cached token-level liquidation evidence and budgeted cross-exchange perpetual-market evidence. These fields are observational only and do not change direction, scores, lifecycle states, or Discord behavior. Cross-exchange candidate queries default to a maximum of 50 per UTC day; configure this with `CMC_DERIVATIVES_CANDIDATE_DAILY_LIMIT`.

Run `npm run pressure:backtest` for the preliminary Kraken price/volume/open-interest test. Kraken is used for historical testing because its public history includes the needed open-interest series; it is not the preferred live venue. The initial cohort showed that price, volume, and OI alone did not reliably predict continuation, so no publishing threshold has been enabled. Live Hyperliquid shadow evaluation also captures recent aggressive trade flow and L2 book imbalance; those results are the authoritative basis for subsequent tuning.

Both news and flow/squeeze alerts must resolve their ticker through CoinGecko before publication. CoinMarketCap is used as an optional fallback when `COINMARKETCAP_API_KEY` is configured. Alerts include the verified project/entity name and registry link; symbols that neither registry can verify are suppressed.

Add `OPENAI_API_KEY` to `.env.local`, set `EDITORIAL_GATE_ENABLED=true`, and restart the local monitor. The gate fails closed: when enabled, a missing key, API error, uncertain verdict, indirect asset relationship, or semantic repeat prevents the news alert from being posted. `OPENAI_EDITORIAL_MODEL`, `OPENAI_EDITORIAL_REASONING`, and `EDITORIAL_MIN_CONFIDENCE` can be adjusted if needed.
