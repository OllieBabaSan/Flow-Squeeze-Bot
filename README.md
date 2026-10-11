# Flow/Squeeze Bot

Standalone distribution of the Flow/Squeeze Discord alert monitor and its Hyperliquid-only paper-trading research engine.

## Components

- `alerts-bot` monitors Bybit and Hyperliquid perpetual-market data, labels directional Flow separately from Squeeze Pressure, follows possible squeezes through confirmation or invalidation, and posts research alerts to Discord.
- `paper-bot` consumes those alerts, excludes assets unavailable on Hyperliquid, rejects stale or extended entries, waits for confirmation, and simulates entries and risk-managed exits. It contains no live-order capability or wallet/signing code.

## Quick start

Requirements: Windows 10/11 and Node.js 22.13 or newer.

```powershell
cd alerts-bot
npm ci
Copy-Item .env.example .env.local
notepad .env.local
```

For a Flow/Squeeze-only installation, configure:

```text
DISCORD_WEBHOOK_URL=YOUR_PRIVATE_DISCORD_WEBHOOK
DISCORD_ALERT_ROLE_ID=
FLOW_SQUEEZE_ENABLED=true
NEWS_ALERTS_ENABLED=false
DIRECTIONAL_PRESSURE_ENABLED=false
X_PRIMARY_ENABLED=false
EDITORIAL_GATE_ENABLED=false
```

Test and install the monitor:

```powershell
npm test
npm run radar:dry-run
powershell -ExecutionPolicy Bypass -File scripts\install-alertsbot-task.ps1
```

Start the independent paper monitor:

```powershell
cd ..\paper-bot
npm test
npm run once
powershell -ExecutionPolicy Bypass -File scripts\install-paper-task.ps1
```

Full instructions are in `alerts-bot/FLOW-SQUEEZE-OPERATOR-GUIDE.md`. Paper-bot methodology and evaluation gates are in `paper-bot/README.md`.

## Security

- Never commit `.env.local`, Discord webhooks, provider keys, logs, or runtime state.
- Neither component needs an exchange password, exchange API key, wallet seed phrase, or private key.
- The paper bot cannot place live orders.
- Automated execution requires a separate security and risk-control design.

## Disclaimer

This software is provided for research and informational use. Market alerts and simulated results are not financial advice or guarantees of future performance.
