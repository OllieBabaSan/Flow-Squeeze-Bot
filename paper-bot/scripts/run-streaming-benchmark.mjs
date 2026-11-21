import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDydxMarkets } from '../src/dydx.mjs';
import { summarizeBook } from '../src/executable-quote.mjs';
import { fetchMarkets } from '../src/hyperliquid.mjs';
import { DydxBookStream, HyperliquidBookStream, LighterBookStream, StreamPool } from '../src/stream-books.mjs';
import { appendJsonl, readJson, readNewLines, writeJson } from '../src/storage.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(projectDir, 'config.streaming-benchmark.json'), 'utf8'));
const signalPath = resolve(projectDir, config.signalFile);
const dataDir = resolve(projectDir, 'data-streaming-benchmark');
const statePath = resolve(dataDir, 'state.json');
const eventPath = resolve(dataDir, 'events.jsonl');
const lockPath = resolve(dataDir, 'benchmark.lock');
const state = await readJson(statePath, {
  startedAt: new Date().toISOString(), signalOffset: null, seenSignals: {}, cases: {},
  totals: { sourceSignals: 0, hyperliquidEligible: 0, dydxOverlaps: 0, unsupported: 0, normalizedSamples: 0, streamChanges: 0 },
  lastCycleAt: null,
});
await mkdir(dataDir, { recursive: true });
let lock;
for (let attempt = 0; attempt < 2; attempt += 1) {
  try { lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); break; }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let pid = 0; try { pid = Number((await readFile(lockPath, 'utf8')).trim()); } catch {}
    let alive = false; if (pid) try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) { console.log(`Streaming benchmark already running (pid ${pid}).`); process.exit(0); }
    await unlink(lockPath).catch(() => {});
  }
}
if (!lock) throw new Error('Unable to acquire streaming benchmark lock');
const cleanup = async () => { hl.close(); dydx.close(); lighter.close(); clearInterval(gmxTimer); try { await lock.close(); } catch {} try { await unlink(lockPath); } catch {} };
const record = async (type, details = {}) => { await appendJsonl(eventPath, { at: new Date().toISOString(), type, ...details }); };
const instrumentationVersion = 2;
if (state.instrumentationVersion !== instrumentationVersion) {
  state.instrumentationVersion = instrumentationVersion;
  state.validationEpochAt = new Date().toISOString();
  await record('BENCHMARK_VALIDATION_EPOCH', {
    instrumentationVersion,
    validationEpochAt: state.validationEpochAt,
    reason: 'VENUE_PAIR_SIMULATION_AND_SINGLE_COLLECTOR_BASELINE',
  });
}
const lighterInstrumentationVersion = 3;
if (state.lighterInstrumentationVersion !== lighterInstrumentationVersion) {
  state.lighterInstrumentationVersion = lighterInstrumentationVersion;
  state.lighterValidationEpochAt = new Date().toISOString();
  await record('LIGHTER_VALIDATION_EPOCH', { lighterInstrumentationVersion, validationEpochAt: state.lighterValidationEpochAt, reason: 'REJECT_STALE_CACHED_VENUE_BOOKS' });
}
const signalId = row => String(row.signalId || `${row.alertedAt}:${row.market?.venue}:${row.market?.symbol}:${row.detection?.direction}`);
let catalogs = null, catalogsAt = 0;
async function getCatalogs(now) {
  if (catalogs && now - catalogsAt < config.catalogRefreshSeconds * 1000) return catalogs;
  const [hyperliquid, dydxMarkets, lighterResponse, gmxResponse] = await Promise.all([
    fetchMarkets(), fetchDydxMarkets(),
    fetch('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails').then(response => response.json()),
    fetch('https://arbitrum-api.gmxinfra.io/markets/info').then(response => response.json()),
  ]);
  const lighterMarkets = new Map((lighterResponse.order_book_details || []).filter(row => row.market_type === 'perp' && row.status === 'active' && !row.is_frozen).map(row => [String(row.symbol).toUpperCase(), String(row.market_id)]));
  const gmxMarkets = new Map((gmxResponse.markets || []).filter(row => row.isListed).map(row => [String(row.name).split('/')[0].toUpperCase(), String(row.indexToken).toLowerCase()]));
  catalogs = { hyperliquid, dydx: dydxMarkets, lighter: lighterMarkets, gmx: gmxMarkets }; catalogsAt = now; return catalogs;
}

