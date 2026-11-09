import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarizeFastMoveEvaluations } from '../lib/fast-move-evaluation-report.mjs';

const argumentValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const data = resolve(argumentValue('--data-dir') || 'data');
const sinceHours = Math.max(1, Number(argumentValue('--since-hours') || 168));
const since = Date.now() - sinceHours * 3600_000;
const text = await readFile(resolve(data, 'flow-fast-move-evaluations.jsonl'), 'utf8').catch(() => '');
const records = text.split(/\r?\n/).filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
}).filter(record => Date.parse(record.resolvedAt || record.at || record.createdAt) >= since);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  since: new Date(since).toISOString(),
  detectorVersion: 'flow-fast-move-shadow-v1',
  summary: summarizeFastMoveEvaluations(records),
  records,
}, null, 2));
