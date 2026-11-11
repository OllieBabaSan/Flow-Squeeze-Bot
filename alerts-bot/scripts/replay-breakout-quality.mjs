import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { evaluateBreakoutQuality, BREAKOUT_QUALITY_VERSION } from '../lib/breakout-quality.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const databasePath = resolve(value('--database', 'data/breakout-outcomes.sqlite3'));
const sinceHours = Math.max(1, Number(value('--since-hours', 168)) || 168);
const sourceVersion = value('--source-version', 'breakout-quality-shadow-v2');
const database = new DatabaseSync(databasePath, { readOnly: true });
const rows = database.prepare(`
  SELECT r.venue, r.direction, r.trigger_json, o.directed_return_pct AS return_60m
  FROM breakout_records r
  JOIN breakout_outcomes o ON o.record_id = r.id AND o.horizon_minutes = 60
  WHERE r.entry_at_ms >= ?
`).all(Date.now() - sinceHours * 3600_000);

const cohorts = new Map();
for (const row of rows) {
  let trigger;
  try { trigger = JSON.parse(row.trigger_json); } catch { continue; }
  if (trigger.qualityGate?.version !== sourceVersion) continue;
  const regime = trigger.regime || {};
  const market = { change24hPct: trigger.qualityGate?.inputs?.broadDirected == null
    ? null : Number(trigger.qualityGate.inputs.broadDirected) * (row.direction === 'BEARISH' ? -1 : 1) };
  const result = evaluateBreakoutQuality({ observation: trigger, market, regime });
  const keys = [
    ['overall', result.status],
    ['venue', `${row.venue}:${result.status}`],
    ['direction', `${row.direction}:${result.status}`],
    ['regime', `${regime.state || 'UNKNOWN'}:${result.status}`],
  ];
  for (const [dimension, bucket] of keys) {
    const key = `${dimension}|${bucket}`;
    const cohort = cohorts.get(key) || { dimension, bucket, count: 0, worked: 0, positive: 0, totalReturn60m: 0 };
    cohort.count++;
    cohort.worked += Number(row.return_60m) >= 0.5 ? 1 : 0;
    cohort.positive += Number(row.return_60m) > 0 ? 1 : 0;
    cohort.totalReturn60m += Number(row.return_60m);
    cohorts.set(key, cohort);
  }
}

const report = [...cohorts.values()].map(cohort => ({
  ...cohort,
  workedPct: Number((cohort.worked / cohort.count * 100).toFixed(2)),
  positivePct: Number((cohort.positive / cohort.count * 100).toFixed(2)),
  averageReturn60mPct: Number((cohort.totalReturn60m / cohort.count).toFixed(4)),
})).sort((left, right) => left.dimension.localeCompare(right.dimension) || left.bucket.localeCompare(right.bucket));
console.log(JSON.stringify({ version: BREAKOUT_QUALITY_VERSION, sourceVersion, databasePath, sinceHours, maturedRecords: report.find(item => item.dimension === 'overall') ? report.filter(item => item.dimension === 'overall').reduce((sum, item) => sum + item.count, 0) : 0, cohorts: report }, null, 2));
database.close();