const activeByHl = new Map(), activeByDydx = new Map(), activeByLighter = new Map();
let lastStateWriteAt = 0;
function register(map, key, id) { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); }
function unregister(map, key, id) { map.get(key)?.delete(id); if (!map.get(key)?.size) map.delete(key); }
function streamChange(venue, key, value) {
  const ids = venue === 'Hyperliquid' ? activeByHl.get(key) : venue === 'dYdX' ? activeByDydx.get(key) : activeByLighter.get(key);
  if (!ids?.size) return;
  for (const id of ids) {
    const item = state.cases[id]; if (!item) continue;
    const elapsedMs = value.receivedAtMs - item.receivedAtMs;
    if (elapsedMs < 0 || elapsedMs > config.denseStreamSeconds * 1000) continue;
    // Dense book messages arrive much faster than disk writes can complete. The
    // old implementation launched an unawaited append for every update, which
    // built a large promise/write backlog and grew the ledger by hundreds of MB
    // per day. Horizon samples already preserve executable quotes; keep dense
    // activity as bounded counters instead of duplicating every raw update.
    state.totals.streamChanges += 1;
    state.denseStreamChangesByVenue ??= {};
    state.denseStreamChangesByVenue[venue] = (state.denseStreamChangesByVenue[venue] || 0) + 1;
    state.lastDenseStreamChangeAt = new Date(value.receivedAtMs).toISOString();
  }
}
const hl = new StreamPool(config.hyperliquidStreamShards, () => new HyperliquidBookStream(streamChange)).start();
const dydx = new StreamPool(config.dydxStreamShards, () => new DydxBookStream(streamChange), { lazy: true }).start();
const lighter = new StreamPool(config.lighterStreamShards || 2, () => new LighterBookStream(streamChange), { lazy: true }).start();
const gmxBooks = new Map(), gmxScales = new Map();
let gmxConnected = false, gmxErrors = 0, gmxLastRefreshAt = null, gmxLastError = null;
async function refreshGmx() {
  try {
    const rows = await fetch('https://arbitrum-api.gmxinfra.io/prices/tickers').then(response => response.json());
    for (const row of rows || []) {
      const symbol = String(row.tokenSymbol || '').replace('_deprecated', '').toUpperCase();
      if (!symbol || symbol.includes('_')) continue;
      const rawMin = Number(row.minPrice), rawMax = Number(row.maxPrice); if (!(rawMin > 0 && rawMax > 0)) continue;
      let scale = gmxScales.get(symbol);
      if (!scale) {
        const reference = hl.get(symbol)?.book?.bids?.[0]?.price;
        if (!reference) continue;
        const exponent = Math.round(Math.log10((rawMin + rawMax) / 2 / reference));
        scale = 10 ** exponent; gmxScales.set(symbol, scale);
      }
      gmxBooks.set(symbol, { book: { bids: [{ price: rawMin / scale, size: 1e12 }], asks: [{ price: rawMax / scale, size: 1e12 }] }, receivedAtMs: Date.now(), venueTimeMs: Number(row.updatedAt) || Number(row.timestamp) * 1000 || null, oracleOnly: true });
    }
    gmxConnected = true; gmxLastRefreshAt = new Date().toISOString();
  } catch (error) { gmxConnected = false; gmxErrors += 1; gmxLastError = { at: new Date().toISOString(), message: String(error) }; }
}
const gmxTimer = setInterval(refreshGmx, 1000); await refreshGmx();

async function primeStreams() {
  try {
    const available = await getCatalogs(Date.now());
    const hlSymbols = [...available.hyperliquid.values()].filter(market => !market.isDelisted).map(market => market.symbol);
    const dydxTickers = [...available.dydx.values()].filter(market => !market.status || market.status === 'ACTIVE').map(market => market.ticker);
    const dydxPrewarmed = config.prewarmDydxOrderbooks ? dydxTickers : [];
    for (const [index, symbol] of hlSymbols.entries()) {
      hl.subscribe(symbol);
      if (index > 0 && index % 25 === 0) await new Promise(resolve => setTimeout(resolve, 5));
    }
    for (const [index, ticker] of dydxPrewarmed.entries()) {
      dydx.subscribe(ticker);
      if (index > 0 && index % 25 === 0) await new Promise(resolve => setTimeout(resolve, 5));
    }
    state.streamUniverse = {
      hyperliquid: hlSymbols.length, dydxAvailable: dydxTickers.length, lighterAvailable: available.lighter.size, gmxAvailable: available.gmx.size,
      dydxPrewarmed: dydxPrewarmed.length, dydxMode: config.prewarmDydxOrderbooks ? 'PREWARMED' : 'ON_DEMAND',
      primedAt: new Date().toISOString(),
    };
    await record('BENCHMARK_STREAMS_PRIMED', state.streamUniverse);
  } catch (error) {
    await record('BENCHMARK_PRIME_ERROR', { error: error?.stack || String(error) });
  }
}
await primeStreams();

