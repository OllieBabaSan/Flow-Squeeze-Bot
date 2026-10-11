# Flow/Squeeze Bot — Download, Installation, and Operation

This guide explains how to give another person their own independent copy of the Flow/Squeeze alert bot and how that person can install and operate it on a Windows computer.

The bot is an **alerting and research system only**. It monitors public perpetual-futures market data and posts qualified alerts to Discord. It does not connect to an exchange account, hold private keys, submit orders, or manage positions.

## 1. Where the bot is located

In the current development computer, the project directory is:

```text
C:\Users\user\Desktop\MockingBot-fixed\crypto-news-radar
```

The Flow/Squeeze monitor is primarily implemented in:

```text
scripts\local-radar.mjs
lib\flow-detector.mjs
lib\flow-alert-lifecycle.mjs
```

The Windows background-service scripts are:

```text
scripts\install-alertsbot-task.ps1
scripts\run-alertsbot-hidden.vbs
scripts\run-alertsbot-supervisor.cmd
scripts\uninstall-alertsbot-task.ps1
```

Do not give another user only those files. They need the complete `crypto-news-radar` project because the monitor imports supporting modules and uses the project's Node package definition.

## 2. How the owner should distribute it

The current `sites` Git remote is an internal project remote and should not be presented as a public download link. Until a separate GitHub repository or release page is created, distribute a clean ZIP archive of the entire `crypto-news-radar` directory.

Before making the ZIP, remove or exclude:

- `.env.local` and `.env.role.local` — these contain private webhooks and API keys.
- `data` — this contains local alert history, state, logs, and lock files.
- `node_modules` — the recipient will recreate it with `npm ci`.
- `.next`, `.vinext`, `dist`, `tmp`, `work`, and `outputs` — generated files are unnecessary.
- Any file containing a Discord webhook, API key, bearer token, private key, exchange credential, or user-specific identifier.

The package must retain at least:

- `package.json`
- `package-lock.json`
- `.env.example`
- `scripts`
- `lib`
- `app` and configuration files included in the project
- This guide

Suggested ZIP name:

```text
flow-squeeze-bot-YYYY-MM-DD.zip
```

The recipient can extract it to a simple permanent path such as:

```text
C:\FlowSqueezeBot
```

Do not install it in a temporary folder, inside the ZIP viewer, or in a folder that will later be renamed. The Windows scheduled task stores the installation path.

## 3. Requirements

The recipient needs:

1. Windows 10 or Windows 11.
2. A 64-bit Node.js release satisfying the project requirement: Node.js 22.13 or newer.
3. Internet access to Bybit, Hyperliquid, CoinGecko, Discord, and optionally CoinMarketCap.
4. Permission to create a Discord webhook in the destination channel, or a webhook supplied by the Discord server administrator.
5. A computer that remains powered on, awake, signed in, and online while monitoring.

The bot does not require Codex, ChatGPT Desktop, an exchange login, wallet access, seed phrases, or trading API credentials.

## 4. Install Node.js

Download the current Node.js LTS Windows installer from:

```text
https://nodejs.org/en/download
```

Use the normal installer defaults, including the option to add Node.js to `PATH`.

Open a new PowerShell window and verify:

```powershell
node --version
npm --version
```

`node --version` must report `v22.13.0` or newer. If PowerShell says `node` is not recognized, close and reopen PowerShell after installation. If it remains unavailable, restart Windows or repair the Node installation with the `PATH` option enabled.

## 5. Download and extract the bot

1. Download the ZIP supplied by the project owner.
2. Right-click it and select **Extract All**.
3. Extract it to `C:\FlowSqueezeBot` or another permanent directory.
4. Confirm that `package.json` is directly inside that directory. Avoid an accidental extra nesting level such as `C:\FlowSqueezeBot\flow-squeeze-bot\package.json` unless you intentionally use that inner directory in every command.

Open PowerShell in the project directory. One easy method is to open the folder in File Explorer, click the address bar, type `powershell`, and press Enter.

Install the exact dependency versions recorded by the project:

```powershell
npm ci
```

If the distributed package does not contain `package-lock.json`, use `npm install` instead and report that packaging defect to the owner.

## 6. Create the Discord destination

In Discord:

