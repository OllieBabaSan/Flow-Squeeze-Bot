#!/usr/bin/env bash
set -euo pipefail

ALERTS_APP="/opt/flow-squeeze/release/Flow-Squeeze-Bot/alerts-bot"
DATA_DIR="/var/lib/flow-squeeze/alerts-data"

if [[ ! -f "$ALERTS_APP/scripts/report-alert-paths.mjs" ]]; then
  echo "Flow/Squeeze breakout reporter is missing: $ALERTS_APP/scripts/report-alert-paths.mjs" >&2
  exit 2
fi

cd "$ALERTS_APP"
exec /usr/bin/node scripts/report-alert-paths.mjs \
  --data-dir "$DATA_DIR" \
  --kind breakout-shadow \
  "$@"