async function ingest(now) {
  if (state.signalPath !== signalPath) {
    const previousSignalPath = state.signalPath || null;
    state.signalPath = signalPath;
    state.signalOffset = (await stat(signalPath)).size;
    await record('BENCHMARK_SOURCE_REBASED', { previousSignalPath, signalPath, offset: state.signalOffset, reason: 'SOURCE_PATH_CHANGED_NO_HISTORICAL_REPLAY' });
    return;
  }
  if (state.signalOffset == null) {
    try { state.signalOffset = (await stat(signalPath)).size; } catch { state.signalOffset = 0; }
    await record('BENCHMARK_BASELINE', { signalPath, offset: state.signalOffset }); return;
  }
  const update = await readNewLines(signalPath, state.signalOffset); state.signalOffset = update.offset;
  for (const line of update.lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!config.allowedSourceVenues.includes(row.market?.venue) || !row.detection?.eligible || !['BULLISH', 'BEARISH'].includes(row.detection?.direction)) continue;
    const id = signalId(row); if (state.seenSignals[id]) continue;
    state.seenSignals[id] = now; state.totals.sourceSignals += 1;
    const symbol = String(row.market.symbol).toUpperCase();
    let available; try { available = await getCatalogs(now); } catch (error) { await record('BENCHMARK_CATALOG_ERROR', { signalId: id, symbol, error: String(error) }); continue; }
    const hlMarket = available.hyperliquid.get(symbol);
    if (!hlMarket || hlMarket.isDelisted) { state.totals.unsupported += 1; await record('BENCHMARK_UNSUPPORTED', { signalId: id, symbol, reason: 'NO_ACTIVE_HYPERLIQUID_MARKET' }); continue; }
    const dydxMarket = available.dydx.get(symbol);
    const dydxTicker = dydxMarket && (!dydxMarket.status || dydxMarket.status === 'ACTIVE') ? dydxMarket.ticker : null;
    state.totals.hyperliquidEligible += 1; if (dydxTicker) state.totals.dydxOverlaps += 1;
    state.cases[id] = {
      id, symbol, dydxTicker, lighterMarketId: available.lighter.get(symbol) || null, gmxSupported: available.gmx.has(symbol), sourceVenue: row.market.venue, direction: row.detection.direction,
      reason: row.detection.reason, alertedAt: row.alertedAt, sourceObservedAtMs: Number(row.market.observedAt) || null,
      sourcePrice: Number(row.market.price), sourceMovePct: Number(row.detection.movePct), receivedAtMs: now,
      completedHorizons: [],
    };
    register(activeByHl, symbol, id); hl.subscribe(symbol);
    if (dydxTicker) { register(activeByDydx, dydxTicker, id); dydx.subscribe(dydxTicker); }
    if (state.cases[id].lighterMarketId) { register(activeByLighter, state.cases[id].lighterMarketId, id); lighter.subscribe(state.cases[id].lighterMarketId); }
    await record('BENCHMARK_CASE_STARTED', { signalId: id, symbol, dydxTicker, sourceVenue: row.market.venue, direction: row.detection.direction, alertReceiptLatencyMs: now - Date.parse(row.alertedAt) });
  }
}

