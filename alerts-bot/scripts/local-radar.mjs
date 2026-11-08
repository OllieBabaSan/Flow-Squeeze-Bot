import { unlinkSync } from 'node:fs';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlertLedger } from '../lib/alert-ledger.mjs';
import { fetchJsonBounded } from '../lib/bounded-json-fetch.mjs';
import { createBreakoutOutcomeStore } from '../lib/breakout-outcome-store.mjs';
import { BREAKOUT_ADMISSION_VERSION, evaluateBreakoutAdmission } from '../lib/breakout-admission.mjs';
import { preliminaryBreakout, relativeVolume, updateBreakoutSeries } from '../lib/breakout-observer.mjs';
import { buildBreakoutFeed } from '../lib/breakout-feed.mjs';
import { evaluateBreakoutQuality } from '../lib/breakout-quality.mjs';
import { createCmcDerivativesClient } from '../lib/cmc-derivatives.mjs';
import { roleMention } from '../lib/discord-mentions.mjs';
import { sendDiscordWebhook } from '../lib/discord-webhook.mjs';
import { createFlowTrackingPosition, evaluateFlowFollowUp, flowAlertLabel } from '../lib/flow-alert-lifecycle.mjs';
import { createFlowConfirmationCandidate, evaluateFlowConfirmation } from '../lib/flow-confirmation.mjs';
import { evaluateFastMoveShadow, FLOW_FAST_MOVE_SHADOW_VERSION } from '../lib/flow-fast-move-shadow.mjs';
import { detectFlowIgnition, isFlowPriceCandidate, normalizeBinanceMarkets, normalizeBitgetMarkets, normalizeBybitMarkets, normalizeHyperliquidMarkets, normalizeOkxMarkets } from '../lib/flow-detector.mjs';
import { classifyMarketRegime, evaluateRegimePublication } from '../lib/market-regime.mjs';
import { findPerpDexVenues, perpDexAlertField, refreshPerpDexCatalogs } from '../lib/perp-dex-discovery.mjs';
import { readJsonWithBackup, writeJsonAtomic } from '../lib/state-file.mjs';
import { createRateLimitBackoff, flowAlertCooldownMs } from '../lib/runtime-policy.mjs';
import { contractAddressLabel, hasVerifiedContract, isMemeToken, registryLabel, resolveTrackedToken } from '../lib/token-registry.mjs';
import { updateVenueHealth, venueHealthSummary } from '../lib/venue-health.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, 'data');
const configuredRuntimeRole = String(process.env.FLOW_RUNTIME_ROLE || 'combined').toLowerCase();
const paths = { state: resolve(data, 'flow-state.json'), breakoutState: resolve(data, 'breakout-observer-state.json'), breakoutFeed: resolve(data, 'breakout-live-feed.json'), breakoutOutcomes: resolve(data, 'breakout-outcomes.sqlite3'), venueHealth: resolve(data, configuredRuntimeRole === 'breakout' ? 'breakout-venue-health.json' : 'venue-health.json'), venueHealthHistory: resolve(data, configuredRuntimeRole === 'breakout' ? 'breakout-venue-health-history.jsonl' : 'venue-health-history.jsonl'), log: resolve(data, configuredRuntimeRole === 'breakout' ? 'breakout-observer.log' : 'flow-squeeze.log'), history: resolve(data, 'flow-alert-history.jsonl'), regimeShadow: resolve(data, 'flow-regime-shadow.jsonl'), confirmationShadow: resolve(data, 'flow-confirmation-shadow.jsonl'), fastMoveShadow: resolve(data, 'flow-fast-move-shadow.jsonl'), breakoutShadow: resolve(data, 'breakout-shadow.jsonl'), breakoutAdmissionShadow: resolve(data, 'breakout-admission-shadow.jsonl'), lock: resolve(data, configuredRuntimeRole === 'breakout' ? 'breakout-observer.lock' : 'flow-squeeze.lock') };
const ledger = createAlertLedger({ ledgerPath: resolve(data, 'flow-alert-ledger.jsonl'), outcomeStatePath: resolve(data, 'flow-alert-outcomes.json'), outcomeArchivePath: resolve(data, 'flow-alert-outcomes-archive.jsonl') });
const breakoutStore = createBreakoutOutcomeStore({ databasePath: paths.breakoutOutcomes, maximumActiveRecords: Number(process.env.BREAKOUT_MAX_ACTIVE_RECORDS || 2000) });
const once = process.argv.includes('--once');
const dryRun = process.argv.includes('--dry-run');
let cmcClient;
let breakoutRuntime;
let breakoutPersistBucket;
let venueHealthRuntime;
const hyperliquidBackoff = createRateLimitBackoff();
let breakoutMaintenanceBucket;
const CMC_LIQUIDATION_CHECKPOINT_MINUTES = [2, 5, 10, 15, 30, 60, 120];

function nextCmcLiquidationCheckpoint(position, now) {
  if (!Object.hasOwn(position, 'cmcLiquidationBaseline')) return 0;
  const completed = position.cmcLiquidationCheckpoints || {};
  const elapsedMinutes = Math.max(0, (now - Number(position.entryAt)) / 60000);
  return CMC_LIQUIDATION_CHECKPOINT_MINUTES.find(minutes => elapsedMinutes >= minutes && !completed[minutes]) ?? null;
}

function compactCmcExchangeContext(context, previous) {
  const tracked = new Set(['binance', 'bybit', 'hyperliquid', 'okx', 'bitget']);
  const aggregateOpenInterestUsd = Number(context.aggregateOpenInterestUsd || 0);
  const previousOpenInterestUsd = Number(previous?.aggregateOpenInterestUsd || 0);
  return {
    schemaVersion: 1,
    detectorVersion: 'cmc-derivatives-context-v1',
    publicationStatus: 'SHADOW_ONLY',
    capturedAt: context.capturedAt,
    latestUpdated: context.latestUpdated,
    exchangeCount: context.exchangeCount,
    aggregateOpenInterestUsd,
    aggregateDerivativeVolumeUsd: Number(context.aggregateDerivativeVolumeUsd || 0),
    openInterestChangePct: previousOpenInterestUsd > 0 ? (aggregateOpenInterestUsd / previousOpenInterestUsd - 1) * 100 : null,
    previousCapturedAt: previous?.capturedAt || null,
    trackedExchanges: context.exchanges.filter(row => tracked.has(String(row.slug || '').toLowerCase())),
  };
}

