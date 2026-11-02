import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BREAKOUT_HORIZONS = [1, 5, 15, 30, 60, 120];

export function createBreakoutOutcomeStore({ databasePath, maximumActiveRecords = 2000 } = {}) {
  let database;
  const open = async () => {
    if (database) return database;
    await mkdir(dirname(databasePath), { recursive: true });
    database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS breakout_records (
        id TEXT PRIMARY KEY, episode_key TEXT NOT NULL UNIQUE, symbol TEXT NOT NULL,
        venue TEXT NOT NULL, direction TEXT NOT NULL, quote_key TEXT NOT NULL,
        entry_price REAL NOT NULL, entry_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
        max_favorable_pct REAL NOT NULL DEFAULT 0, max_adverse_pct REAL NOT NULL DEFAULT 0,
        last_price REAL, last_observed_at_ms INTEGER, completed_at_ms INTEGER,
        trigger_json TEXT
      );
      CREATE INDEX IF NOT EXISTS breakout_records_active
        ON breakout_records(completed_at_ms, entry_at_ms);
      CREATE TABLE IF NOT EXISTS breakout_outcomes (
        record_id TEXT NOT NULL, horizon_minutes INTEGER NOT NULL, observed_at_ms INTEGER NOT NULL,
        price REAL NOT NULL, directed_return_pct REAL NOT NULL,
        max_favorable_pct REAL NOT NULL, max_adverse_pct REAL NOT NULL,
        PRIMARY KEY(record_id, horizon_minutes)
      );
    `);
    return database;
  };
  return {
    importLegacy: async (records, now = Date.now()) => {
      const db = await open();
      const insertRecord = db.prepare(`INSERT OR IGNORE INTO breakout_records
        (id, episode_key, symbol, venue, direction, quote_key, entry_price, entry_at_ms, status,
         max_favorable_pct, max_adverse_pct, last_price, last_observed_at_ms, completed_at_ms, trigger_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertOutcome = db.prepare(`INSERT OR IGNORE INTO breakout_outcomes
        (record_id, horizon_minutes, observed_at_ms, price, directed_return_pct, max_favorable_pct, max_adverse_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      let imported = 0;
      db.exec('BEGIN');
      try {
        for (const record of records) {
          const entryAtMs = Date.parse(record.entryAt || record.reservedAt);
          if (!(entryAtMs > 0) || !(Number(record.entryPrice) > 0)) continue;
          const completedAtMs = record.completedAt ? Date.parse(record.completedAt) : now - entryAtMs >= 120 * 60_000 ? now : null;
          insertRecord.run(record.id, `legacy:${record.id}`, record.symbol, record.venue || String(record.quoteKey || '').split(':')[0],
            record.direction, record.quoteKey, Number(record.entryPrice), entryAtMs, record.status || 'breakout-shadow',
            Number(record.maxFavorablePct || 0), Number(record.maxAdversePct || 0), Number(record.lastPrice || 0) || null,
            record.lastObservedAt ? Date.parse(record.lastObservedAt) : null, completedAtMs, JSON.stringify(record.trigger || {}));
          for (const [horizonText, outcome] of Object.entries(record.horizons || {})) {
            const horizon = Number(horizonText);
            if (!BREAKOUT_HORIZONS.includes(horizon)) continue;
            insertOutcome.run(record.id, horizon, Date.parse(outcome.observedAt) || now, Number(outcome.price),
              Number(outcome.directedReturnPct), Number(outcome.maxFavorablePct), Number(outcome.maxAdversePct));
          }
          imported += 1;
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { imported };
    },
    reserve: async record => {
      const db = await open();
      const active = db.prepare('SELECT COUNT(*) AS count FROM breakout_records WHERE completed_at_ms IS NULL').get().count;
      if (active >= maximumActiveRecords) return { admitted: false, reason: 'ACTIVE_RECORD_CAP' };
      db.prepare(`INSERT OR IGNORE INTO breakout_records
        (id, episode_key, symbol, venue, direction, quote_key, entry_price, entry_at_ms, status, trigger_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.episodeKey, record.symbol, record.venue, record.direction,
          record.quoteKey, Number(record.entryPrice), Date.parse(record.entryAt), 'reserved', JSON.stringify(record.trigger || {}));
      return { admitted: true };
    },
    delivery: async (id, status) => {
      const db = await open();
      db.prepare('UPDATE breakout_records SET status = ? WHERE id = ?').run(status, id);
    },
    observe: async (quotes, now = Date.now()) => {
      const db = await open();
      const rows = db.prepare('SELECT * FROM breakout_records WHERE completed_at_ms IS NULL').all();
      const outcomes = [];
      const hasOutcome = db.prepare('SELECT 1 FROM breakout_outcomes WHERE record_id = ? AND horizon_minutes = ?');
      const insertOutcome = db.prepare(`INSERT OR IGNORE INTO breakout_outcomes
        (record_id, horizon_minutes, observed_at_ms, price, directed_return_pct, max_favorable_pct, max_adverse_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const updateRecord = db.prepare(`UPDATE breakout_records SET max_favorable_pct = ?, max_adverse_pct = ?,
        last_price = ?, last_observed_at_ms = ?, completed_at_ms = ? WHERE id = ?`);
      for (const record of rows) {
        const price = Number(quotes.get(record.quote_key));
        if (!(price > 0)) continue;
        const elapsedMinutes = (now - Number(record.entry_at_ms)) / 60000;
        if (elapsedMinutes < 0) continue;
        const raw = ((price / Number(record.entry_price)) - 1) * 100;
        const directed = raw * (record.direction === 'BEARISH' ? -1 : 1);
        const favorable = Math.max(Number(record.max_favorable_pct || 0), directed);
        const adverse = Math.min(Number(record.max_adverse_pct || 0), directed);
        for (const horizon of BREAKOUT_HORIZONS) {
          if (elapsedMinutes < horizon || hasOutcome.get(record.id, horizon)) continue;
          insertOutcome.run(record.id, horizon, now, price, directed, favorable, adverse);
          outcomes.push({ id: record.id, kind: 'breakout-shadow', symbol: record.symbol,
            direction: record.direction, horizonMinutes: horizon, observedAt: new Date(now).toISOString(),
            price, directedReturnPct: directed, maxFavorablePct: favorable, maxAdversePct: adverse });
        }
        const completedAt = elapsedMinutes >= 120 ? now : null;
        updateRecord.run(favorable, adverse, price, now, completedAt, record.id);
      }
      return outcomes;
    },
    telemetry: async (now = Date.now()) => {
      const db = await open();
      const activeRecords = db.prepare('SELECT COUNT(*) AS count FROM breakout_records WHERE completed_at_ms IS NULL').get().count;
      const createdLastHour = db.prepare('SELECT COUNT(*) AS count FROM breakout_records WHERE entry_at_ms >= ?').get(now - 3600_000).count;
      const totalRecords = db.prepare('SELECT COUNT(*) AS count FROM breakout_records').get().count;
      const databaseBytes = await stat(databasePath).then(value => value.size).catch(() => 0);
      return { activeRecords, createdLastHour, totalRecords, maximumActiveRecords, databaseBytes };
    },
    close: () => { database?.close(); database = null; },
  };
}
