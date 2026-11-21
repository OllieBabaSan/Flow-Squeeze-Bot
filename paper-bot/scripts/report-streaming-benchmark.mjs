import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { readJson } from '../src/storage.mjs';

const dataDir = resolve('data-streaming-benchmark');
const state = await readJson(resolve(dataDir, 'state.json'), null);
const samples = [];
let legacyDenseStreamChanges = 0, missedHorizons = 0, errors = 0, parseErrors = 0, ledgerReadError = null;
try {
  const ledgers = (await readdir(dataDir)).filter(name => /^events(?:\.[^.]+)?\.jsonl$/.test(name) || name === 'events.jsonl').sort();
  for (const ledger of ledgers) {
    const lines = createInterface({ input: createReadStream(resolve(dataDir, ledger)), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { parseErrors += 1; continue; }
      if (row.type === 'BENCHMARK_SAMPLE') samples.push(row);
      else if (row.type === 'STREAM_BOOK_CHANGE') legacyDenseStreamChanges += 1;
      else if (row.type === 'BENCHMARK_MISSED_HORIZON') missedHorizons += 1;
      if (/ERROR$/.test(row.type || '')) errors += 1;
    }
  }
} catch (error) { ledgerReadError = error?.stack || String(error); }
const bySignal = new Map();
for (const row of samples) { if (!bySignal.has(row.signalId)) bySignal.set(row.signalId, []); bySignal.get(row.signalId).push(row); }
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = values => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
function executableReturn(first, later, venue) {
  const direction = first.direction;
  const entry = direction === 'BULLISH' ? first[venue]?.buy?.vwap : first[venue]?.sell?.vwap;
  const exit = direction === 'BULLISH' ? later[venue]?.sell?.vwap : later[venue]?.buy?.vwap;
  if (!(entry > 0 && exit > 0)) return null;
  return ((exit / entry - 1) * 100) * (direction === 'BEARISH' ? -1 : 1);
}
const venues = ['hyperliquid', 'dydx', 'lighter', 'gmx'];
function summarizeVenueExecution(selected) {
  const output = {};
  for (const venue of venues) {
    const usable = venue === 'lighter' && state?.lighterValidationEpochAt
      ? selected.filter(row => Date.parse(row.at) >= Date.parse(state.lighterValidationEpochAt))
      : selected;
    const entryFillRatios = [], exitFillRatios = [];
    for (const row of usable) {
      const value = row[venue]; if (!value) continue;
      if (Number.isFinite(Number(value.buy?.fillRatio))) entryFillRatios.push(Number(value.buy.fillRatio));
      if (Number.isFinite(Number(value.sell?.fillRatio))) exitFillRatios.push(Number(value.sell.fillRatio));
    }
    output[venue] = {
      quoteSamples: usable.filter(row => row[venue]).length,
      meanBuyFillRatio: mean(entryFillRatios), meanSellFillRatio: mean(exitFillRatios),
      fullBuyFills: entryFillRatios.filter(value => value >= 0.999999).length,
      fullSellFills: exitFillRatios.filter(value => value >= 0.999999).length,
      oracleOnly: venue === 'gmx',
      lighterValidationEpochAt: venue === 'lighter' ? state?.lighterValidationEpochAt || null : undefined,
    };
  }
  return output;
}
function summarizeAllVenueReturns(groups) {
  const output = {};
  for (const horizon of keyHorizons) {
    output[horizon] = {};
    for (const venue of venues) {
      const values = [];
      for (const group of groups.values()) {
        let first = group.find(row => row.horizonSeconds === 0);
        let later = group.find(row => row.horizonSeconds === horizon);
        if (venue === 'lighter' && state?.lighterValidationEpochAt) {
          const epoch = Date.parse(state.lighterValidationEpochAt);
          if ((first && Date.parse(first.at) < epoch) || (later && Date.parse(later.at) < epoch)) { first = null; later = null; }
        }
        if (!first || !later) continue;
        const value = executableReturn(first, later, venue); if (value != null) values.push(value);
      }
      output[horizon][venue] = { samples: values.length, meanPct: mean(values), medianPct: median(values), oracleOnly: venue === 'gmx' };
    }
  }
  return output;
}
const keyHorizons = [1, 5, 15, 30, 60, 120, 300, 600, 1200];
function groupSamples(selected) {
  const grouped = new Map();
  for (const row of selected) { if (!grouped.has(row.signalId)) grouped.set(row.signalId, []); grouped.get(row.signalId).push(row); }
  return grouped;
}
function summarizeGroups(groups) {
  const results = {};
  for (const horizon of keyHorizons) {
    const hl = [], dydx = [], pairedAdvantages = [];
    for (const group of groups.values()) {
      const first = group.find(row => row.horizonSeconds === 0);
      const later = group.find(row => row.horizonSeconds === horizon);
      if (!first || !later) continue;
      const h = executableReturn(first, later, 'hyperliquid'); if (h != null) hl.push(h);
      const d = executableReturn(first, later, 'dydx'); if (d != null) dydx.push(d);
      if (h != null && d != null) pairedAdvantages.push(d - h);
    }
    results[horizon] = {
      hyperliquidSamples: hl.length, hyperliquidMeanPct: mean(hl), hyperliquidMedianPct: median(hl),
      dydxSamples: dydx.length, dydxMeanPct: mean(dydx), dydxMedianPct: median(dydx),
      pairedSamples: pairedAdvantages.length, dydxMinusHyperliquidMeanPct: mean(pairedAdvantages),
      dydxMinusHyperliquidMedianPct: median(pairedAdvantages),
    };
  }
  return results;
}
function venueSpecific(selected) {
  const output = {};
  const sources = [...new Set(selected.map(row => row.sourceVenue).filter(Boolean))].sort();
  for (const source of sources) {
    output[source] = { ALL: summarizeGroups(groupSamples(selected.filter(row => row.sourceVenue === source))) };
    for (const direction of ['BULLISH', 'BEARISH']) {
      output[source][direction] = summarizeGroups(groupSamples(selected.filter(row => row.sourceVenue === source && row.direction === direction)));
    }
  }
  return output;
}
const results = summarizeGroups(bySignal);
const validationEpochAt = state?.validationEpochAt || null;
const cleanSamples = validationEpochAt ? samples.filter(row => Date.parse(row.at) >= Date.parse(validationEpochAt)) : [];
const delays = samples.map(row => Number(row.scheduleDelayMs)).filter(Number.isFinite);
const hlAges = samples.map(row => Number(row.hyperliquid?.bookAgeMs)).filter(Number.isFinite);
const dydxAges = samples.map(row => Number(row.dydx?.bookAgeMs)).filter(Number.isFinite);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(), startedAt: state?.startedAt || null, lastCycleAt: state?.lastCycleAt || null,
  streamHealth: state?.streamHealth || null, streamUniverse: state?.streamUniverse || null, totals: state?.totals || null, activeCases: Object.keys(state?.cases || {}).length,
  normalizedSamples: samples.length, missedHorizons,
  denseStreamChanges: state?.totals?.streamChanges ?? legacyDenseStreamChanges,
  legacyDenseStreamChanges, denseStreamChangesByVenue: state?.denseStreamChangesByVenue || {},
  errors, parseErrors, ledgerReadError,
  timing: { meanScheduleDelayMs: mean(delays), p95ScheduleDelayMs: delays.length ? [...delays].sort((a,b)=>a-b)[Math.floor((delays.length-1)*0.95)] : null, meanHyperliquidBookAgeMs: mean(hlAges), meanDydxBookAgeMs: mean(dydxAges) },
  afterSpreadExecutableReturns: results,
  allVenueAfterSpreadExecutableReturns: summarizeAllVenueReturns(bySignal),
  fillRatios: summarizeVenueExecution(samples),
  venueSpecificSimulations: venueSpecific(samples),
  cleanValidation: {
    instrumentationVersion: state?.instrumentationVersion || null,
    validationEpochAt,
    normalizedSamples: cleanSamples.length,
    venueSpecificSimulations: venueSpecific(cleanSamples),
  },
}, null, 2));
