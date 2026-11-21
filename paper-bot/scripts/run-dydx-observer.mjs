import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDydxBook, fetchDydxMarkets } from '../src/dydx.mjs';
import { summarizeBook } from '../src/executable-quote.mjs';
import { fetchMarkets } from '../src/hyperliquid.mjs';
import { appendJsonl, readJson, readNewLines, writeJson } from '../src/storage.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(projectDir, 'config.dydx-observer.json'), 'utf8'));
const signalPath = resolve(projectDir, config.signalFile);
const dataDir = resolve(projectDir, 'data-dydx-observer');
const statePath = resolve(dataDir, 'state.json');
const eventPath = resolve(dataDir, 'events.jsonl');
const lockPath = resolve(dataDir, 'observer.lock');
const once = process.argv.includes('--once');
const state = await readJson(statePath, {
  startedAt: new Date().toISOString(), signalOffset: null, seenSignals: {}, observations: {},
  totals: { sourceSignals: 0, overlappingSignals: 0, unsupportedSignals: 0, samples: 0, sampleErrors: 0 },
  lastCycleAt: null, lastSuccessfulSampleAt: null,
});

await mkdir(dataDir, { recursive: true });
let lock;
for (let attempt = 0; attempt < 2; attempt += 1) {
  try { lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); break; }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let priorPid = 0;
    try { priorPid = Number((await readFile(lockPath, 'utf8')).trim()); } catch {}
    let alive = false;
    if (priorPid > 0) try { process.kill(priorPid, 0); alive = true; } catch {}
    if (alive) { console.log(`dYdX observer is already running (pid ${priorPid}).`); process.exit(0); }
    await unlink(lockPath).catch(() => {});
  }
}
if (!lock) throw new Error('Unable to acquire dYdX observer lock');
const cleanup = async () => { try { await lock?.close(); } catch {} try { await unlink(lockPath); } catch {} };
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

async function record(type, details = {}) {
  const event = { at: new Date().toISOString(), type, ...details };
  await appendJsonl(eventPath, event);
  console.log(JSON.stringify(event));
}

const signalId = row => String(row.signalId || `${row.alertedAt}:${row.market?.venue}:${row.market?.symbol}:${row.detection?.direction}`);
let catalogs = null;
let catalogsAt = 0;
async function getCatalogs(now, force = false) {
  if (!force && catalogs && now - catalogsAt < Number(config.catalogRefreshSeconds) * 1000) return catalogs;
  const [hyperliquid, dydx] = await Promise.all([fetchMarkets(), fetchDydxMarkets()]);
  catalogs = { hyperliquid, dydx };
  catalogsAt = now;
  return catalogs;
}

