import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeAlertPath, summarizeAlertPaths } from '../lib/alert-path-analysis.mjs';

const argumentValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const data = resolve(argumentValue('--data-dir') || 'data');
const sinceHours = Math.max(1, Number(argumentValue('--since-hours') || 24));
const kind = argumentValue('--kind') || 'flow';
const status = argumentValue('--status') || (kind === 'flow' ? 'sent' : '');
const since = Date.now() - sinceHours * 3600_000;
const active = JSON.parse(await readFile(resolve(data, 'flow-alert-outcomes.json'), 'utf8'));
const archiveText = await readFile(resolve(data, 'flow-alert-outcomes-archive.jsonl'), 'utf8').catch(() => '');
const archived = archiveText.split(/\r?\n/).filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const byId = new Map([...archived, ...Object.values(active.records || {})].map(record => [record.id, record]));
const records = [...byId.values()].filter(record => record.kind === kind
  && (!status || record.status === status)
  && Date.parse(record.entryAt || record.reservedAt) >= since);
const paths = records.map(record => analyzeAlertPath(record)).sort((a, b) => String(a.entryAt).localeCompare(String(b.entryAt)));
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  since: new Date(since).toISOString(),
  cohort: { kind, status: status || 'ANY' },
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