function numericSetting(value, fallback, minimum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function unitRateSetting(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function breakoutAdmissionSettings() {
  return {
    cooldownMs: numericSetting(process.env.BREAKOUT_ADMISSION_COOLDOWN_MINUTES, 60, 1) * 60_000,
    rates: {
      QUALIFIED_SHADOW: unitRateSetting(process.env.BREAKOUT_ADMISSION_QUALIFIED_RATE, 1),
      WATCH_SHADOW: unitRateSetting(process.env.BREAKOUT_ADMISSION_WATCH_RATE, 0.1),
      LOW_QUALITY_SHADOW: unitRateSetting(process.env.BREAKOUT_ADMISSION_LOW_QUALITY_RATE, 0.05),
      ACTIVITY_MISSING_SHADOW: unitRateSetting(process.env.BREAKOUT_ADMISSION_ACTIVITY_MISSING_RATE, 0.05),
    },
  };
}

function fastMoveShadowSettings() {
  return {
    enabled: String(process.env.FLOW_FAST_MOVE_SHADOW || 'true').toLowerCase() !== 'false',
    rules: {
      minimumAgeSeconds: numericSetting(process.env.FLOW_FAST_MOVE_MIN_AGE_SECONDS, 20, 10),
      maximumAgeSeconds: numericSetting(process.env.FLOW_FAST_MOVE_MAX_AGE_SECONDS, 59, 20),
      minimumMovePct: numericSetting(process.env.FLOW_FAST_MOVE_MIN_MOVE_PCT, 0.5, 0.25),
      maximumSpreadBps: numericSetting(process.env.FLOW_FAST_MOVE_MAX_SPREAD_BPS, 15, 1),
      minimumFreshTurnoverUsd: numericSetting(process.env.FLOW_FAST_MOVE_MIN_TURNOVER_USD, 500_000, 100_000),
      minimumDetectionOiGrowthPct: numericSetting(process.env.FLOW_FAST_MOVE_MIN_OI_GROWTH_PCT, 0.3, 0.1),
    },
  };
}

function cmcCryptoId(position) {
  const provider = String(position?.tokenIdentity?.provider || '');
  const id = String(position?.tokenIdentity?.id || '');
  return provider.startsWith('CoinMarketCap') && /^\d+$/.test(id) ? id : null;
}

async function environment() {
  for (const file of ['.env.local', '.env']) try {
    for (const raw of (await readFile(resolve(root, file), 'utf8')).split(/\r?\n/)) {
      const line = raw.trim(); if (!line || line.startsWith('#')) continue;
      const at = line.indexOf('='); if (at < 1) continue;
      process.env[line.slice(0, at).trim()] ||= line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}
async function log(message) { const line = `${new Date().toISOString()} ${message}`; await mkdir(data, { recursive: true }); await writeFile(paths.log, `${line}\n`, { flag: 'a' }); console.log(line); }
async function lock() {
  await mkdir(data, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) try {
    const handle = await open(paths.lock, 'wx'); await handle.writeFile(String(process.pid)); await handle.close();
    process.on('exit', () => { try { unlinkSync(paths.lock); } catch {} }); return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error; let pid = 0; try { pid = Number(await readFile(paths.lock, 'utf8')); } catch {}
    if (pid) try { process.kill(pid, 0); return false; } catch {} await unlink(paths.lock).catch(() => {});
  }
  return false;
}
const loadState = () => readJsonWithBackup(paths.state, { snapshots: {}, symbolAlerted: {}, flowTracking: {} });
const saveState = state => writeJsonAtomic(paths.state, state);

async function markets(now) {
  const calls = [
    ['Bybit', async () => { const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear', { signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return normalizeBybitMarkets(await r.json(), now); }],
    ['Hyperliquid', async () => {
      const remaining = hyperliquidBackoff.remainingMs(now);
      if (remaining) throw new Error(`rate-limit backoff ${Math.ceil(remaining / 1000)}s`);
      const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(12000) });
      if (!r.ok) {
        hyperliquidBackoff.reject(r.status, r.headers.get('retry-after'), now);
        throw new Error(`HTTP ${r.status}`);
      }
      hyperliquidBackoff.success();
      return normalizeHyperliquidMarkets(await r.json(), now);
    }],
  ];
  const results = await Promise.allSettled(calls.map(async ([venue, call]) => {
    const startedAt = Date.now();
    try { return { venue, rows: await call(), durationMs: Date.now() - startedAt }; }
    catch (error) { error.venueDurationMs = Date.now() - startedAt; throw error; }
  }));
  const rows = results.flatMap(result => result.status === 'fulfilled' ? result.value.rows : []);
  const venueReports = results.map((result, index) => result.status === 'fulfilled'
    ? { venue: result.value.venue, status: 'HEALTHY', marketCount: result.value.rows.length, durationMs: result.value.durationMs }
    : { venue: calls[index][0], status: 'FAILED', marketCount: 0, durationMs: result.reason?.venueDurationMs, error: result.reason?.message || String(result.reason) });
  const destinationCatalogs = {
    bybit: new Map(rows.filter(market => market.venue === 'Bybit').map(market => [market.symbol, market])),
    hyperliquid: new Map(rows.filter(market => market.venue === 'Hyperliquid').map(market => [market.symbol, market])),
    binance: new Map(),
  };
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`${calls[index][0]}: ${result.reason?.message || result.reason}`] : []);
  if (!rows.length) throw new Error('All Flow/Squeeze venues failed');
  const hyperliquidSymbols = new Set(rows.filter(market => market.venue === 'Hyperliquid').map(market => market.symbol));
  if (String(process.env.BINANCE_FLOW_SHADOW_ENABLED || 'true').toLowerCase() !== 'false') {
    const venueStartedAt = Date.now();
    try {
      const [exchangeResponse, tickerResponse, premiumResponse, bookResponse] = await Promise.all([
        fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: AbortSignal.timeout(12000) }),
        fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { signal: AbortSignal.timeout(12000) }),
        fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { signal: AbortSignal.timeout(12000) }),
        fetch('https://fapi.binance.com/fapi/v1/ticker/bookTicker', { signal: AbortSignal.timeout(12000) }),
      ]);
      if (!exchangeResponse.ok || !tickerResponse.ok || !premiumResponse.ok || !bookResponse.ok) throw new Error(`metadata HTTP ${exchangeResponse.status}/${tickerResponse.status}/${premiumResponse.status}/${bookResponse.status}`);
      const [exchange, tickers, premiums, books] = await Promise.all([exchangeResponse.json(), tickerResponse.json(), premiumResponse.json(), bookResponse.json()]);
      const tickerBySymbol = new Map((tickers || []).map(row => [row.symbol, row]));
      const premiumBySymbol = new Map((premiums || []).map(row => [row.symbol, row]));
      const bookBySymbol = new Map((books || []).map(row => [row.symbol, row]));
      for (const instrument of exchange.symbols || []) {
        if (instrument?.contractType !== 'PERPETUAL' || instrument?.quoteAsset !== 'USDT' || instrument?.status !== 'TRADING') continue;
        const symbol = String(instrument.baseAsset || instrument.symbol?.replace(/USDT$/, '') || '');
        const ticker = tickerBySymbol.get(instrument.symbol);
        const premium = premiumBySymbol.get(instrument.symbol);
        const book = bookBySymbol.get(instrument.symbol);
        if (!symbol || !ticker) continue;
        destinationCatalogs.binance.set(symbol, {
          symbol,
          venueSymbol: instrument.symbol,
          price: Number(premium?.markPrice || ticker.lastPrice),
          turnover24h: Number(ticker.quoteVolume),
          bestBid: Number(book?.bidPrice),
          bestAsk: Number(book?.askPrice),
        });
      }
      const eligibleContracts = (exchange.symbols || []).filter(row => {
        if (row?.contractType !== 'PERPETUAL' || row?.quoteAsset !== 'USDT' || row?.status !== 'TRADING') return false;
        const symbol = String(row.baseAsset || row.symbol?.replace(/USDT$/, '') || '');
        const turnover = Number(tickerBySymbol.get(row.symbol)?.quoteVolume || 0);
        return hyperliquidSymbols.has(symbol) && turnover >= 10_000_000 && turnover <= 500_000_000;
      });
      const requestedOiConcurrency = Number(process.env.BINANCE_OI_CONCURRENCY || 8);
      const oiConcurrency = Number.isFinite(requestedOiConcurrency) ? Math.max(2, Math.min(12, requestedOiConcurrency)) : 8;
      const oiFetch = await fetchJsonBounded(eligibleContracts, async row => {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(row.symbol)}`, { signal: AbortSignal.timeout(7000) });
        if (!response.ok) {
          const error = new Error(`${row.symbol} HTTP ${response.status}`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        return response.json();
      }, { concurrency: oiConcurrency, retries: Number(process.env.BINANCE_OI_RETRIES || 2) });
      const oiResults = oiFetch.results;
      rows.push(...normalizeBinanceMarkets({ tickers, premiums, openInterests: oiResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : []), symbols: eligibleContracts }, now));
      const oiFailures = oiResults.filter(result => result.status === 'rejected').length;
      const retriedRequests = oiFetch.attemptsByItem.filter(attempts => attempts > 1).length;
      const retryAttempts = oiFetch.retriesUsed;
      if (oiFailures) failures.push(`Binance: ${oiFailures}/${oiResults.length} open-interest requests failed`);
      venueReports.push({ venue: 'Binance', status: oiFailures ? 'PARTIAL' : 'HEALTHY', marketCount: rows.filter(market => market.venue === 'Binance').length, durationMs: Date.now() - venueStartedAt, failedRequests: oiFailures, totalRequests: oiResults.length, retriedRequests, retryAttempts, concurrency: oiConcurrency });
    } catch (error) {
      failures.push(`Binance: ${error.message || error}`);
      venueReports.push({ venue: 'Binance', status: 'FAILED', marketCount: 0, durationMs: Date.now() - venueStartedAt, error: error.message || String(error) });
    }
  }
  if (String(process.env.OKX_FLOW_SHADOW_ENABLED || 'true').toLowerCase() !== 'false') {
    const venueStartedAt = Date.now();
    try {
      const [tickerResponse, oiResponse] = await Promise.all([
        fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP', { signal: AbortSignal.timeout(12000) }),
        fetch('https://www.okx.com/api/v5/public/open-interest?instType=SWAP', { signal: AbortSignal.timeout(12000) }),
      ]);
      if (!tickerResponse.ok || !oiResponse.ok) throw new Error(`metadata HTTP ${tickerResponse.status}/${oiResponse.status}`);
      const tickers = (await tickerResponse.json()).data || [];
      const openInterests = (await oiResponse.json()).data || [];
      const eligibleTickers = tickers.filter(row => {
        const match = /^(.+)-USDT-SWAP$/.exec(String(row.instId || ''));
        const price = Number(row.last); const turnover = Number(row.volCcy24h) * price;
        return match && hyperliquidSymbols.has(match[1]) && turnover >= 10_000_000 && turnover <= 500_000_000;
      });
      const fundingRates = [];
      for (let index = 0; index < eligibleTickers.length; index += 10) {
        const batch = eligibleTickers.slice(index, index + 10);
        const fundingResults = await Promise.allSettled(batch.map(async row => {
          const response = await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(row.instId)}`, { signal: AbortSignal.timeout(12000) });
          if (!response.ok) throw new Error(`${row.instId} HTTP ${response.status}`);
          return (await response.json()).data?.[0];
        }));
        fundingRates.push(...fundingResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []));
        if (index + 10 < eligibleTickers.length) await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
      }
      rows.push(...normalizeOkxMarkets({ tickers: eligibleTickers, openInterests, fundingRates }, now));
      const fundingFailures = eligibleTickers.length - fundingRates.length;
      if (fundingFailures) failures.push(`OKX: ${fundingFailures}/${eligibleTickers.length} funding requests failed`);
      venueReports.push({ venue: 'OKX', status: fundingFailures ? 'PARTIAL' : 'HEALTHY', marketCount: rows.filter(market => market.venue === 'OKX').length, durationMs: Date.now() - venueStartedAt, failedRequests: fundingFailures, totalRequests: eligibleTickers.length });
    } catch (error) {
      failures.push(`OKX: ${error.message || error}`);
      venueReports.push({ venue: 'OKX', status: 'FAILED', marketCount: 0, durationMs: Date.now() - venueStartedAt, error: error.message || String(error) });
    }
  }
  if (String(process.env.BITGET_FLOW_SHADOW_ENABLED || 'true').toLowerCase() !== 'false') {
    const venueStartedAt = Date.now();
    try {
      const response = await fetch('https://api.bitget.com/api/v3/market/tickers?category=USDT-FUTURES', { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bitgetRows = normalizeBitgetMarkets(await response.json(), now).filter(market => hyperliquidSymbols.has(market.symbol)
        && market.turnover24h >= 10_000_000 && market.turnover24h <= 500_000_000);
      rows.push(...bitgetRows);
      venueReports.push({ venue: 'Bitget', status: 'HEALTHY', marketCount: bitgetRows.length, durationMs: Date.now() - venueStartedAt });
    } catch (error) {
      failures.push(`Bitget: ${error.message || error}`);
      venueReports.push({ venue: 'Bitget', status: 'FAILED', marketCount: 0, durationMs: Date.now() - venueStartedAt, error: error.message || String(error) });
    }
  }
  rows.failures = failures;
  rows.venueReports = venueReports;
  rows.destinationCatalogs = destinationCatalogs;
  return rows;
}
async function enrich(market, since) {
  if (market.venue === 'Bybit') {
    const symbol = `${market.symbol}USDT`; const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=1&start=${since}&limit=10`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Bybit candles HTTP ${r.status}`); const body = await r.json();
    return { ...market, intervalTurnoverUsd: (body?.result?.list || []).filter(row => Number(row[0]) >= since).reduce((sum, row) => sum + Number(row[6] || 0), 0) };
  }
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: market.symbol, interval: '1m', startTime: since, endTime: Date.now() } }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Hyperliquid candles HTTP ${r.status}`); const body = await r.json();
  return { ...market, intervalTurnoverUsd: body.reduce((sum, row) => sum + Number(row.v || 0) * Number(row.c || market.price), 0) };
}
async function breakoutActivity(market, now = Date.now()) {
  const bucketMs = 5 * 60_000;
  let candles;
  if (market.venue === 'Bybit') {
    const response = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(`${market.symbol}USDT`)}&interval=5&limit=25`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Bybit breakout candles HTTP ${response.status}`);
    const body = await response.json();
    candles = (body?.result?.list || []).map(row => ({ start: Number(row[0]), turnover: Number(row[6] || 0) }));
  } else if (market.venue === 'Binance') {
    const venueSymbol = market.venueSymbol || `${market.symbol}USDT`;
    const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(venueSymbol)}&interval=5m&limit=25`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Binance breakout candles HTTP ${response.status}`);
    candles = (await response.json()).map(row => ({ start: Number(row[0]), turnover: Number(row[7] || 0) }));
  } else if (market.venue === 'Hyperliquid') {
    const response = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: market.symbol, interval: '5m', startTime: now - 3 * 3600_000, endTime: now } }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Hyperliquid breakout candles HTTP ${response.status}`);
    candles = (await response.json()).map(row => ({ start: Number(row.t), turnover: Number(row.v || 0) * Number(row.c || market.price) }));
  } else return { relativeActivity: null, activitySource: 'UNSUPPORTED_VENUE' };
  candles.sort((left, right) => left.start - right.start);
  const bucketStart = Math.floor(now / bucketMs) * bucketMs;
  const completed = candles.filter(row => row.start < bucketStart).slice(-20);
  const current = candles.find(row => row.start === bucketStart);
  const elapsedFraction = Math.max(0.1, Math.min(1, (now - bucketStart) / bucketMs));
  const projectedCurrentTurnover = current ? current.turnover / elapsedFraction : null;
  return {
    relativeActivity: relativeVolume(projectedCurrentTurnover, completed.map(row => row.turnover)),
    currentBucketTurnover: current?.turnover ?? null,
    projectedCurrentTurnover,
    activityBaselineBars: completed.length,
    activitySource: 'PROJECTED_CURRENT_5M_VS_PRIOR_5M',
  };
}
async function discord(title, description, fields, direction) {
  return sendDiscordWebhook({
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    payload: { username: 'Flow/Squeeze Bot', ...roleMention(process.env.DISCORD_ALERT_ROLE_ID), embeds: [{ title, description, fields, color: direction === 'BULLISH' ? 0x3ddc97 : 0xef5b5b, timestamp: new Date().toISOString() }] },
  });
}
async function initial(market, detection, identity, allMarkets) {
  const kind = flowAlertLabel(detection); const squeeze = kind === 'SQUEEZE PRESSURE';
  const countertrend = detection.regimePolicy?.countertrend;
  const description = squeeze ? `Potential ${detection.direction.toLowerCase()} squeeze setup—not confirmed. Confirmation requires covering or forced-liquidation evidence.` : `${detection.direction} directional flow detected.`;
  return discord(`EARLY ${countertrend ? 'COUNTERTREND ' : ''}${kind} · ${detection.direction} · ${market.symbol}`, `${description}${countertrend ? ' Broader conditions are bearish; this signal passed stronger countertrend requirements and may be short-lived.' : ''}`, [
    { name: 'Project / entity', value: registryLabel(identity) }, { name: 'Token address', value: contractAddressLabel(identity) }, { name: 'Direction', value: detection.direction, inline: true },
    { name: 'Price displacement', value: `${detection.movePct.toFixed(1)}%`, inline: true }, { name: 'Fresh turnover', value: `$${Math.round(detection.freshTurnover).toLocaleString()}`, inline: true },
    { name: 'Open-interest change', value: `${detection.oiGrowthPct.toFixed(1)}%`, inline: true }, { name: 'Venue', value: market.venueLabel, inline: true },
    { name: 'Market regime', value: detection.regime?.state || 'UNKNOWN', inline: true },
    { name: 'Perp DEX availability', value: perpDexAlertField(findPerpDexVenues(market.symbol, allMarkets, undefined, market.price)) },
  ], detection.direction);
}
async function scan() {
  const now = Date.now();
  const runtimeRole = configuredRuntimeRole;
  const flowEnabled = runtimeRole !== 'breakout';
  const breakoutEnabled = runtimeRole !== 'alerts';
  const state = await loadState(); state.snapshots ||= {}; state.symbolAlerted ||= {}; state.shadowAlerted ||= {}; state.regimeSuppressed ||= {}; state.confirmationRejected ||= {}; state.flowCandidates ||= {}; state.flowTracking ||= {};
  if (breakoutEnabled && !breakoutRuntime) breakoutRuntime = await readJsonWithBackup(paths.breakoutState, { series: state.breakoutSeries || {}, observed: state.breakoutObserved || {} });
  if (breakoutEnabled) {
    breakoutRuntime.series ||= {}; breakoutRuntime.observed ||= {};
    breakoutRuntime.activeSince ||= {}; breakoutRuntime.activity ||= {}; breakoutRuntime.episodes ||= {}; breakoutRuntime.recentAdmissions ||= {};
  }
  delete state.breakoutSeries; delete state.breakoutObserved;
  const breakoutBucket = Math.floor(now / (5 * 60_000));
  const alertCooldownMs = flowAlertCooldownMs();
  if (!cmcClient && process.env.COINMARKETCAP_API_KEY) cmcClient = createCmcDerivativesClient({
    apiKey: process.env.COINMARKETCAP_API_KEY,
    exchangeContextCacheMs: numericSetting(process.env.CMC_CONTEXT_INTERVAL_MINUTES, 15, 5) * 60_000,
    monthlyCreditReserve: numericSetting(process.env.CMC_MONTHLY_CREDIT_RESERVE, 1500, 500),
  });
  void refreshPerpDexCatalogs({ now }).catch(() => []);
  const rows = await markets(now);
  venueHealthRuntime ||= await readJsonWithBackup(paths.venueHealth, { venues: {} });
  const venueHealthUpdate = updateVenueHealth(venueHealthRuntime, rows.venueReports, now);
  venueHealthRuntime = venueHealthUpdate.state;
  await writeJsonAtomic(paths.venueHealth, venueHealthRuntime);
  if (venueHealthUpdate.events.length) await writeFile(paths.venueHealthHistory, `${venueHealthUpdate.events.map(event => JSON.stringify(event)).join('\n')}\n`, { flag: 'a' });
  const regime = classifyMarketRegime(rows);
  const byKey = new Map(rows.map(row => [`${row.venue}:${row.symbol}`, row]));
  const quotes = new Map(); const breakoutQueue = []; const activeBreakouts = [];
  let sent = 0; let regimeSuppressed = 0; let confirmationStarted = 0; let confirmationRejected = 0; let breakoutObserved = 0;
  const trackedPositions = flowEnabled ? Object.values(state.flowTracking) : [];
  const cmcDuePositions = trackedPositions.filter(position => nextCmcLiquidationCheckpoint(position, now) != null);
  let cmcLiquidationsReady = false;
  if (cmcClient && cmcDuePositions.length) try {
    await cmcClient.primeLiquidations({ force: true });
    cmcLiquidationsReady = true;
  } catch (error) {
    await log(`liquidation_evidence_unavailable error=${error.message || error}`);
  }
  for (const [id, position] of flowEnabled ? Object.entries(state.flowTracking) : []) {
    const market = byKey.get(position.quoteKey); if (!market) continue;
    const cmcCheckpointMinutes = nextCmcLiquidationCheckpoint(position, now);
    if (cmcClient && cmcLiquidationsReady && cmcCheckpointMinutes != null) {
      const current = cmcClient.peekLiquidationEvidence(position.symbol, position.direction, { cryptoId: cmcCryptoId(position) });
      position.cmcLiquidationCheckpoints ||= {};
      if (cmcCheckpointMinutes === 0) {
        position.cmcLiquidationBaseline = current;
        position.cmcLiquidationCheckpoints.baseline = current.capturedAt || new Date(now).toISOString();
        position.cmcLiquidationEvidence = { available: false, source: 'POST_ALERT_DELTA', reason: 'BASELINE_ESTABLISHED' };
      } else {
        position.cmcLiquidationEvidence = cmcClient.liquidationDeltaEvidence(current, position.cmcLiquidationBaseline, position.direction);
        position.cmcLiquidationCheckpoints[cmcCheckpointMinutes] = current.capturedAt || new Date(now).toISOString();
      }
      await ledger.append({
        type: 'cmc_candidate_context', detectorVersion: 'cmc-derivatives-context-v1', publicationStatus: 'SHADOW_ONLY',
        id, symbol: position.symbol, direction: position.direction, checkpointMinutes: cmcCheckpointMinutes,
        baseline: position.cmcLiquidationBaseline, current, delta: position.cmcLiquidationEvidence,
      });
    }
    const liquidationEvidence = position.cmcLiquidationEvidence || { available: false, source: 'POST_ALERT_DELTA', reason: 'BASELINE_PENDING' };
    const update = evaluateFlowFollowUp(position, market, liquidationEvidence, now); if (!update) continue;
    Object.assign(position, { peakDirectedMovePct: update.evidence.peakDirectedMovePct, stage: update.stage, updatedAt: now });
    if (update.event === 'SQUEEZE_CONFIRMED') position.confirmedAt = now;
    if ('exhaustionCandidateAt' in update) {
      if (update.exhaustionCandidateAt == null) delete position.exhaustionCandidateAt;
      else position.exhaustionCandidateAt = update.exhaustionCandidateAt;
    }
    if (update.event && !dryRun) { const discordReceipt = await discord(`${update.event.replaceAll('_', ' ')} · ${position.direction} · ${position.symbol}`, 'Follow-up to the earlier squeeze-pressure alert.', [{ name: 'Price since alert', value: `${update.evidence.directedMovePct.toFixed(2)}%` }, { name: 'Open-interest change', value: update.evidence.oiChangePct == null ? 'Unavailable' : `${update.evidence.oiChangePct.toFixed(2)}%` }], position.direction); await ledger.append({ type: 'flow_follow_up', id, event: update.event, evidence: update.evidence, discordReceipt }); }
    if (update.stage === 'CLOSED') delete state.flowTracking[id];
  }
  const hyperliquidSymbols = new Set(rows.filter(row => row.venue === 'Hyperliquid').map(row => row.symbol));
  for (let market of rows) {
    const key = `${market.venue}:${market.symbol}`; quotes.set(key, market.price); const previous = state.snapshots[key];
    const recent = market.shadow ? state.shadowAlerted[key] : state.symbolAlerted[key];
    const inBreakoutUniverse = ['Bybit', 'Binance'].includes(market.venue) && hyperliquidSymbols.has(market.symbol);
    if (breakoutEnabled && inBreakoutUniverse) {
      const series = updateBreakoutSeries(breakoutRuntime.series[key], market, now);
      breakoutRuntime.series[key] = series;
      const breakout = preliminaryBreakout(series, market, now);
      if (breakout.eligible) {
        breakoutRuntime.activeSince[key] ||= now;
        let episode = breakoutRuntime.episodes[key];
        if (!episode || episode.direction !== breakout.direction || now - Number(episode.lastSeenAt || 0) > 15 * 60_000) {
          episode = { id: `breakout-shadow:${key}:${breakout.direction}:${now}`, direction: breakout.direction, firstSeenAt: now, lastSeenAt: now, recorded: false };
          breakoutRuntime.episodes[key] = episode;
        } else episode.lastSeenAt = now;
        activeBreakouts.push({ key, market, breakout, series, firstSeenAt: episode.firstSeenAt, episodeId: episode.id });
        if (!episode.recorded) breakoutQueue.push({ key, market, breakout, episode });
      } else delete breakoutRuntime.activeSince[key];
    }
    if (!flowEnabled) continue;
    if (!market.shadow && isFlowPriceCandidate(market, previous, now)) try { market = await enrich(market, previous.observedAt); } catch (error) { await log(`enrichment_failed ${key} ${error.message}`); }
    let rawDetection;
    const candidate = !market.shadow ? state.flowCandidates[key] : null;
    let confirmationCandidateId = null;
    let confirmationDispositionRecorded = false;
    const recordConfirmationDisposition = async (status, details = {}) => {
      if (!confirmationCandidateId || confirmationDispositionRecorded) return;
      confirmationDispositionRecorded = true;
      await ledger.append({ type: 'confirmation_disposition', id: confirmationCandidateId, status, key, ...details });
      await log(`flow_confirmation_disposition ${key} status=${status}${details.reason ? ` reason=${details.reason}` : ''}`);
    };
    if (candidate) {
      const confirmation = evaluateFlowConfirmation(candidate, market, now);
      candidate.peakDirectedMovePct = confirmation.metrics.peakDirectedMovePct;
      const fastMoveSettings = fastMoveShadowSettings();
      if (fastMoveSettings.enabled && !candidate.fastMoveShadow) {
        const fastMove = evaluateFastMoveShadow(candidate, market, regime, now, fastMoveSettings.rules);
        if (fastMove.action === 'QUALIFY_SHADOW') {
          const fastId = `${candidate.id}:fast-move`;
          candidate.fastMoveShadow = { id: fastId, qualifiedAt: new Date(now).toISOString(), version: FLOW_FAST_MOVE_SHADOW_VERSION, ...fastMove };
          const fastRecord = {
            schemaVersion: 1, detectorVersion: FLOW_FAST_MOVE_SHADOW_VERSION, signalId: fastId,
            parentSignalId: candidate.id, publicationStatus: 'FAST_MOVE_SHADOW',
            createdAt: new Date(candidate.detectedAt).toISOString(), qualifiedAt: new Date(now).toISOString(),
            marketAtDetection: candidate.market, marketAtQualification: market,
            detection: candidate.detection, regime, fastMove,
          };
          await ledger.reserve({ id: fastId, kind: 'fast-move-shadow', symbol: market.symbol, direction: candidate.direction,
            entryPrice: market.price, entryOpenInterest: market.openInterest, entryAt: new Date(now).toISOString(),
            quoteKey: key, venue: market.venue, shadow: true, parentSignalId: candidate.id,
            detectorVersion: FLOW_FAST_MOVE_SHADOW_VERSION, trigger: fastRecord });
          const fastWrites = await Promise.allSettled([
            ledger.delivery(fastId, 'fast-move-shadow'),
            writeFile(paths.fastMoveShadow, `${JSON.stringify(fastRecord)}\n`, { flag: 'a' }),
          ]);
          const fastFailure = fastWrites.find(result => result.status === 'rejected');
          if (fastFailure) throw fastFailure.reason;
          await log(`flow_fast_move_shadow ${key} direction=${candidate.direction} move=${fastMove.metrics.movePct.toFixed(2)} age=${fastMove.metrics.ageSeconds.toFixed(0)}s spreadBps=${fastMove.metrics.spreadBps.toFixed(1)}`);
        }
      }
      if (confirmation.action === 'WAIT') { state.snapshots[key] = market; continue; }
      const resolution = { schemaVersion: 1, detectorVersion: 'flow-ignition-v2-confirmation-v1', signalId: candidate.id, publicationStatus: confirmation.action === 'PUBLISH' ? 'CONFIRMATION_PASSED' : 'CONFIRMATION_REJECTED', createdAt: new Date(candidate.detectedAt).toISOString(), resolvedAt: new Date(now).toISOString(), marketAtDetection: candidate.market, marketAtResolution: market, detection: candidate.detection, confirmation, fastMoveShadow: candidate.fastMoveShadow || null };
      const writes = await Promise.allSettled([ledger.delivery(candidate.id, confirmation.action === 'PUBLISH' ? 'confirmation-passed' : 'confirmation-rejected', { confirmation }), writeFile(paths.confirmationShadow, `${JSON.stringify(resolution)}\n`, { flag: 'a' })]);
      const failure = writes.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
      delete state.flowCandidates[key];
      if (confirmation.action === 'REJECT') {
        state.confirmationRejected[key] = now; confirmationRejected++;
        await log(`flow_confirmation_rejected ${key} direction=${candidate.direction} reason=${confirmation.reason} move=${confirmation.metrics.movePct.toFixed(2)} age=${confirmation.metrics.ageSeconds.toFixed(0)}s`);
        state.snapshots[key] = market; continue;
      }
      rawDetection = { ...candidate.detection, confirmation };
      confirmationCandidateId = candidate.id;
      await log(`flow_confirmation_passed ${key} direction=${candidate.direction} move=${confirmation.metrics.movePct.toFixed(2)} age=${confirmation.metrics.ageSeconds.toFixed(0)}s`);
    } else {
      rawDetection = detectFlowIgnition(market, previous, now);
      const recentlyRejected = state.confirmationRejected[key] && now - state.confirmationRejected[key] < 3600_000;
      if (rawDetection.eligible && !market.shadow && rawDetection.reason === 'rising_open_interest' && !recentlyRejected && !(recent && now - recent < alertCooldownMs)) {
        const candidateId = `flow-confirmation-shadow:${key}:${now}`;
        const flowCandidate = createFlowConfirmationCandidate({ id: candidateId, key, market, detection: rawDetection, now });
        flowCandidate.market = market; state.flowCandidates[key] = flowCandidate; await saveState(state);
        await ledger.reserve({ id: candidateId, kind: 'flow', symbol: market.symbol, direction: rawDetection.direction, entryPrice: market.price, entryOpenInterest: market.openInterest, entryAt: new Date(now).toISOString(), quoteKey: key, venue: market.venue, shadow: true, trigger: rawDetection });
        confirmationStarted++; await log(`flow_confirmation_started ${key} direction=${rawDetection.direction}`);
        state.snapshots[key] = market; continue;
      }
      if (rawDetection.eligible && !market.shadow && rawDetection.reason === 'rising_open_interest' && recentlyRejected) { state.snapshots[key] = market; continue; }
    }
    const regimePolicy = evaluateRegimePublication(rawDetection, regime);
    const detection = { ...rawDetection, regime, regimePolicy };
    const recentlySuppressed = state.regimeSuppressed[key] && now - state.regimeSuppressed[key] < alertCooldownMs;
    if (detection.eligible && !market.shadow && !regimePolicy.publish && !recentlySuppressed) {
      const id = `flow-regime-shadow:${key}:${now}`; const createdAt = new Date(now).toISOString();
      state.regimeSuppressed[key] = now; await saveState(state);
      await ledger.reserve({ id, kind: 'flow', symbol: market.symbol, direction: detection.direction, entryPrice: market.price, entryOpenInterest: market.openInterest, entryAt: createdAt, quoteKey: key, venue: market.venue, shadow: true, trigger: detection });
      const record = { schemaVersion: 1, detectorVersion: 'flow-ignition-v2-regime-v1', signalId: id, publicationStatus: 'REGIME_SUPPRESSED', createdAt, recordedAt: new Date().toISOString(), market, detection };
      const writes = await Promise.allSettled([ledger.delivery(id, 'regime-suppressed'), writeFile(paths.regimeShadow, `${JSON.stringify(record)}\n`, { flag: 'a' })]);
      const failure = writes.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
      await recordConfirmationDisposition('REGIME_SUPPRESSED', { reason: regimePolicy.reason, regime: regime.state, shadowId: id });
      regimeSuppressed++; await log(`regime_suppressed ${key} direction=${detection.direction} regime=${regime.state} reason=${regimePolicy.reason}`);
    }
    if (detection.eligible && !(recent && now - recent < alertCooldownMs)) {
      if (!regimePolicy.publish) {
        await recordConfirmationDisposition('REGIME_SUPPRESSED', { reason: regimePolicy.reason, regime: regime.state });
        state.snapshots[key] = market; continue;
      }
      const identity = await resolveTrackedToken(market.symbol, { referencePrice: market.price });
      if (identity && (!isMemeToken(identity) || hasVerifiedContract(identity))) {
        const id = `${market.shadow ? 'flow-shadow' : 'flow'}:${key}:${now}`; const createdAt = new Date(now).toISOString();
        if (market.shadow) state.shadowAlerted[key] = now; else state.symbolAlerted[key] = now;
        await saveState(state);
        await ledger.reserve({ id, kind: 'flow', symbol: market.symbol, direction: detection.direction, entryPrice: market.price, entryOpenInterest: market.openInterest, entryAt: createdAt, quoteKey: key, venue: market.venue, shadow: Boolean(market.shadow), trigger: detection });
        const publicationStatus = dryRun ? 'DRY_RUN' : market.shadow ? 'SHADOW' : 'PUBLISHED';
        const detectorVersion = detection.confirmation ? 'flow-ignition-v2-confirmation-v1' : 'flow-ignition-v2-regime-v1';
        const historyWrite = () => writeFile(paths.history, `${JSON.stringify({ schemaVersion: 1, detectorVersion, signalId: id, publicationStatus, createdAt, alertedAt: createdAt, recordedAt: new Date().toISOString(), market: { ...market, tokenIdentity: identity }, detection })}\n`, { flag: 'a' });
        if (!dryRun && market.shadow) {
          const writes = await Promise.allSettled([ledger.delivery(id, 'shadow'), historyWrite()]);
          const failure = writes.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
          await recordConfirmationDisposition('SHADOW_RECORDED', { alertId: id });
          await log(`shadow_candidate ${key} direction=${detection.direction}`);
        } else if (!dryRun) {
          const discordReceipt = await initial(market, detection, identity, rows);
          const tracking = createFlowTrackingPosition({ id, market, detection, tokenIdentity: identity, now });
          if (tracking.kind === 'SQUEEZE_PRESSURE') state.flowTracking[id] = tracking;
          const writes = await Promise.allSettled([ledger.delivery(id, 'sent', { discordReceipt }), historyWrite()]);
          const failure = writes.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
          await recordConfirmationDisposition('PUBLISHED', { alertId: id, discordMessageId: discordReceipt?.messageId || null });
          sent++;
        } else {
          const writes = await Promise.allSettled([ledger.delivery(id, 'dry-run'), historyWrite()]);
          const failure = writes.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
          await recordConfirmationDisposition('DRY_RUN', { alertId: id });
        }
      } else {
        await recordConfirmationDisposition('TOKEN_IDENTITY_REJECTED', { reason: !identity ? 'TOKEN_IDENTITY_UNRESOLVED' : 'MEME_CONTRACT_UNVERIFIED' });
      }
    } else if (confirmationCandidateId) {
      await recordConfirmationDisposition('COOLDOWN_SUPPRESSED', { reason: 'RECENT_SYMBOL_ALERT' });
    }
    state.snapshots[key] = market;
  }
  // Shadow enrichment runs only after the live Flow/Squeeze publication loop,
  // so research API latency can never delay a production alert in this scan.
  const enrichedBreakouts = breakoutEnabled ? await Promise.all(breakoutQueue.slice(0, 8).map(async candidate => {
    try { return { ...candidate, activity: await breakoutActivity(candidate.market, now) }; }
    catch (error) { return { ...candidate, activity: { relativeActivity: null, activitySource: 'UNAVAILABLE', activityError: error.message || String(error) } }; }
  })) : [];
  for (const candidate of enrichedBreakouts) breakoutRuntime.activity[candidate.key] = { ...candidate.activity, updatedAt: now };
  const activityByKey = new Map(Object.entries(breakoutRuntime?.activity || {}));
  for (const { key, market, breakout, activity, episode } of enrichedBreakouts) {
    const id = episode.id; const createdAt = new Date(episode.firstSeenAt).toISOString();
    const observationBase = { ...breakout, ...activity, regime, publicationStatus: 'SHADOW_ONLY' };
    const qualityGate = evaluateBreakoutQuality({ observation: observationBase, market, regime });
    const admissionSettings = breakoutAdmissionSettings();
    const researchAdmission = evaluateBreakoutAdmission({ episodeId: id, episodeKey: key, direction: breakout.direction, qualityStatus: qualityGate.status, now, recentAdmissions: breakoutRuntime.recentAdmissions, ...admissionSettings });
    const observation = { ...observationBase, qualityGate, researchAdmission: { ...researchAdmission, version: BREAKOUT_ADMISSION_VERSION } };
    const admissionDecision = {
      schemaVersion: 1,
      detectorVersion: BREAKOUT_ADMISSION_VERSION,
      cohortVersion: 'breakout-quality-shadow-v2-admission-v1',
      signalId: id,
      publicationStatus: 'ADMISSION_SHADOW',
      createdAt,
      evaluatedAt: new Date(now).toISOString(),
      venue: market.venue,
      symbol: market.symbol,
      direction: breakout.direction,
      qualityStatus: qualityGate.status,
      qualityScore: qualityGate.score,
      admission: researchAdmission,
    };
    await writeFile(paths.breakoutAdmissionShadow, `${JSON.stringify(admissionDecision)}\n`, { flag: 'a' });
    if (!researchAdmission.admitted) {
      episode.recorded = true;
      episode.admissionDisposition = researchAdmission.reason;
      await log(`breakout_shadow_suppressed ${key} reason=${researchAdmission.reason} qualityStatus=${qualityGate.status}`);
      continue;
    }
    const admission = await breakoutStore.reserve({ id, episodeKey: `${key}:${breakout.direction}:${episode.firstSeenAt}`, symbol: market.symbol, direction: breakout.direction, entryPrice: market.price, entryAt: createdAt, quoteKey: key, venue: market.venue, trigger: observation });
    if (!admission.admitted) { await log(`breakout_shadow_suppressed ${key} reason=${admission.reason}`); continue; }
    const record = { schemaVersion: 1, detectorVersion: 'breakout-observer-v1-quality-shadow-v2-admission-v1', cohortVersion: 'breakout-quality-shadow-v2-admission-v1', signalId: id, publicationStatus: 'SHADOW_ONLY', createdAt, recordedAt: new Date().toISOString(), market, observation };
    const writes = await Promise.allSettled([breakoutStore.delivery(id, 'breakout-shadow'), writeFile(paths.breakoutShadow, `${JSON.stringify(record)}\n`, { flag: 'a' })]);
    const failure = writes.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
    episode.recorded = true;
    breakoutRuntime.recentAdmissions[researchAdmission.cooldownKey] = now;
    breakoutObserved++; await log(`breakout_shadow ${key} direction=${breakout.direction} clearanceAtr=${breakout.clearanceAtr.toFixed(2)} oiContext=${breakout.derivativesContext} relativeActivity=${activity.relativeActivity == null ? 'n/a' : activity.relativeActivity.toFixed(2)} quality=${qualityGate.score} qualityStatus=${qualityGate.status}`);
  }
  // CMC is secondary research context. It runs after the publication loop so
  // its latency or failure can never delay an alert in the current scan.
  if (flowEnabled && cmcClient) try {
    const currentContext = await cmcClient.exchangeContext();
    if (currentContext.capturedAt !== state.cmcDerivativesContext?.capturedAt) {
      const compact = compactCmcExchangeContext(currentContext, state.cmcDerivativesContext);
      state.cmcDerivativesContext = compact;
      await ledger.append({ type: 'cmc_derivatives_context', ...compact });
      await log(`cmc_derivatives_context exchanges=${compact.exchangeCount} aggregateOiUsd=${compact.aggregateOpenInterestUsd.toFixed(0)} oiChangePct=${compact.openInterestChangePct == null ? 'n/a' : compact.openInterestChangePct.toFixed(4)}`);
    }
  } catch (error) {
    await log(`cmc_derivatives_context_unavailable error=${error.message || error}`);
  }
  if (flowEnabled && cmcClient && (!state.cmcCreditTelemetryAt || now - Number(state.cmcCreditTelemetryAt) >= 3600_000)) try {
    const creditStatus = await cmcClient.creditStatus();
    state.cmcCreditTelemetryAt = now;
    state.cmcCreditStatus = { ...creditStatus, capturedAt: new Date(now).toISOString() };
    await ledger.append({ type: 'cmc_credit_status', detectorVersion: 'cmc-credit-telemetry-v1', ...state.cmcCreditStatus });
    await log(`cmc_credit_status used=${creditStatus.creditsUsed ?? 'n/a'} left=${creditStatus.creditsLeft ?? 'n/a'} reserve=${creditStatus.reserve} reserveReached=${creditStatus.reserveReached ?? 'unknown'}`);
  } catch (error) {
    state.cmcCreditTelemetryAt = now;
    state.cmcCreditStatus = { available: false, error: String(error.message || error), capturedAt: new Date(now).toISOString() };
    await ledger.append({ type: 'cmc_credit_status', detectorVersion: 'cmc-credit-telemetry-v1', ...state.cmcCreditStatus });
    await log(`cmc_credit_status_unavailable error=${error.message || error}`);
  }
  const unenrichedPosition = flowEnabled && cmcClient
    ? Object.values(state.flowTracking).find(position => !Object.hasOwn(position, 'cmcDerivativesEvidence'))
    : null;
  if (unenrichedPosition) try {
    const derivativesEvidence = await cmcClient.derivativesEvidence(unenrichedPosition.symbol, { cryptoId: cmcCryptoId(unenrichedPosition) });
    unenrichedPosition.cmcDerivativesEvidence = derivativesEvidence;
    await ledger.append({
      type: 'cmc_candidate_derivatives_context', detectorVersion: 'cmc-derivatives-context-v1', publicationStatus: 'SHADOW_ONLY',
      id: unenrichedPosition.id, symbol: unenrichedPosition.symbol, direction: unenrichedPosition.direction, derivativesEvidence,
    });
  } catch (error) {
    unenrichedPosition.cmcDerivativesEvidence = { available: false, error: String(error.message || error), capturedAt: new Date(now).toISOString() };
    await log(`cmc_candidate_derivatives_context_unavailable symbol=${unenrichedPosition.symbol} error=${error.message || error}`);
  }
  const keep = now - 24 * 3600_000; state.symbolAlerted = Object.fromEntries(Object.entries(state.symbolAlerted).filter(([, at]) => at >= keep)); state.shadowAlerted = Object.fromEntries(Object.entries(state.shadowAlerted).filter(([, at]) => at >= keep)); state.regimeSuppressed = Object.fromEntries(Object.entries(state.regimeSuppressed).filter(([, at]) => at >= keep)); state.confirmationRejected = Object.fromEntries(Object.entries(state.confirmationRejected).filter(([, at]) => at >= now - 3600_000)); state.flowCandidates = Object.fromEntries(Object.entries(state.flowCandidates).filter(([, item]) => now - Number(item.detectedAt) <= 10 * 60_000)); state.flowTracking = Object.fromEntries(Object.entries(state.flowTracking).filter(([, item]) => Number(item.entryAt) >= keep));
  if (breakoutEnabled) {
    breakoutRuntime.observed = {}; breakoutRuntime.series = Object.fromEntries(Object.entries(breakoutRuntime.series).filter(([, series]) => now - Number(series.updatedAt) <= 3 * 3600_000)); const activeKeys = new Set(activeBreakouts.map(candidate => candidate.key)); breakoutRuntime.activeSince = Object.fromEntries(Object.entries(breakoutRuntime.activeSince).filter(([key]) => activeKeys.has(key))); breakoutRuntime.activity = Object.fromEntries(Object.entries(breakoutRuntime.activity).filter(([key, item]) => activeKeys.has(key) || now - Number(item.updatedAt) <= 4 * 3600_000)); breakoutRuntime.episodes = Object.fromEntries(Object.entries(breakoutRuntime.episodes).filter(([, episode]) => now - Number(episode.lastSeenAt || 0) <= 15 * 60_000)); breakoutRuntime.recentAdmissions = Object.fromEntries(Object.entries(breakoutRuntime.recentAdmissions).filter(([, admittedAt]) => now - Number(admittedAt) <= 2 * 3600_000));
  }
  const venueSummary = ['Bybit', 'Hyperliquid', 'Binance', 'OKX', 'Bitget'].map(venue => `${venue}=${rows.filter(row => row.venue === venue).length}`).join(' ');
  if (flowEnabled) await saveState(state);
  if (breakoutEnabled && (breakoutPersistBucket !== breakoutBucket || breakoutObserved)) {
    await writeJsonAtomic(paths.breakoutState, breakoutRuntime); breakoutPersistBucket = breakoutBucket;
  }
  const scanIntervalSeconds = Math.max(20, Number(process.env.FLOW_POLL_SECONDS || 20));
  if (breakoutEnabled) await writeJsonAtomic(paths.breakoutFeed, buildBreakoutFeed({
    active: activeBreakouts.map(candidate => {
      const activity = activityByKey.get(candidate.key);
      const qualityGate = evaluateBreakoutQuality({ observation: { ...candidate.breakout, ...activity }, market: candidate.market, regime });
      return { ...candidate, activity, qualityGate };
    }),
    destinationCatalogs: rows.destinationCatalogs,
    regime,
    marketCount: rows.filter(row => !row.shadow).length,
    now,
    scanIntervalSeconds,
  }));
  if (flowEnabled) await ledger.observe('flow', quotes, now);
  if (flowEnabled) await ledger.observe('fast-move-shadow', quotes, now);
  let breakoutTelemetry = null;
  if (breakoutEnabled) {
    await breakoutStore.observe(quotes, now);
    const maintenanceBucket = Math.floor(now / 86400_000);
    if (breakoutMaintenanceBucket !== maintenanceBucket) {
      const requestedRetentionDays = Number(process.env.BREAKOUT_RETENTION_DAYS || 90);
      const retentionDays = Number.isFinite(requestedRetentionDays) ? Math.max(30, requestedRetentionDays) : 90;
      const maintenance = await breakoutStore.maintain({ completedBeforeMs: now - retentionDays * 86400_000 });
      breakoutMaintenanceBucket = maintenanceBucket;
      await log(`breakout_maintenance retentionDays=${retentionDays} prunedRecords=${maintenance.prunedRecords} prunedOutcomes=${maintenance.prunedOutcomes}`);
    }
    breakoutTelemetry = await breakoutStore.telemetry(now);
  }
  const memory = process.memoryUsage();
  await log(`role=${runtimeRole} markets=${rows.length} ${venueSummary} venueHealth=${venueHealthSummary(venueHealthRuntime)} regime=${regime.state} benchmark24h=${regime.benchmarkChangePct?.toFixed?.(2) ?? 'n/a'} negativeBreadth=${regime.negativeBreadthRatio == null ? 'n/a' : (regime.negativeBreadthRatio * 100).toFixed(1) + '%'} alerts=${sent} breakoutObserved=${breakoutObserved} breakoutWarming=${breakoutEnabled ? Object.values(breakoutRuntime.series).filter(series => (series.bars?.length || 0) < 21).length : 0} breakoutActiveRecords=${breakoutTelemetry?.activeRecords ?? 0} breakoutCreatedLastHour=${breakoutTelemetry?.createdLastHour ?? 0} breakoutDbBytes=${breakoutTelemetry?.databaseBytes ?? 0} rssBytes=${memory.rss} heapUsedBytes=${memory.heapUsed} confirmationStarted=${confirmationStarted} confirmationRejected=${confirmationRejected} confirmationPending=${Object.keys(state.flowCandidates).length} regimeSuppressed=${regimeSuppressed}${rows.failures?.length ? ` failures=${rows.failures.join('|')}` : ''}${dryRun ? ' dry-run' : ''}`);
}

await environment(); if (!(await lock())) process.exit(0); const interval = Math.max(20, Number(process.env.FLOW_POLL_SECONDS || 20)) * 1000; await log(`started standalone=true pollSeconds=${interval / 1000}`);
do { const at = Date.now(); try { await scan(); } catch (error) { await log(`ERROR ${error.message || error}`); } if (once) break; await new Promise(resolvePromise => setTimeout(resolvePromise, Math.max(0, interval - (Date.now() - at)))); } while (true);
