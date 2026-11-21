import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from '../src/storage.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(projectDir, 'data-dydx-observer');
const state = await readJson(resolve(dataDir, 'state.json'), null);
let lines = [];
try { lines = (await readFile(resolve(dataDir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch {}
const samples = lines.filter(row => row.type === 'QUOTE_SAMPLE');
const starts = new Map(lines.filter(row => row.type === 'OBSERVATION_STARTED').map(row => [row.signalId, row]));
const bySignal = new Map();
for (const sample of samples) {
  if (!bySignal.has(sample.signalId)) bySignal.set(sample.signalId, []);
  bySignal.get(sample.signalId).push(sample);
}

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const fmt = (value, digits = 3) => value == null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
function executableReturn(first, later, venue, direction) {
  const entry = direction === 'BULLISH' ? first?.[venue]?.buy?.vwap : first?.[venue]?.sell?.vwap;
  const exit = direction === 'BULLISH' ? later?.[venue]?.sell?.vwap : later?.[venue]?.buy?.vwap;
  if (!(entry > 0 && exit > 0)) return null;
  return ((exit / entry - 1) * 100) * (direction === 'BEARISH' ? -1 : 1);
}

const horizons = [...new Set(samples.map(row => row.horizonSeconds))].sort((a, b) => a - b);
const rows = [];
for (const horizon of horizons.filter(value => value > 0)) {
  const hl = [], dydx = [], relative = [];
  for (const group of bySignal.values()) {
    const first = group.find(row => row.horizonSeconds === 0);
    const later = group.find(row => row.horizonSeconds === horizon);
    if (!first || !later) continue;
    const hlReturn = executableReturn(first, later, 'hyperliquid', first.direction);
    const dydxReturn = executableReturn(first, later, 'dydx', first.direction);
    if (hlReturn != null) hl.push(hlReturn);
    if (dydxReturn != null) dydx.push(dydxReturn);
    if (hlReturn != null && dydxReturn != null) relative.push(dydxReturn - hlReturn);
  }
  rows.push({ horizon, count: Math.min(hl.length, dydx.length), hl: mean(hl), dydx: mean(dydx), relative: mean(relative) });
}

const recentSampleErrors = lines.filter(row => row.type === 'QUOTE_SAMPLE_ERROR' && Date.parse(row.at) >= Date.now() - 86_400_000);
const delays = samples.map(row => Number(row.scheduleDelayMs)).filter(Number.isFinite);
const requestDurations = samples.map(row => Number(row.requestDurationMs)).filter(Number.isFinite);
console.log('dYdX passive lead-lag observer');
console.log(`Started: ${state?.startedAt || 'not started'}`);
console.log(`Last cycle: ${state?.lastCycleAt || 'n/a'}`);
console.log(`Last successful sample: ${state?.lastSuccessfulSampleAt || 'n/a'}`);
console.log(`Source signals: ${state?.totals?.sourceSignals || 0}`);
console.log(`Overlapping signals: ${state?.totals?.overlappingSignals || 0}`);
console.log(`Unsupported signals: ${state?.totals?.unsupportedSignals || 0}`);
console.log(`Active observations: ${Object.keys(state?.observations || {}).length}`);
console.log(`Quote samples: ${samples.length}`);
console.log(`Sample errors (total / last 24h): ${state?.totals?.sampleErrors || 0} / ${recentSampleErrors.length}`);
console.log(`Mean schedule delay: ${fmt(mean(delays), 1)} ms`);
console.log(`Mean paired-request duration: ${fmt(mean(requestDurations), 1)} ms`);
console.log('');
console.log('After-crossing-spread directed return from the immediate sample');
console.log('horizon  pairs  Hyperliquid%  dYdX%  dYdX-minus-HL pp');
for (const row of rows) console.log(`${String(row.horizon).padStart(7)}s  ${String(row.count).padStart(5)}  ${fmt(row.hl).padStart(12)}  ${fmt(row.dydx).padStart(6)}  ${fmt(row.relative).padStart(17)}`);
console.log('');
console.log('Interpretation requires a materially larger cohort; no paper trades are represented here.');
