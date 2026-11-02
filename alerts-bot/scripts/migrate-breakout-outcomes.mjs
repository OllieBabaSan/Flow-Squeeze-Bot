import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBreakoutOutcomeStore } from '../lib/breakout-outcome-store.mjs';
import { writeJsonAtomic } from '../lib/state-file.mjs';

const argumentValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const data = resolve(argumentValue('--data-dir') || 'data');
const active = JSON.parse(await readFile(resolve(data, 'flow-alert-outcomes.json'), 'utf8'));
const records = Object.values(active.records || {}).filter(record => record.kind === 'breakout-shadow');
const pruneSource = process.argv.includes('--prune-source');
const store = createBreakoutOutcomeStore({ databasePath: resolve(data, 'breakout-outcomes.sqlite3') });
try {
  const result = await store.importLegacy(records);
  let prunedSourceRecords = 0;
  if (pruneSource && records.length) {
    active.records = Object.fromEntries(Object.entries(active.records || {}).filter(([, record]) => record.kind !== 'breakout-shadow'));
    await writeJsonAtomic(resolve(data, 'flow-alert-outcomes.json'), active);
    prunedSourceRecords = records.length;
  }
  console.log(JSON.stringify({ ...result, sourceRecords: records.length, prunedSourceRecords, telemetry: await store.telemetry() }, null, 2));
} finally { store.close(); }