async function ingestSignals(now) {
  if (state.signalOffset == null) {
    try { state.signalOffset = (await stat(signalPath)).size; } catch { state.signalOffset = 0; }
    await record('OBSERVER_BASELINE', { signalPath, offset: state.signalOffset });
    return;
  }
  const update = await readNewLines(signalPath, state.signalOffset);
  state.signalOffset = update.offset;
  for (const line of update.lines) {
    let row;
    try { row = JSON.parse(line); } catch { await record('SOURCE_RECORD_ERROR', { reason: 'MALFORMED_JSON' }); continue; }
    if (!config.allowedSourceVenues.includes(row.market?.venue) || !row.detection?.eligible) continue;
    if (!['BULLISH', 'BEARISH'].includes(row.detection?.direction)) continue;
    const id = signalId(row);
    if (state.seenSignals[id]) continue;
    state.seenSignals[id] = now;
    state.totals.sourceSignals += 1;
    const symbol = String(row.market?.symbol || '').toUpperCase();
    let available;
    try { available = await getCatalogs(now); }
    catch (error) {
      state.totals.sampleErrors += 1;
      await record('CATALOG_ERROR', { signalId: id, symbol, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const hlMarket = available.hyperliquid.get(symbol);
    const dydxMarket = available.dydx.get(symbol);
    const hlActive = Boolean(hlMarket && !hlMarket.isDelisted);
    const dydxActive = Boolean(dydxMarket && (!dydxMarket.status || dydxMarket.status === 'ACTIVE'));
    if (!hlActive || !dydxActive) {
      state.totals.unsupportedSignals += 1;
      await record('SIGNAL_NOT_OVERLAPPING', { signalId: id, symbol, sourceVenue: row.market.venue, hyperliquidActive: hlActive, dydxActive });
      continue;
    }
    state.totals.overlappingSignals += 1;
    state.observations[id] = {
      id, symbol, dydxTicker: dydxMarket.ticker, sourceVenue: row.market.venue,
      direction: row.detection.direction, reason: row.detection.reason,
      alertedAt: row.alertedAt, sourceObservedAtMs: Number(row.market.observedAt) || null,
      receivedAtMs: now, sourcePrice: Number(row.market.price) || null,
      sourceMovePct: Number(row.detection.movePct) || null, completedHorizons: [],
    };
    await record('OBSERVATION_STARTED', { signalId: id, symbol, dydxTicker: dydxMarket.ticker, sourceVenue: row.market.venue, direction: row.detection.direction, alertReceiptLatencyMs: now - Date.parse(row.alertedAt) });
  }
}

function normalizeHyperliquidBook(payload) {
  const side = index => (payload?.levels?.[index] || []).map(row => ({ price: Number(row?.px), size: Number(row?.sz) })).filter(row => row.price > 0 && row.size > 0);
  return { bids: side(0), asks: side(1) };
}

async function fetchHyperliquidBook(symbol) {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'l2Book', coin: symbol }), signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return normalizeHyperliquidBook(await response.json());
}

async function sample(item, horizonSeconds, now) {
  const requestedAt = Date.now();
  try {
    const [hlBook, dydxBook] = await Promise.all([fetchHyperliquidBook(item.symbol), fetchDydxBook(item.dydxTicker)]);
    const available = await getCatalogs(now);
    const hlMarket = available.hyperliquid.get(item.symbol);
    const dydxMarket = available.dydx.get(item.symbol);
    const capturedAt = Date.now();
    state.totals.samples += 1;
    state.lastSuccessfulSampleAt = new Date(capturedAt).toISOString();
    await record('QUOTE_SAMPLE', {
      signalId: item.id, symbol: item.symbol, dydxTicker: item.dydxTicker,
      sourceVenue: item.sourceVenue, direction: item.direction, horizonSeconds,
      scheduledAtMs: item.receivedAtMs + horizonSeconds * 1000, requestedAtMs: requestedAt,
      capturedAtMs: capturedAt, scheduleDelayMs: requestedAt - (item.receivedAtMs + horizonSeconds * 1000),
      requestDurationMs: capturedAt - requestedAt,
      hyperliquid: { ...summarizeBook(hlBook, config.quoteNotionalUsd), mark: hlMarket?.mark || null, openInterest: hlMarket?.openInterest || null },
      dydx: { ...summarizeBook(dydxBook, config.quoteNotionalUsd), oraclePrice: dydxMarket?.oraclePrice || null, openInterest: dydxMarket?.openInterest || null },
    });
    return true;
  } catch (error) {
    state.totals.sampleErrors += 1;
    await record('QUOTE_SAMPLE_ERROR', { signalId: item.id, symbol: item.symbol, horizonSeconds, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function cycle() {
  const now = Date.now();
  await ingestSignals(now);
  for (const item of Object.values({ ...state.observations })) {
    for (const horizon of config.observationHorizonsSeconds) {
      if (item.completedHorizons.includes(horizon) || now < item.receivedAtMs + horizon * 1000) continue;
      const captured = await sample(item, horizon, now);
      if (!captured) break;
      item.completedHorizons.push(horizon);
    }
    if (item.completedHorizons.length === config.observationHorizonsSeconds.length) {
      delete state.observations[item.id];
      await record('OBSERVATION_COMPLETED', { signalId: item.id, symbol: item.symbol });
    }
  }
  const retention = now - Number(config.retentionDays) * 86_400_000;
  state.seenSignals = Object.fromEntries(Object.entries(state.seenSignals).filter(([, at]) => at >= retention));
  state.lastCycleAt = new Date(now).toISOString();
  await writeJson(statePath, state);
}

try {
  do {
    const started = Date.now();
    try { await cycle(); } catch (error) { await record('OBSERVER_CYCLE_ERROR', { error: error instanceof Error ? error.stack || error.message : String(error) }); }
    if (once) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.max(0, Number(config.pollMilliseconds) - (Date.now() - started))));
  } while (true);
} finally { await cleanup(); }