1. Create or choose the channel that should receive Flow/Squeeze alerts.
2. Open **Edit Channel → Integrations → Webhooks**.
3. Select **New Webhook**, give it a recognizable name, and choose the channel.
4. Select **Copy Webhook URL**.
5. Treat that URL as a password. Anyone who has it can post through the webhook. Never paste it into a public chat, issue, screenshot, or source file.

### Optional notification role

If alerts should mention an opt-in Discord role:

1. Create or choose that role in **Server Settings → Roles**.
2. Enable Discord **Developer Mode** under **User Settings → Advanced**.
3. Right-click the role and select **Copy Role ID**.
4. Make sure the webhook/bot is allowed to mention the role under the server and role permissions.

The role ID is a long number. Do not use the role name, channel ID, or user ID in its place. A role is optional; alerts still post when `DISCORD_ALERT_ROLE_ID` is left empty.

## 7. Configure a Flow/Squeeze-only installation

In the project directory, copy the example environment file:

```powershell
Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
notepad .env.local
```

For a minimal Flow/Squeeze-only installation, set these values:

```text
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/REPLACE_WITH_THE_PRIVATE_WEBHOOK
DISCORD_ALERT_ROLE_ID=

FLOW_SQUEEZE_ENABLED=true
NEWS_ALERTS_ENABLED=false
DIRECTIONAL_PRESSURE_ENABLED=false
X_PRIMARY_ENABLED=false
EDITORIAL_GATE_ENABLED=false
```

If a notification role is wanted, put its numeric ID after `DISCORD_ALERT_ROLE_ID=`.

Leave unrelated provider keys empty. The Flow/Squeeze scanner does not require an OpenAI API key, X API key, CryptoPanic key, LunarCrush key, exchange key, or wallet key.

### Optional CoinMarketCap confirmation data

The bot can confirm squeeze activity from falling venue open interest without CoinMarketCap. Adding a CoinMarketCap API key supplies additional cross-market liquidation evidence:

```text
COINMARKETCAP_API_KEY=REPLACE_WITH_PRIVATE_KEY
```

Without this key, alerts and open-interest-based squeeze follow-up continue to work. The follow-up simply omits CoinMarketCap liquidation evidence.

Save `.env.local` and close Notepad. Never distribute this configured file to another person; each operator should use their own Discord webhook and optional provider keys.

## 8. Test before background installation

Run the automated tests:

```powershell
npm test
```

Then run one dry scan:

```powershell
npm run radar:dry-run
```

The dry run queries live market sources and writes diagnostic output, but it does not publish Discord alerts. A healthy result should report market counts for Bybit and Hyperliquid without a final `ERROR` for all flow venues.

Because the bot only posts when market conditions meet its thresholds, the absence of a Discord alert is normal and is not evidence that the bot failed.

## 9. Run it interactively

For a visible foreground session:

```powershell
npm run radar
```

Leave that PowerShell window open. Stop the foreground bot with `Ctrl+C`.

Only one copy can run from a project directory. A lock file prevents duplicates. If a second copy is started, it reports that the monitor is already running and exits.

## 10. Install automatic background operation

After the dry run succeeds, install the supported Windows scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-alertsbot-task.ps1
```

This command:

- Creates the current-user scheduled task `CryptoAlertsMonitor`.
- Starts it immediately.
- Starts it again whenever that Windows user signs in.
- Runs it without a visible console window.
- Uses a supervisor that restarts the Node monitor after an unexpected exit.
- Does not require administrator privileges under the normal configuration.

Do not separately install `install-local-radar.ps1`; it delegates to the same supported task. Do not create a second Startup shortcut or another repeating scheduled task.

## 11. Verify that it is running

Check the task:

```powershell
Get-ScheduledTask -TaskName 'CryptoAlertsMonitor' |
  Select-Object TaskName, State
