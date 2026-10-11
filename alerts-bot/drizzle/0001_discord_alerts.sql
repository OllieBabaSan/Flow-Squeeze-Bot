CREATE TABLE IF NOT EXISTS discord_alerts (
  signal_id TEXT PRIMARY KEY,
  headline TEXT NOT NULL,
  score INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
