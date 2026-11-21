import { open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachBook, fetchMarkets } from '../src/hyperliquid.mjs';
import { serializeMarkets } from '../src/shared-market-cache.mjs';
import { appendJsonl, readJson, writeJson } from '../src/storage.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(projectDir, 'data-v2r-shared-market');
const cachePath = resolve(dataDir, 'cache.json');
const eventPath = resolve(dataDir, 'events.jsonl');
const lockPath = resolve(dataDir, 'cache.lock');
const consumerDirs = ['data-v2r-bybit-confirmed', 'data-v2r-bybit-immediate', 'data-v2r-binance-confirmed', 'data-v2r-binance-immediate'];
const catalogIntervalMs = 15_000;
const cycleIntervalMs = 1_000;
let catalog = new Map();
let lastCatalogAtMs = 0;
let lastError = null;
let catalogRefreshPromise = null;
let catalogRefreshError = null;
const bookRefreshes = new Map();
const bookRefreshErrors = new Map();

await import('node:fs/promises').then(({ mkdir }) => mkdir(dataDir, { recursive: true }));
let lock;
for (let attempt = 0; attempt < 2; attempt += 1) {
  try { lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); break; }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let pid = 0; try { pid = Number((await readFile(lockPath, 'utf8')).trim()); } catch {}
    let alive = false; if (pid > 0) try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) { console.log(`Shared market cache is already running (pid ${pid}).`); process.exit(0); }
    await unlink(lockPath).catch(() => {});
  }
}
if (!lock) throw new Error('Unable to acquire shared market cache lock');
const cleanup = async () => { try { await lock.close(); } catch {} try { await unlink(lockPath); } catch {} };
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

async function record(type, details = {}) {
  await appendJsonl(eventPath, { at: new Date().toISOString(), type, ...details });
}

async function requiredSymbols() {
  const symbols = new Set();
  for (const dir of consumerDirs) {
    const state = await readJson(resolve(projectDir, dir, 'state.json'), {});
    for (const group of ['candidates', 'positions', 'rejectedObservations', 'postExitObservations', 'missedOpportunityShadowPositions']) {
      for (const item of Object.values(state[group] || {})) if (item?.symbol) symbols.add(item.symbol);
    }
  }
  return symbols;
}

async function refreshCatalog() {
  try {
    const refreshed = await fetchMarkets();
    // Preserve any recently fetched books while replacing catalog fields.
    for (const [symbol, market] of refreshed) {
      const previous = catalog.get(symbol);
      if (previous?.bookUpdatedAtMs) refreshed.set(symbol, {
        ...market,
        bid: previous.bid,
        ask: previous.ask,
        bidLevels: previous.bidLevels,
        askLevels: previous.askLevels,
        bookUpdatedAtMs: previous.bookUpdatedAtMs,
      });
    }
    catalog = refreshed;
    lastCatalogAtMs = Date.now();
    if (catalogRefreshError) await record('CATALOG_REFRESH_RECOVERED', { previousError: catalogRefreshError });
    catalogRefreshError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== catalogRefreshError) await record('CATALOG_REFRESH_ERROR', { error: message });
    catalogRefreshError = message;
  }
}

function scheduleCatalogRefresh() {
  if (catalogRefreshPromise) return catalogRefreshPromise;
  catalogRefreshPromise = refreshCatalog().finally(() => { catalogRefreshPromise = null; });
  return catalogRefreshPromise;
}

function scheduleBookRefresh(symbol) {
  if (bookRefreshes.has(symbol)) return;
  const market = catalog.get(symbol);
  if (!market) return;
  const refresh = (async () => {
    try {
      const updated = await attachBook(market);
      const current = catalog.get(symbol);
      if (current) catalog.set(symbol, { ...current, ...updated, bookUpdatedAtMs: Date.now() });
      const previousError = bookRefreshErrors.get(symbol);
      if (previousError) await record('BOOK_REFRESH_RECOVERED', { symbol, previousError });
      bookRefreshErrors.delete(symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== bookRefreshErrors.get(symbol)) await record('BOOK_REFRESH_ERROR', { symbol, error: message });
      bookRefreshErrors.set(symbol, message);
    }
  })().finally(() => { bookRefreshes.delete(symbol); });
  bookRefreshes.set(symbol, refresh);
}

async function cycle() {
  const now = Date.now();
  if (!catalog.size) throw new Error('Shared Hyperliquid catalog is unavailable');
  if (now - lastCatalogAtMs >= catalogIntervalMs) scheduleCatalogRefresh();
  const symbols = await requiredSymbols();
  for (const symbol of symbols) scheduleBookRefresh(symbol);
  await writeJson(cachePath, serializeMarkets(catalog, Date.now(), lastCatalogAtMs));
  if (lastError) { await record('CACHE_RECOVERED', { previousError: lastError }); lastError = null; }
}

await record('CACHE_STARTED', { catalogIntervalMs, cycleIntervalMs, consumerDirs });
await scheduleCatalogRefresh();
if (!catalog.size) throw new Error(`Unable to initialize shared Hyperliquid catalog${catalogRefreshError ? `: ${catalogRefreshError}` : ''}`);
try {
  while (true) {
    const started = Date.now();
    try { await cycle(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) await record('CACHE_ERROR', { error: message });
      lastError = message;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.max(0, cycleIntervalMs - (Date.now() - started))));
  }
} finally { await cleanup(); }