```

Check recent monitor activity:

```powershell
Get-Content -LiteralPath 'data\local-radar.log' -Tail 30
```

Follow the log continuously:

```powershell
Get-Content -LiteralPath 'data\local-radar.log' -Tail 20 -Wait
```

A healthy flow scan resembles:

```text
flow markets=... Bybit=... Hyperliquid=... alerts=0
```

`alerts=0` normally means no market met the alert rules during that scan. It does not mean the monitor is broken.

## 12. What the Discord labels mean

- `EARLY FLOW · BULLISH`: price, turnover, and new positioning indicate bullish directional flow.
- `EARLY FLOW · BEARISH`: price, turnover, and new positioning indicate bearish directional flow.
- `EARLY SQUEEZE PRESSURE · BULLISH`: shorts appear crowded and price has begun moving against them. This is a setup, not a confirmed squeeze.
- `EARLY SQUEEZE PRESSURE · BEARISH`: longs appear crowded and price has begun moving against them. This is a setup, not a confirmed squeeze.
- `SQUEEZE CONFIRMED`: price continued against the crowded side and either open interest contracted or aligned liquidation evidence appeared.
- `SQUEEZE PRESSURE INVALIDATED`: price moved materially against the proposed squeeze direction before confirmation.
- `SQUEEZE NOT CONFIRMED`: the two-hour pressure window expired without enough covering or liquidation evidence.
- `SQUEEZE EXHAUSTION`: a confirmed squeeze materially surrendered its best move.
- `SQUEEZE TRACKING ENDED`: the six-hour follow-up window ended without claiming that squeeze conditions remained active.

These alerts describe market evidence; they are not trade instructions, promised outcomes, or automated entries.

## 13. Stop, start, restart, or uninstall

Stop the background task:

```powershell
Stop-ScheduledTask -TaskName 'CryptoAlertsMonitor'
```

Start it again:

```powershell
Start-ScheduledTask -TaskName 'CryptoAlertsMonitor'
```

Restart it after changing `.env.local` or replacing program files:

```powershell
Stop-ScheduledTask -TaskName 'CryptoAlertsMonitor'
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'CryptoAlertsMonitor'
```

Completely remove automatic startup:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-alertsbot-task.ps1
```

Uninstalling the task does not delete the project, `.env.local`, logs, or history.

## 14. Updating the bot

For ZIP-based distribution:

1. Stop `CryptoAlertsMonitor`.
2. Back up `.env.local` and, if historical continuity matters, the `data` directory.
3. Replace the program files with the new clean release.
4. Restore `.env.local`; restore `data` only when the release notes say its state format is compatible.
5. Run `npm ci`.
6. Run `npm test` and `npm run radar:dry-run`.
7. Run `scripts\install-alertsbot-task.ps1` again so the scheduled task points to the correct permanent folder.

Never overwrite a newer `.env.local` with the distributor's environment file. A legitimate release should not contain one.

## 15. Troubleshooting

### No Discord messages

First inspect `data\local-radar.log`. If flow scans are healthy and show `alerts=0`, no qualifying setup occurred. Alerts are intentionally uncommon.

If the log says `DISCORD_WEBHOOK_URL is not configured`, correct `.env.local` and restart the task.

If it reports Discord HTTP 401 or 404, the webhook is invalid, deleted, or copied incorrectly. Create a new webhook and replace the URL.

If messages arrive but the role is not mentioned, verify the numeric role ID and the webhook's permission to mention that role.

### No market data

The computer or network must allow HTTPS access to:

```text
api.bybit.com
api.hyperliquid.xyz
api.coingecko.com
discord.com
```

VPNs, corporate firewalls, DNS filters, antivirus HTTPS inspection, or regional exchange restrictions can block one or more providers. The log records source-specific failures.

### The scheduled task stops

The task runs only while the configured Windows user is signed in. The computer must remain awake. Check Windows power settings and prevent sleep during the intended monitoring period.

Re-run the installer if the project folder was moved or renamed.

### PowerShell blocks the script

Use the documented command containing `-ExecutionPolicy Bypass`. This bypass applies to that invocation; it does not permanently weaken the system-wide execution policy.

### Stale lock file

Normally the installer clears the old monitor before starting a replacement. Do not manually delete `data\local-radar.lock` while a Node monitor is running. If the task is stopped and no corresponding Node process exists, rerunning the installer safely resolves the normal stale-process case.

## 16. Security boundaries

- Never request or store a user's exchange password, wallet seed phrase, or private key.
- Never reuse the project owner's webhook or API keys in a distributed copy.
- Keep `.env.local` out of Git and ZIP releases.
- Revoke and replace a Discord webhook immediately if it is exposed.
- The current bot is not an execution engine. Adding automated trading requires a separate security design, permissions model, risk controls, exchange-adapter review, paper-trading phase, and explicit user authorization.