async function cycle() {
  const now = Date.now(); await ingest(now);
  for (const item of Object.values({ ...state.cases })) {
    for (const horizon of config.observationHorizonsSeconds) {
      if (item.completedHorizons.includes(horizon) || now < item.receivedAtMs + horizon * 1000) continue;
      const scheduledAtMs = item.receivedAtMs + horizon * 1000;
      const graceMs = horizon <= 30 ? 1000 : horizon <= 120 ? 2000 : 5000;
      const hlBook = hl.get(item.symbol); const dydxBook = item.dydxTicker ? dydx.get(item.dydxTicker) : null;
      const lighterBook = item.lighterMarketId ? lighter.get(item.lighterMarketId) : null; const gmxBook = item.gmxSupported ? gmxBooks.get(item.symbol) : null;
      if (!hlBook && now <= scheduledAtMs + graceMs) break;
      if (!hlBook || hlBook.receivedAtMs > scheduledAtMs + 100) {
        item.completedHorizons.push(horizon);
        await record('BENCHMARK_MISSED_HORIZON', {
          signalId: item.id, symbol: item.symbol, horizonSeconds: horizon, scheduledAtMs,
          reason: hlBook ? 'FIRST_BOOK_ARRIVED_AFTER_HORIZON' : 'NO_HYPERLIQUID_BOOK_WITHIN_GRACE',
          firstAvailableBookAtMs: hlBook?.receivedAtMs ?? null,
        });
        continue;
      }
      const capturedAtMs = Date.now();
      const freshForSchedule = value => value && value.receivedAtMs <= scheduledAtMs + 100 && scheduledAtMs - value.receivedAtMs <= config.maxVenueBookAgeMilliseconds;
      await record('BENCHMARK_SAMPLE', {
        signalId: item.id, symbol: item.symbol, sourceVenue: item.sourceVenue, direction: item.direction,
        horizonSeconds: horizon, scheduledAtMs, capturedAtMs,
        scheduleDelayMs: capturedAtMs - scheduledAtMs,
        hyperliquid: { ...summarizeBook(hlBook.book, config.quoteNotionalUsd), bookReceivedAtMs: hlBook.receivedAtMs, venueTimeMs: hlBook.venueTimeMs, bookAgeMs: capturedAtMs - hlBook.receivedAtMs },
        dydx: freshForSchedule(dydxBook) ? { ...summarizeBook(dydxBook.book, config.quoteNotionalUsd), bookReceivedAtMs: dydxBook.receivedAtMs, bookAgeMs: capturedAtMs - dydxBook.receivedAtMs } : null,
        lighter: freshForSchedule(lighterBook) ? { ...summarizeBook(lighterBook.book, config.quoteNotionalUsd), bookReceivedAtMs: lighterBook.receivedAtMs, bookAgeMs: capturedAtMs - lighterBook.receivedAtMs } : null,
        gmx: freshForSchedule(gmxBook) ? { ...summarizeBook(gmxBook.book, config.quoteNotionalUsd), bookReceivedAtMs: gmxBook.receivedAtMs, bookAgeMs: capturedAtMs - gmxBook.receivedAtMs, oracleOnly: true } : null,
      });
      item.completedHorizons.push(horizon); state.totals.normalizedSamples += 1;
    }
    if (item.completedHorizons.length === config.observationHorizonsSeconds.length) {
      unregister(activeByHl, item.symbol, item.id); if (item.dydxTicker) unregister(activeByDydx, item.dydxTicker, item.id);
      if (item.lighterMarketId) unregister(activeByLighter, item.lighterMarketId, item.id);
      if (item.dydxTicker && !activeByDydx.has(item.dydxTicker)) dydx.unsubscribe(item.dydxTicker);
      if (item.lighterMarketId && !activeByLighter.has(item.lighterMarketId)) lighter.unsubscribe(item.lighterMarketId);
      delete state.cases[item.id]; await record('BENCHMARK_CASE_COMPLETED', { signalId: item.id, symbol: item.symbol });
    }
  }
  const retention = now - config.retentionDays * 86_400_000;
  state.seenSignals = Object.fromEntries(Object.entries(state.seenSignals).filter(([, at]) => at >= retention));
  state.lastCycleAt = new Date(now).toISOString(); state.streamHealth = {
    hyperliquidConnected: hl.connected, dydxConnected: dydx.connected, lighterConnected: lighter.connected, gmxConnected, gmxLastRefreshAt, gmxErrors, gmxLastError,
    hyperliquidReconnects: hl.reconnects, dydxReconnects: dydx.reconnects,
    hyperliquidShards: hl.details, dydxShards: dydx.details, lighterShards: lighter.details,
  };
  if (now - lastStateWriteAt >= config.stateWriteMilliseconds) {
    await writeJson(statePath, state);
    lastStateWriteAt = now;
  }
}

process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
try { while (true) { const started = Date.now(); try { await cycle(); } catch (error) { await record('BENCHMARK_CYCLE_ERROR', { error: error?.stack || String(error) }); } await new Promise(r => setTimeout(r, Math.max(0, config.pollMilliseconds - (Date.now() - started)))); } } finally { await cleanup(); }
