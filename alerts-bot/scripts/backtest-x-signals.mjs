import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { classifyCatalystText, movementMetrics } from '../lib/x-signal-evaluation.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = resolve(projectDir, 'data', 'alert-ledger.jsonl');
const cacheDir = resolve(projectDir, 'backtest', 'x-market-cache');
const outputPath = resolve(projectDir, 'backtest', 'x-signal-keyword-results.json');
const reportPath = resolve(projectDir, 'backtest', 'X-SIGNAL-KEYWORD-REPORT.md');
const intervalMs = 5 * 60_000;
const horizons = [15, 60, 240, 1440];
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

async function fetchJson(url, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'XAlertsBacktest/1.0' }, signal: AbortSignal.timeout(15000) });
      if (response.ok) return response.json();
      if (response.status !== 429) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (attempt === attempts) throw error;
    }
    await wait(500 * attempt);
  }
  return null;
}

async function loadEvents() {
  const candidates = new Map();
  const decisions = new Map();
  const input = readline.createInterface({ input: createReadStream(ledgerPath), crlfDelay: Infinity });
  for await (const line of input) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'news_candidate' && String(event.source || '').startsWith('X ·')) candidates.set(event.id, event);
    if (event.type === 'editorial_decision') decisions.set(event.id, event);
  }
  return [...candidates.values()].flatMap(candidate => {
    const decision = decisions.get(candidate.id);
    const identity = decision?.tokenIdentity;
    if (!decision || !identity?.id || !(Number(identity.currentPrice) > 0) || !candidate.symbol) return [];
    const verdict = decision.verdict || {};
    const text = [candidate.headline, candidate.eventType, verdict.primary_subject, verdict.what_changed, verdict.rationale].filter(Boolean).join(' ');
    const catalyst = classifyCatalystText(text);
    return [{
      id: candidate.id, at: Date.parse(candidate.publishedAt), reviewedAt: Date.parse(decision.at), symbol: candidate.symbol,
      coinGeckoId: identity.id, identityPrice: Number(identity.currentPrice), approved: Boolean(decision.approved),
      editorialReason: decision.reason, direction: ['BULLISH', 'BEARISH'].includes(verdict.direction) ? verdict.direction : 'UNCLEAR',
      confidence: Number(verdict.confidence || 0), headline: candidate.headline, eventType: candidate.eventType,
      families: catalyst.families, keywords: catalyst.keywords,
    }];
  }).filter(event => Number.isFinite(event.at));
}

