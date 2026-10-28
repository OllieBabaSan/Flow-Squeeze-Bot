import { unlinkSync } from 'node:fs';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlertLedger } from '../lib/alert-ledger.mjs';
import { createCmcDerivativesClient } from '../lib/cmc-derivatives.mjs';
import { roleMention } from '../lib/discord-mentions.mjs';
import { createFlowTrackingPosition, evaluateFlowFollowUp, flowAlertLabel } from '../lib/flow-alert-lifecycle.mjs';
import { detectFlowIgnition, isFlowPriceCandidate, normalizeBinanceMarkets, normalizeBitgetMarkets, normalizeBybitMarkets, normalizeHyperliquidMarkets, normalizeOkxMarkets } from '../lib/flow-detector.mjs';
import { findPerpDexVenues, perpDexAlertField, refreshPerpDexCatalogs } from '../lib/perp-dex-discovery.mjs';
import { readJsonWithBackup, writeJsonAtomic } from '../lib/state-file.mjs';
import { createRateLimitBackoff, flowAlertCooldownMs } from '../lib/runtime-policy.mjs';
import { contractAddressLabel, hasVerifiedContract, isMemeToken, registryLabel, resolveTrackedToken } from '../lib/token-registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, 'data');
const paths = { state: resolve(data, 'flow-state.json'), log: resolve(data, 'flow-squeeze.log'), history: resolve(data, 'flow-alert-history.jsonl'), lock: resolve(data, 'flow-squeeze.lock') };
const ledger = createAlertLedger({ ledgerPath: resolve(data, 'flow-alert-ledger.jsonl'), outcomeStatePath: resolve(data, 'flow-alert-outcomes.json'), outcomeArchivePath: resolve(data, 'flow-alert-outcomes-archive.jsonl') });
const once = process.argv.includes('--once');
const dryRun = process.argv.includes('--dry-run');
let cmcClient;
const hyperliquidBackoff = createRateLimitBackoff();

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
  const results = await Promise.allSettled(calls.map(([, call]) => call()));
  const rows = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`${calls[index][0]}: ${result.reason?.message || result.reason}`] : []);
  if (!rows.length) throw new Error('All Flow/Squeeze venues failed');
  const hyperliquidSymbols = new Set(rows.filter(market => market.venue === 'Hyperliquid').map(market => market.symbol));
  if (String(process.env.BINANCE_FLOW_SHADOW_ENABLED || 'true').toLowerCase() !== 'false') {
    try {
      const [exchangeResponse, tickerResponse, premiumResponse] = await Promise.all([
        fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: AbortSignal.timeout(12000) }),
        fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { signal: AbortSignal.timeout(12000) }),
        fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { signal: AbortSignal.timeout(12000) }),
      ]);
      if (!exchangeResponse.ok || !tickerResponse.ok || !premiumResponse.ok) throw new Error(`metadata HTTP ${exchangeResponse.status}/${tickerResponse.status}/${premiumResponse.status}`);
      const [exchange, tickers, premiums] = await Promise.all([exchangeResponse.json(), tickerResponse.json(), premiumResponse.json()]);
      const tickerBySymbol = new Map((tickers || []).map(row => [row.symbol, row]));
      const eligibleContracts = (exchange.symbols || []).filter(row => {
        if (row?.contractType !== 'PERPETUAL' || row?.quoteAsset !== 'USDT' || row?.status !== 'TRADING') return false;
        const symbol = String(row.baseAsset || row.symbol?.replace(/USDT$/, '') || '');
        const turnover = Number(tickerBySymbol.get(row.symbol)?.quoteVolume || 0);
        return hyperliquidSymbols.has(symbol) && turnover >= 10_000_000 && turnover <= 500_000_000;
      });
      const oiResults = await Promise.allSettled(eligibleContracts.map(async row => {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(row.symbol)}`, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`${row.symbol} HTTP ${response.status}`);
        return response.json();
      }));
      rows.push(...normalizeBinanceMarkets({ tickers, premiums, openInterests: oiResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : []), symbols: eligibleContracts }, now));
      const oiFailures = oiResults.filter(result => result.status === 'rejected').length;
      if (oiFailures) failures.push(`Binance: ${oiFailures}/${oiResults.length} open-interest requests failed`);
    } catch (error) { failures.push(`Binance: ${error.message || error}`); }
  }
  if (String(process.env.OKX_FLOW_SHADOW_ENABLED || 'true').toLowerCase() !== 'false') {
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
      if (fundingRates.length < eligibleTickers.length) failures.push(`OKX: ${eligibleTickers.length - fundingRates.length}/${eligibleTickers.length} funding requests failed`);
    } catch (error) { failures.push(`OKX: ${error.message || error}`); }
  }
  if (String(process.env.BITGET_FLOW_SHADOW_ENABLED || 'true').toLowerCase() !== 'false') {
    try {
      const response = await fetch('https://api.bitget.com/api/v3/market/tickers?category=USDT-FUTURES', { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      rows.push(...normalizeBitgetMarkets(await response.json(), now).filter(market => hyperliquidSymbols.has(market.symbol)
        && market.turnover24h >= 10_000_000 && market.turnover24h <= 500_000_000));
    } catch (error) { failures.push(`Bitget: ${error.message || error}`); }
  }
  rows.failures = failures;
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
async function discord(title, description, fields, direction) {
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error('DISCORD_WEBHOOK_URL is not configured');
  const r = await fetch(process.env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ username: 'Flow/Squeeze Bot', ...roleMention(process.env.DISCORD_ALERT_ROLE_ID), embeds: [{ title, description, fields, color: direction === 'BULLISH' ? 0x3ddc97 : 0xef5b5b, timestamp: new Date().toISOString() }] }) });
  if (!r.ok) throw new Error(`Discord HTTP ${r.status}`);
}
async function initial(market, detection, identity, allMarkets) {
  const kind = flowAlertLabel(detection); const squeeze = kind === 'SQUEEZE PRESSURE';
  await discord(`EARLY ${kind} · ${detection.direction} · ${market.symbol}`, squeeze ? `Potential ${detection.direction.toLowerCase()} squeeze setup—not confirmed. Confirmation requires covering or forced-liquidation evidence.` : `${detection.direction} directional flow detected. This is directional positioning, not a squeeze signal.`, [
    { name: 'Project / entity', value: registryLabel(identity) }, { name: 'Token address', value: contractAddressLabel(identity) }, { name: 'Direction', value: detection.direction, inline: true },
    { name: 'Price displacement', value: `${detection.movePct.toFixed(1)}%`, inline: true }, { name: 'Fresh turnover', value: `$${Math.round(detection.freshTurnover).toLocaleString()}`, inline: true },
    { name: 'Open-interest change', value: `${detection.oiGrowthPct.toFixed(1)}%`, inline: true }, { name: 'Venue', value: market.venueLabel, inline: true },
    { name: 'Perp DEX availability', value: perpDexAlertField(findPerpDexVenues(market.symbol, allMarkets, undefined, market.price)) },
  ], detection.direction);
}
async function scan() {
  const now = Date.now(); const state = await loadState(); state.snapshots ||= {}; state.symbolAlerted ||= {}; state.shadowAlerted ||= {}; state.flowTracking ||= {};
  const alertCooldownMs = flowAlertCooldownMs();
  if (!cmcClient && process.env.COINMARKETCAP_API_KEY) cmcClient = createCmcDerivativesClient({ apiKey: process.env.COINMARKETCAP_API_KEY });
  void refreshPerpDexCatalogs({ now }).catch(() => []); const rows = await markets(now); const byKey = new Map(rows.map(row => [`${row.venue}:${row.symbol}`, row])); const quotes = new Map(); let sent = 0;
  for (const [id, position] of Object.entries(state.flowTracking)) {
    const market = byKey.get(position.quoteKey); if (!market) continue;
    let liquidationEvidence = null;
    if (cmcClient) try { liquidationEvidence = await cmcClient.liquidationEvidence(position.symbol, position.direction); } catch (error) { await log(`liquidation_evidence_unavailable symbol=${position.symbol} error=${error.message || error}`); }
    const update = evaluateFlowFollowUp(position, market, liquidationEvidence, now); if (!update) continue;
    Object.assign(position, { peakDirectedMovePct: update.evidence.peakDirectedMovePct, stage: update.stage, updatedAt: now });
    if (update.event && !dryRun) { await discord(`${update.event.replaceAll('_', ' ')} · ${position.direction} · ${position.symbol}`, 'Follow-up to the earlier squeeze-pressure alert.', [{ name: 'Price since alert', value: `${update.evidence.directedMovePct.toFixed(2)}%` }, { name: 'Open-interest change', value: update.evidence.oiChangePct == null ? 'Unavailable' : `${update.evidence.oiChangePct.toFixed(2)}%` }], position.direction); await ledger.append({ type: 'flow_follow_up', id, event: update.event, evidence: update.evidence }); }
    if (update.stage === 'CLOSED') delete state.flowTracking[id];
  }
  for (let market of rows) {
    const key = `${market.venue}:${market.symbol}`; quotes.set(key, market.price); const previous = state.snapshots[key];
    if (!market.shadow && isFlowPriceCandidate(market, previous, now)) try { market = await enrich(market, previous.observedAt); } catch (error) { await log(`enrichment_failed ${key} ${error.message}`); }
    const detection = detectFlowIgnition(market, previous, now); const recent = market.shadow ? state.shadowAlerted[key] : state.symbolAlerted[key];
    if (detection.eligible && !(recent && now - recent < alertCooldownMs)) {
      const identity = await resolveTrackedToken(market.symbol, { referencePrice: market.price });
      if (identity && (!isMemeToken(identity) || hasVerifiedContract(identity))) {
        const id = `${market.shadow ? 'flow-shadow' : 'flow'}:${key}:${now}`; const createdAt = new Date(now).toISOString();
        if (market.shadow) state.shadowAlerted[key] = now; else state.symbolAlerted[key] = now;
        await saveState(state);
        await ledger.reserve({ id, kind: 'flow', symbol: market.symbol, direction: detection.direction, entryPrice: market.price, entryOpenInterest: market.openInterest, entryAt: createdAt, quoteKey: key, venue: market.venue, shadow: Boolean(market.shadow), trigger: detection });
        const publicationStatus = dryRun ? 'DRY_RUN' : market.shadow ? 'SHADOW' : 'PUBLISHED';
        const historyWrite = () => writeFile(paths.history, `${JSON.stringify({ schemaVersion: 1, detectorVersion: 'flow-ignition-v2', signalId: id, publicationStatus, createdAt, alertedAt: createdAt, recordedAt: new Date().toISOString(), market: { ...market, tokenIdentity: identity }, detection })}\n`, { flag: 'a' });
        if (!dryRun && market.shadow) {
          const writes = await Promise.allSettled([ledger.delivery(id, 'shadow'), historyWrite()]);
          const failure = writes.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
          await log(`shadow_candidate ${key} direction=${detection.direction}`);
        } else if (!dryRun) {
          await initial(market, detection, identity, rows);
          const tracking = createFlowTrackingPosition({ id, market, detection, tokenIdentity: identity, now });
          if (tracking.kind === 'SQUEEZE_PRESSURE') state.flowTracking[id] = tracking;
          const writes = await Promise.allSettled([ledger.delivery(id, 'sent'), historyWrite()]);
          const failure = writes.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
          sent++;
        } else {
          const writes = await Promise.allSettled([ledger.delivery(id, 'dry-run'), historyWrite()]);
          const failure = writes.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
        }
      }
    }
    state.snapshots[key] = market;
  }
  const keep = now - 24 * 3600_000; state.symbolAlerted = Object.fromEntries(Object.entries(state.symbolAlerted).filter(([, at]) => at >= keep)); state.shadowAlerted = Object.fromEntries(Object.entries(state.shadowAlerted).filter(([, at]) => at >= keep)); state.flowTracking = Object.fromEntries(Object.entries(state.flowTracking).filter(([, item]) => Number(item.entryAt) >= keep));
  const venueSummary = ['Bybit', 'Hyperliquid', 'Binance', 'OKX', 'Bitget'].map(venue => `${venue}=${rows.filter(row => row.venue === venue).length}`).join(' ');
  await saveState(state); await ledger.observe('flow', quotes, now); await log(`markets=${rows.length} ${venueSummary} alerts=${sent}${rows.failures?.length ? ` failures=${rows.failures.join('|')}` : ''}${dryRun ? ' dry-run' : ''}`);
}

await environment(); if (!(await lock())) process.exit(0); const interval = Math.max(20, Number(process.env.FLOW_POLL_SECONDS || 20)) * 1000; await log(`started standalone=true pollSeconds=${interval / 1000}`);
do { const at = Date.now(); try { await scan(); } catch (error) { await log(`ERROR ${error.message || error}`); } if (once) break; await new Promise(resolvePromise => setTimeout(resolvePromise, Math.max(0, interval - (Date.now() - at)))); } while (true);
