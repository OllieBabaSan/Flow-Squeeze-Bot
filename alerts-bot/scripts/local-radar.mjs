import { unlinkSync } from 'node:fs';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlertLedger } from '../lib/alert-ledger.mjs';
import { createCmcDerivativesClient } from '../lib/cmc-derivatives.mjs';
import { roleMention } from '../lib/discord-mentions.mjs';
import { createFlowTrackingPosition, evaluateFlowFollowUp, flowAlertLabel } from '../lib/flow-alert-lifecycle.mjs';
import { detectFlowIgnition, isFlowPriceCandidate, normalizeBybitMarkets, normalizeHyperliquidMarkets } from '../lib/flow-detector.mjs';
import { findPerpDexVenues, perpDexAlertField, refreshPerpDexCatalogs } from '../lib/perp-dex-discovery.mjs';
import { readJsonWithBackup, writeJsonAtomic } from '../lib/state-file.mjs';
import { contractAddressLabel, hasVerifiedContract, isMemeToken, registryLabel, resolveTrackedToken } from '../lib/token-registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, 'data');
const paths = { state: resolve(data, 'flow-state.json'), log: resolve(data, 'flow-squeeze.log'), history: resolve(data, 'flow-alert-history.jsonl'), lock: resolve(data, 'flow-squeeze.lock') };
const ledger = createAlertLedger({ ledgerPath: resolve(data, 'flow-alert-ledger.jsonl'), outcomeStatePath: resolve(data, 'flow-alert-outcomes.json'), outcomeArchivePath: resolve(data, 'flow-alert-outcomes-archive.jsonl') });
const once = process.argv.includes('--once');
const dryRun = process.argv.includes('--dry-run');
let cmcClient;

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
    ['Hyperliquid', async () => { const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return normalizeHyperliquidMarkets(await r.json(), now); }],
  ];
  const results = await Promise.allSettled(calls.map(([, call]) => call()));
  const rows = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  if (!rows.length) throw new Error('All Flow/Squeeze venues failed');
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
  const now = Date.now(); const state = await loadState(); state.snapshots ||= {}; state.symbolAlerted ||= {}; state.flowTracking ||= {};
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
    if (isFlowPriceCandidate(market, previous, now)) try { market = await enrich(market, previous.observedAt); } catch (error) { await log(`enrichment_failed ${key} ${error.message}`); }
    const detection = detectFlowIgnition(market, previous, now); const recent = state.symbolAlerted[market.symbol];
    if (detection.eligible && !(recent && now - recent < 12 * 3600_000)) {
      const identity = await resolveTrackedToken(market.symbol, { referencePrice: market.price });
      if (identity && (!isMemeToken(identity) || hasVerifiedContract(identity))) {
        const id = `flow:${key}:${now}`; const createdAt = new Date(now).toISOString(); state.symbolAlerted[market.symbol] = now; await saveState(state);
        await ledger.reserve({ id, kind: 'flow', symbol: market.symbol, direction: detection.direction, entryPrice: market.price, entryOpenInterest: market.openInterest, entryAt: createdAt, quoteKey: key, venue: market.venue, trigger: detection });
        if (!dryRun) { await initial(market, detection, identity, rows); await ledger.delivery(id, 'sent'); const tracking = createFlowTrackingPosition({ id, market, detection, tokenIdentity: identity, now }); if (tracking.kind === 'SQUEEZE_PRESSURE') state.flowTracking[id] = tracking; sent++; } else await ledger.delivery(id, 'dry-run');
        await writeFile(paths.history, `${JSON.stringify({ schemaVersion: 1, detectorVersion: 'flow-ignition-v2', signalId: id, publicationStatus: dryRun ? 'DRY_RUN' : 'PUBLISHED', createdAt, alertedAt: createdAt, recordedAt: new Date().toISOString(), market: { ...market, tokenIdentity: identity }, detection })}\n`, { flag: 'a' });
      }
    }
    state.snapshots[key] = market;
  }
  const keep = now - 24 * 3600_000; state.symbolAlerted = Object.fromEntries(Object.entries(state.symbolAlerted).filter(([, at]) => at >= keep)); state.flowTracking = Object.fromEntries(Object.entries(state.flowTracking).filter(([, item]) => Number(item.entryAt) >= keep));
  await saveState(state); await ledger.observe('flow', quotes, now); await log(`markets=${rows.length} alerts=${sent}${dryRun ? ' dry-run' : ''}`);
}

await environment(); if (!(await lock())) process.exit(0); const interval = Math.max(20, Number(process.env.FLOW_POLL_SECONDS || 30)) * 1000; await log(`started standalone=true pollSeconds=${interval / 1000}`);
do { const at = Date.now(); try { await scan(); } catch (error) { await log(`ERROR ${error.message || error}`); } if (once) break; await new Promise(resolvePromise => setTimeout(resolvePromise, Math.max(0, interval - (Date.now() - at)))); } while (true);