async function activeBybitSymbols() {
  const payload = await fetchJson('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
  return new Set((payload?.result?.list || []).filter(row => row.status === 'Trading' && row.quoteCoin === 'USDT').map(row => row.symbol));
}

async function candles(symbol, start, end) {
  const path = resolve(cacheDir, `${symbol}.json`);
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    // A moving "now" boundary should not invalidate every symbol cache on each
    // report run. Five-minute outcomes cannot use the unfinished edge anyway.
    if (cached.start <= start && cached.end >= end - 15 * 60_000) return cached.rows;
  } catch {}
  const rows = [];
  for (let cursor = Math.floor(start / intervalMs) * intervalMs; cursor <= end; cursor += 999 * intervalMs) {
    const windowEnd = Math.min(end, cursor + 998 * intervalMs);
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=5&start=${cursor}&end=${windowEnd}&limit=1000`;
    const payload = await fetchJson(url);
    for (const row of payload?.result?.list || []) rows.push({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]) });
    await wait(35);
  }
  const unique = [...new Map(rows.map(row => [row.t, row])).values()].sort((a, b) => a.t - b.t);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, JSON.stringify({ symbol, start, end, fetchedAt: new Date().toISOString(), rows: unique }));
  return unique;
}

const firstAtOrAfter = (rows, timestamp) => rows.find(row => row.t >= Math.ceil(timestamp / intervalMs) * intervalMs);

function dailyVolatility(rows, timestamp) {
  const before = rows.filter(row => row.t >= timestamp - 6 * 3600_000 && row.t < timestamp);
  if (before.length < 24) return null;
  const returns = [];
  for (let index = 1; index < before.length; index += 1) returns.push(Math.log(before[index].c / before[index - 1].c));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(288) * 100;
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = value => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(4));

function summary(rows, horizon) {
  const outcomes = rows.map(row => row.outcomes[horizon]).filter(Boolean);
  const absoluteRatios = outcomes.map(item => item.absoluteMovementToCatalystRatio).filter(Number.isFinite);
  const directionalRatios = outcomes.map(item => item.directionalMovementToCatalystRatio).filter(Number.isFinite);
  const abnormal = outcomes.map(item => item.abnormalReturnPct).filter(Number.isFinite);
  const directed = outcomes.map(item => item.directedAbnormalReturnPct).filter(Number.isFinite);
  return {
    n: outcomes.length,
    nWithDirection: directed.length,
    nWithVolatilityRatio: absoluteRatios.length,
    medianAbsAbnormalReturnPct: round(median(abnormal.map(Math.abs))),
    medianDirectedAbnormalReturnPct: round(median(directed)),
    medianAbsoluteMovementToCatalystRatio: round(median(absoluteRatios)),
    medianDirectionalMovementToCatalystRatio: round(median(directionalRatios)),
    absoluteRatioAtLeastOnePct: absoluteRatios.length ? round(absoluteRatios.filter(value => value >= 1).length / absoluteRatios.length * 100) : null,
    directionallyPositivePct: directed.length ? round(directed.filter(value => value > 0).length / directed.length * 100) : null,
  };
}

const grouped = (rows, key, horizon) => Object.fromEntries([...new Set(rows.flatMap(row => row[key]))].sort().map(name => {
  const selected = rows.filter(row => row[key].includes(name));
  return [name, summary(selected, horizon)];
}));

const events = await loadEvents();
const activeSymbols = await activeBybitSymbols();
const availableEvents = events.filter(event => activeSymbols.has(`${event.symbol}USDT`));
const symbols = [...new Set(availableEvents.map(event => event.symbol))];
const allStart = Math.min(...availableEvents.map(event => event.at)) - 7 * 3600_000;
const allEnd = Math.min(Date.now(), Math.max(...availableEvents.map(event => event.at)) + 25 * 3600_000);
const series = new Map();
for (const symbol of ['BTC', 'ETH', ...symbols.filter(symbol => !['BTC', 'ETH'].includes(symbol))]) {
  const symbolEvents = availableEvents.filter(event => event.symbol === symbol);
  const start = ['BTC', 'ETH'].includes(symbol) ? allStart : Math.min(...symbolEvents.map(event => event.at)) - 7 * 3600_000;
  const end = ['BTC', 'ETH'].includes(symbol) ? allEnd : Math.min(Date.now(), Math.max(...symbolEvents.map(event => event.at)) + 25 * 3600_000);
  try { series.set(symbol, await candles(`${symbol}USDT`, start, end)); }
  catch (error) { console.error(`candles unavailable ${symbol}: ${error instanceof Error ? error.message : String(error)}`); }
}

let identityMismatches = 0;
const evaluated = [];
for (const event of availableEvents) {
  const tokenRows = series.get(event.symbol) || [];
  const benchmarkSymbol = event.symbol === 'BTC' ? 'ETH' : 'BTC';
  const benchmarkRows = series.get(benchmarkSymbol) || [];
  const entry = firstAtOrAfter(tokenRows, event.at);
  const benchmarkEntry = firstAtOrAfter(benchmarkRows, event.at);
  if (!entry || !benchmarkEntry) continue;
  const priceDifference = Math.abs(entry.o / event.identityPrice - 1);
  if (priceDifference > 0.20) { identityMismatches += 1; continue; }
  const volatility = dailyVolatility(tokenRows, event.at);
  const outcomes = {};
  for (const horizon of horizons) {
    const exit = firstAtOrAfter(tokenRows, event.at + horizon * 60_000);
    const benchmarkExit = firstAtOrAfter(benchmarkRows, event.at + horizon * 60_000);
    if (!exit || !benchmarkExit) continue;
    const metrics = movementMetrics({ entryPrice: entry.o, exitPrice: exit.o, benchmarkEntryPrice: benchmarkEntry.o, benchmarkExitPrice: benchmarkExit.o, direction: event.direction, preEventDailyVolatilityPct: volatility, horizonMinutes: horizon });
    outcomes[horizon] = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, round(value)]));
  }
  evaluated.push({ ...event, publishedAt: new Date(event.at).toISOString(), reviewedAt: new Date(event.reviewedAt).toISOString(), venue: 'Bybit linear', preEventDailyVolatilityPct: round(volatility), outcomes });
}

const byHorizon = Object.fromEntries(horizons.map(horizon => [horizon, {
  approved: summary(evaluated.filter(event => event.approved), horizon),
  rejected: summary(evaluated.filter(event => !event.approved), horizon),
  byFamily: grouped(evaluated, 'families', horizon),
  byKeyword: grouped(evaluated.filter(event => event.keywords.length), 'keywords', horizon),
}]));
const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    eventTime: 'Official X publication time; entry is the open of the next five-minute candle.',
    prices: 'Bybit USDT linear perpetual five-minute candles; only verified tokens whose recorded identity price agreed within 20% are included.',
    benchmark: 'BTC, or ETH for BTC events.',
    ratio: 'Absolute catalyst impact and directional correctness are reported separately. Each is normalized by the expected move derived from six-hour pre-event realized volatility.',
    warning: 'Exploratory only. Venue coverage favors liquid perpetual assets, catalyst families overlap, and small groups must not drive production keyword removal.',
  },
  coverage: {
    verifiedReviewedXEvents: events.length, bybitListed: availableEvents.length, evaluated: evaluated.length,
    identityMismatches, unavailableOrUnmatched: events.length - availableEvents.length,
    approved: evaluated.filter(event => event.approved).length, rejected: evaluated.filter(event => !event.approved).length,
  },
  byHorizon,
  events: evaluated,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2));

const fourHour = byHorizon[240];
const lines = [
  '# X Alerts — Keyword and Catalyst Backtest', '', `Generated: ${report.generatedAt}`, '',
  '## Coverage', '',
  `- Verified reviewed X events: ${report.coverage.verifiedReviewedXEvents}`,
  `- Listed on the historical venue: ${report.coverage.bybitListed}`,
  `- Evaluated after identity-price validation: ${report.coverage.evaluated}`,
  `- Approved: ${report.coverage.approved}; rejected: ${report.coverage.rejected}`,
  `- Identity mismatches discarded: ${report.coverage.identityMismatches}`,
  '', '## Four-hour comparison', '',
  '| Cohort | N | Median abs abnormal | Median directional abnormal | Median movement/catalyst ratio | Ratio ≥ 1 |',
  '|---|---:|---:|---:|---:|---:|',
  ...[['Approved', fourHour.approved], ['Rejected', fourHour.rejected]].map(([name, value]) => `| ${name} | ${value.n} (${value.nWithDirection} directional) | ${value.medianAbsAbnormalReturnPct ?? '—'}% | ${value.medianDirectedAbnormalReturnPct ?? '—'}% | ${value.medianAbsoluteMovementToCatalystRatio ?? '—'} | ${value.absoluteRatioAtLeastOnePct ?? '—'}% |`),
  '', '## Four-hour catalyst families', '',
  '| Family | N | Median movement/catalyst ratio | Directionally positive |', '|---|---:|---:|---:|',
  ...Object.entries(fourHour.byFamily).sort((a, b) => b[1].n - a[1].n).map(([name, value]) => `| ${name} | ${value.n} | ${value.medianAbsoluteMovementToCatalystRatio ?? '—'} | ${value.directionallyPositivePct ?? '—'}% |`),
  '', '## Decision rule', '',
  'No production keyword should be removed until its semantic family has at least 30 completed, identity-validated observations and the result persists in a later chronological holdout sample.',
  '', '## Limitations', '', `- ${report.methodology.warning}`, '- Detailed event-level data and all horizons are stored in `x-signal-keyword-results.json`.',
];
await writeFile(reportPath, lines.join('\n'));
console.log(JSON.stringify({ coverage: report.coverage, fourHour: { approved: fourHour.approved, rejected: fourHour.rejected }, reportPath, outputPath }, null, 2));
