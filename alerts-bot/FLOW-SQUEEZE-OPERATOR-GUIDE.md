# Flow/Squeeze Alerts operator guide

Clone the Flow-Squeeze-Bot repository and enter `alerts-bot`. Install Node.js
22.13 or newer, run `npm install`, copy `.env.example` to `.env.local`, and add
the Discord webhook. Verify with `npm test` and `npm run dry-run`, then start
with `npm start` or install the included Windows scheduled task.

All source, configuration examples, tests, and runtime paths required by this
alert product are inside `alerts-bot`. No MockingBot, X Alerts, PressureBot, or
other repository is required.

The optional Flow/Squeeze Automation product consumes
`data/flow-alert-history.jsonl` through its documented `FLOW_SIGNAL_FILE`
setting. The alerts product does not depend on the automation product.
