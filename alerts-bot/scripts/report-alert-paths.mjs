import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyzeAlertPath, summarizeAlertPaths } from '../lib/alert-path-analysis.mjs';
import { indexConfirmationDispositions, reconcileConfirmationDisposition } from '../lib/confirmation-dispositions.mjs';

const argumentValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const data = resolve(argumentValue('--data-dir') || 'data');
const sinceHours = Math.max(1, Number(argumentValue('--since-hours') || 24));
const kind = argumentValue('--kind') || 'flow';
const status = argumentValue('--status') || (kind === 'flow' ? 'sent' : '');
const disposition = argumentValue('--disposition') || '';
const since = Date.now() - sinceHours * 3600_000;
let records;
if (kind === 'breakout-shadow') {
  const database = new DatabaseSync(resolve(data, 'breakout-outcomes.sqlite3'), { readOnly: true });
  const rows = database.prepare('SELECT * FROM breakout_records WHERE entry_at_ms >= ? AND (? = \'\' OR status = ?)').all(since, status, status);
  const outcomeStatement = database.prepare('SELECT * FROM breakout_outcomes WHERE record_id = ? ORDER BY horizon_minutes');
  records = rows.map(row => {
    let trigger = {};
    try { trigger = JSON.parse(row.trigger_json || '{}'); } catch {}
    return {
      id: row.id, kind, symbol: row.symbol, venue: row.venue, direction: row.direction,
      entryPrice: row.entry_price, entryAt: new Date(row.entry_at_ms).toISOString(), status: row.status,
      maxFavorablePct: row.max_favorable_pct, maxAdversePct: row.max_adverse_pct,
      detectorVersion: trigger.qualityGate?.version || null,
      qualityStatus: trigger.qualityGate?.status || null,
      qualityScore: trigger.qualityGate?.score ?? null,
      qualityFlags: trigger.qualityGate?.flags || [],
      horizons: Object.fromEntries(outcomeStatement.all(row.id).map(outcome => [outcome.horizon_minutes, {
        observedAt: new Date(outcome.observed_at_ms).toISOString(), price: outcome.price,
        directedReturnPct: outcome.directed_return_pct, maxFavorablePct: outcome.max_favorable_pct,
        maxAdversePct: outcome.max_adverse_pct,
      }])),
    };
  });
  database.close();
} else {
  const active = JSON.parse(await readFile(resolve(data, 'flow-alert-outcomes.json'), 'utf8'));
  const archiveText = await readFile(resolve(data, 'flow-alert-outcomes-archive.jsonl'), 'utf8').catch(() => '');
  const archived = archiveText.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const ledgerText = await readFile(resolve(data, 'flow-alert-ledger.jsonl'), 'utf8').catch(() => '');
  const ledgerEvents = ledgerText.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const dispositionsById = indexConfirmationDispositions(ledgerEvents);
  const reconciled = [...archived, ...Object.values(active.records || {})]
    .map(record => reconcileConfirmationDisposition(record, dispositionsById));
  const byId = new Map(reconciled.map(record => [record.id, record]));
  records = [...byId.values()].filter(record => record.kind === kind
    && (!status || record.status === status)
    && (!disposition || record.confirmationDisposition?.status === disposition)
    && Date.parse(record.entryAt || record.reservedAt) >= since);
}
const paths = records.map(record => ({
  ...analyzeAlertPath(record),
  status: record.status,
  detectorVersion: record.detectorVersion || record.trigger?.detectorVersion || null,
  parentSignalId: record.parentSignalId || null,
  confirmationDisposition: record.confirmationDisposition || null,
})).sort((a, b) => String(a.entryAt).localeCompare(String(b.entryAt)));
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  since: new Date(since).toISOString(),
  cohort: { kind, status: status || 'ANY', disposition: disposition || 'ANY' },
  methodology: {
    activation: 'At least +1.0% maximum favorable movement within 60 minutes.',
    worked: 'Activated and direction-adjusted return remained above zero at 60 minutes.',
    reversed: 'Worked at 60 minutes but direction-adjusted return was zero or negative at a later observed horizon.',
    failed: 'Never activated and direction-adjusted return was -1.0% or worse at 60 minutes.',
    inconclusive: 'Does not meet worked or failed criteria.',
  },
  summary: summarizeAlertPaths(paths),
  paths,
}, null, 2));
