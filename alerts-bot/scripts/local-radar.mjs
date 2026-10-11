import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeItem, similarity, TOKEN_NAMES } from '../lib/analysis-engine.mjs';
import { ALERT_SCOPE_DAY_MS, DEFAULT_MAX_DISPATCH_AGE_MINUTES, alertFrequencyDecision, alertScopeKey, dispatchDecision, eventKey } from '../lib/dispatch-policy.mjs';
import { detectFlowIgnition, isFlowPriceCandidate, normalizeBybitMarkets, normalizeHyperliquidMarkets, normalizeKrakenMarkets } from '../lib/flow-detector.mjs';
import { roleMention } from '../lib/discord-mentions.mjs';
import { classifyMarketStatus } from '../lib/market-classification.mjs';
import { reviewEditorialCandidate } from '../lib/editorial-gate.mjs';
import { contractAddressLabel, fetchCoinGeckoPrices, hasVerifiedContract, isMemeToken, registryLabel, resolveTrackedToken } from '../lib/token-registry.mjs';
import { fetchArticleContent } from '../lib/article-content.mjs';
import { createAlertLedger } from '../lib/alert-ledger.mjs';
import { readJsonWithBackup, writeJsonAtomic } from '../lib/state-file.mjs';
import { advancePressureLifecycle, evaluateDirectionalPressure, pressureObservation, selectPressureEvents } from '../lib/directional-pressure.mjs';
import { createCmcDerivativesClient } from '../lib/cmc-derivatives.mjs';
import { findPerpDexVenues, perpDexAlertField, refreshPerpDexCatalogs } from '../lib/perp-dex-discovery.mjs';
import { runXPrimaryStream } from '../lib/x-primary-source.mjs';
import { enrichXPostContent, hasReviewableXContent } from '../lib/x-post-content.mjs';
import { classifyCatalystText } from '../lib/x-signal-evaluation.mjs';
import { classifyNewsDelivery } from '../lib/news-delivery.mjs';
import { checkTokenRisk } from '../lib/token-risk.mjs';
import { createFlowTrackingPosition, evaluateFlowFollowUp, flowAlertLabel } from '../lib/flow-alert-lifecycle.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = resolve(projectDir, 'data', 'local-radar-state.json');
const logPath = resolve(projectDir, 'data', 'local-radar.log');
const flowStatePath = resolve(projectDir, 'data', 'local-flow-state.json');
const pressureStatePath = resolve(projectDir, 'data', 'directional-pressure-state.json');
const flowAlertHistoryPath = resolve(projectDir, 'data', 'flow-alert-history.jsonl');
const instanceLockPath = resolve(projectDir, 'data', 'local-radar.lock');
const ledger = createAlertLedger({ ledgerPath: resolve(projectDir, 'data', 'alert-ledger.jsonl'), outcomeStatePath: resolve(projectDir, 'data', 'alert-outcomes.json'), outcomeArchivePath: resolve(projectDir, 'data', 'alert-outcomes-archive.jsonl') });
const once = process.argv.includes('--once');
const dryRun = process.argv.includes('--dry-run');
let cmcDerivativesClient = null;
let xRegistry = [];
let xInbox = [];
let newsScanTail = Promise.resolve();
let xDispatchTimer = null;
let intervalMs;
let slowIntervalMs;
let flowIntervalMs;

function selectedForEditorialShadow(id, sampleRate) {
  if (!id || sampleRate <= 0) return false;
  const bucket = Number.parseInt(createHash('sha256').update(String(id)).digest('hex').slice(0, 8), 16) / 0xffffffff;
  return bucket < sampleRate;
}
const sources = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', authority: 18 },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml', authority: 18 },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', authority: 14 },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', authority: 15 },
  { name: 'Blockworks', url: 'https://blockworks.co/feed', authority: 16 },
  { name: 'DL News', url: 'https://www.dlnews.com/arc/outboundfeeds/rss/', authority: 16 },
  { name: 'Unchained', url: 'https://unchainedcrypto.com/feed/', authority: 16 },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/', authority: 14 },
  { name: "Trump's Truth", url: 'https://www.trumpstruth.org/feed', authority: 25, sourceClass: 'policy' },
  { name: 'Google News / crypto catalysts', url: 'https://news.google.com/rss/search?q=%28crypto%20OR%20token%29%20%28listing%20OR%20partnership%20OR%20exploit%20OR%20hack%20OR%20acquisition%20OR%20buyback%20OR%20burn%20OR%20mainnet%20OR%20migration%20OR%20launches%20OR%20launched%20OR%20introduces%20OR%20unveils%20OR%20%22goes%20live%22%29%20when%3A1h&hl=en-US&gl=US&ceid=US%3Aen', authority: 14 },
  { name: 'Google News / exchange announcements', url: 'https://news.google.com/rss/search?q=%28Binance%20OR%20Coinbase%20OR%20Upbit%20OR%20Bithumb%20OR%20Kraken%29%20%28lists%20OR%20listing%20OR%20delists%20OR%20suspends%29%20crypto%20when%3A1h&hl=en-US&gl=US&ceid=US%3Aen', authority: 16 },
  { name: 'Google News / launches and institutions', url: 'https://news.google.com/rss/search?q=%28crypto%20OR%20blockchain%20OR%20token%20OR%20DeFi%29%20%28launches%20OR%20launched%20OR%20introduces%20OR%20unveils%20OR%20%22goes%20live%22%20OR%20%22powered%20by%22%29%20%28BlackRock%20OR%20JPMorgan%20OR%20DTCC%20OR%20Visa%20OR%20Mastercard%20OR%20Fidelity%20OR%20Nasdaq%20OR%20NYSE%29%20when%3A1h&hl=en-US&gl=US&ceid=US%3Aen', authority: 18 },
  { name: 'Google News / crypto wires', url: 'https://news.google.com/rss/search?q=%28site%3Aprnewswire.com%20OR%20site%3Abusinesswire.com%20OR%20site%3Aglobenewswire.com%29%20%28crypto%20OR%20blockchain%20OR%20token%20OR%20DeFi%29%20when%3A1h&hl=en-US&gl=US&ceid=US%3Aen', authority: 19 },
];

const decode = (value = '') => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function field(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match) return decode(match[1]);
  }
  return '';
}

function parseFeed(xml, source) {
  const blocks = [...(xml.match(/<item\b[\s\S]*?<\/item>/gi) || []), ...(xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [])];
  return blocks.slice(0, 40).map(block => {
    const url = block.match(/<link[^>]+href=["']([^"']+)/i)?.[1] || field(block, ['link']);
    const publishedAt = new Date(field(block, ['pubDate', 'published', 'updated', 'dc:date']));
    return { title: field(block, ['title']), url: decode(url), publishedAt, source: source.name,
      description: field(block, ['description', 'summary', 'content:encoded', 'content']),
      authority: source.authority, sourceClass: source.sourceClass || 'publisher' };
  }).filter(item => item.title && item.url && Number.isFinite(item.publishedAt.getTime()));
}

async function loadEnvironment() {
  for (const filename of ['.env.local', '.env.role.local']) {
    try {
      const text = await readFile(resolve(projectDir, filename), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^https:\/\/[^\s]+\/api\/webhooks\//i.test(line)) { process.env.DISCORD_WEBHOOK_URL ||= line; continue; }
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      process.env[key] ||= value;
    }
    } catch {}
  }
}

async function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `${line}\n`, { flag: 'a' });
  console.log(line);
}

async function acquireInstanceLock() {
  await mkdir(dirname(instanceLockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(instanceLockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      process.on('exit', () => { try { unlinkSync(instanceLockPath); } catch {} });
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existingPid = 0;
      try { existingPid = Number((await readFile(instanceLockPath, 'utf8')).trim()); } catch {}
      if (existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          console.log(`${new Date().toISOString()} monitor already running pid=${existingPid}; exiting duplicate instance`);
          return false;
        } catch {}
      }
      try { await unlink(instanceLockPath); } catch {}
    }
  }
  return false;
}

async function loadState() {
  return readJsonWithBackup(statePath, { initialized: false, seen: {}, events: {} });
}

async function saveState(state) {
  await writeJsonAtomic(statePath, state);
}

async function loadFlowState() {
  return readJsonWithBackup(flowStatePath, { snapshots: {}, alerted: {} });
}

async function saveFlowState(state) {
  await writeJsonAtomic(flowStatePath, state);
}

async function initializePressureState() {
  const existing = await readJsonWithBackup(pressureStatePath, null);
  if (existing) return;
  const flow = await loadFlowState();
  await writeJsonAtomic(pressureStatePath, {
    pressureHistory: flow.pressureHistory || {}, pressureSignals: flow.pressureSignals || {},
    cmcDerivatives: flow.cmcDerivatives || {}, cmcEvidenceUsage: flow.cmcEvidenceUsage || null,
  });
}

async function loadPressureState() {
  return readJsonWithBackup(pressureStatePath, { pressureHistory: {}, pressureSignals: {}, cmcDerivatives: {} });
}

async function savePressureState(state) {
  await writeJsonAtomic(pressureStatePath, state);
}

async function recordFlowAlert(market, detection) {
  const entry = JSON.stringify({ alertedAt: new Date().toISOString(), market, detection });
  await writeFile(flowAlertHistoryPath, `${entry}\n`, { flag: 'a' });
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'NewsRadar/2.0 (+local monitor)', Accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchMarkets() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h', { signal: AbortSignal.timeout(12000) });
    if (!response.ok) return new Map();
    const rows = await response.json();
    return new Map(rows.map(row => [String(row.symbol || '').toUpperCase(), { id: row.id, symbol: String(row.symbol || '').toUpperCase(), price: Number(row.current_price || 0), change24h: Number.isFinite(Number(row.price_change_percentage_24h)) ? Number(row.price_change_percentage_24h) : null, high24h: Number(row.high_24h || 0), low24h: Number(row.low_24h || 0), marketCap: Number(row.market_cap || 0), volume: Number(row.total_volume || 0) }]).filter(([symbol]) => symbol));
  } catch { return new Map(); }
}

async function loadTokenCatalog() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=false', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    const rows = await response.json();
    for (const row of rows) {
      const name = String(row.name || '').toLowerCase().trim();
      const symbol = String(row.symbol || '').toUpperCase().trim();
      if (name.length >= 3 && /^[A-Z0-9]{2,10}$/.test(symbol) && !TOKEN_NAMES[name]) TOKEN_NAMES[name] = symbol;
    }
  } catch {}
}

async function collect(includePublishers = true) {
  const outcomes = includePublishers ? await Promise.allSettled(sources.map(async source => parseFeed(await fetchText(source.url), source))) : [];
  const publisherItems = outcomes.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const xItems = xInbox.filter(item => Date.now() - item.publishedAt.getTime() < 6 * 3600_000);
  const raw = [...xItems, ...publisherItems];
  const unique = raw.filter((item, index, all) => all.findIndex(other => other.url === item.url || similarity(other.title, item.title) > 0.88) === index);
  return { raw, unique, online: outcomes.filter(result => result.status === 'fulfilled').length };
}

const idFor = item => createHash('sha256').update(`${item.source}:${item.url}`).digest('hex').slice(0, 32);

async function sendDiscord(signal, deliveryKind = 'NEWS_FALLBACK_ALERT') {
  const webhook = process.env.DISCORD_X_ALERT_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error('DISCORD_X_ALERT_WEBHOOK_URL is not configured');
  const isContext = deliveryKind === 'CONTEXT_UPDATE';
  const mention = isContext ? { allowed_mentions: { parse: [] } } : roleMention(process.env.DISCORD_X_ALERT_ROLE_ID || process.env.DISCORD_ALERT_ROLE_ID);
  const heading = deliveryKind === 'PRIMARY_ALERT' ? 'PRIMARY ALERT' : isContext ? 'CONTEXT UPDATE' : 'NEWS ALERT';
  const sourceLabel = signal.sourceKind === 'primary_x' ? 'Primary source' : 'Publisher';
  const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({
    username: 'Crypto News Radar', ...mention, embeds: [{
      title: `${heading} · ${signal.marketClassification.label} · ${signal.level} ${signal.score} · ${signal.eventType}`,
      description: `**${signal.title}**\n\n${signal.reason.join(' · ')}`, url: signal.url, color: 0x5ee1a6,
      fields: [
        { name: 'Token', value: `$${signal.tokens[0]}`, inline: true },
        { name: 'Project / entity', value: registryLabel(signal.tokenIdentity), inline: false },
        { name: 'Token address', value: contractAddressLabel(signal.tokenIdentity, signal.marketClassification.chain), inline: false },
        { name: 'Expected impact', value: signal.direction, inline: true },
        { name: sourceLabel, value: signal.source, inline: true },
        { name: 'Reported', value: `${signal.ageMinutes} minutes ago`, inline: true },
        { name: 'Market status', value: signal.marketClassification.label, inline: true },
        { name: 'Chain', value: signal.marketClassification.chain, inline: true },
        { name: 'Further research', value: `[Open source ${signal.sourceKind === 'primary_x' ? 'post' : 'article'}](${signal.url})`, inline: true },
        { name: 'Risk flags', value: signal.risks.length ? signal.risks.join(' · ') : 'None identified' },
      ], footer: { text: isContext ? 'Follow-up context · no role ping' : 'Newly reported catalyst · research alert only' }, timestamp: new Date().toISOString(),
    }],
  }) });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
}

async function startXPrimaryIngestion() {
  if (String(process.env.X_PRIMARY_ENABLED || '').toLowerCase() !== 'true') {
    await log('X primary ingestion disabled');
    return;
  }
  if (!process.env.X_BEARER_TOKEN) {
    await log('X primary ingestion waiting for X_BEARER_TOKEN');
    return;
  }
  try {
    const registry = JSON.parse(await readFile(resolve(projectDir, process.env.X_SOURCE_REGISTRY || 'data/x-source-registry.json'), 'utf8'));
    const configuredAccounts = registry.accounts || registry;
    xRegistry = configuredAccounts.filter(account => account.xUserId);
    if (xRegistry.length !== configuredAccounts.length) await log(`X registry skipped ${configuredAccounts.length - xRegistry.length} unresolved or stale handles`);
  } catch (error) {
    await log(`X primary registry load failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!xRegistry.length) {
    await log('X primary ingestion waiting for a populated source registry');
    return;
  }
  const controller = new AbortController();
  void runXPrimaryStream({
    bearerToken: process.env.X_BEARER_TOKEN,
    registry: xRegistry,
    signal: controller.signal,
    onPost: async item => {
      if (!xInbox.some(existing => existing.postId === item.postId)) {
        xInbox = [...xInbox.slice(-999), item];
        queueImmediateXScan();
      }
    },
    onStatus: status => { void log(`X stream ${status}`); },
  }).catch(error => { void log(`X stream stopped: ${error instanceof Error ? error.message : String(error)}`); });
}

function scheduleNewsScan(options = {}) {
  const run = newsScanTail.catch(() => {}).then(() => scan(options));
  newsScanTail = run.catch(() => {});
  return run;
}

function queueImmediateXScan() {
  if (once || xDispatchTimer) return;
  const debounceMs = Math.max(100, Math.min(2000, Number(process.env.X_DISPATCH_DEBOUNCE_MS || 200)));
  xDispatchTimer = setTimeout(() => {
    xDispatchTimer = null;
    void scheduleNewsScan({ includePublishers: false }).catch(error => {
      void log(`ERROR immediate X scan ${error instanceof Error ? error.message : String(error)}`);
    });
  }, debounceMs);
}

async function sendFlowDiscord(market, detection, tokenIdentity, perpDexVenues = []) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error('DISCORD_WEBHOOK_URL is not configured');
  const reason = detection.reason === 'crowded_shorts' ? 'Crowded shorts / upside squeeze pressure'
    : detection.reason === 'crowded_longs' ? 'Crowded longs / downside squeeze pressure' : 'Rapidly rising open interest';
  const directionColor = detection.direction === 'BULLISH' ? 0x3ddc97 : 0xef5b5b;
  const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({
    username: 'Crypto News Radar', ...roleMention(process.env.DISCORD_ALERT_ROLE_ID), embeds: [{
      title: `EARLY ${flowAlertLabel(detection)} · ${detection.direction} · ${market.symbol}`,
      description: flowAlertLabel(detection) === 'SQUEEZE PRESSURE'
        ? `**Potential ${detection.direction.toLowerCase()} squeeze setup detected — not yet a confirmed squeeze.**\n\n${reason} with adverse price movement and new open-interest participation. Confirmation requires evidence of covering or forced liquidations while price continues ${detection.direction === 'BULLISH' ? 'higher' : 'lower'}.`
        : `**${detection.direction} directional flow detected.**\n\n${reason} with price, turnover, and new open-interest participation aligned. This is directional positioning, not a squeeze signal.`,
      color: directionColor,
      fields: [
        { name: 'Project / entity', value: registryLabel(tokenIdentity), inline: false },
        { name: 'Token address', value: contractAddressLabel(tokenIdentity), inline: false },
        { name: 'Direction', value: detection.direction, inline: true },
        { name: 'Initial price displacement', value: `${detection.movePct >= 0 ? '+' : ''}${detection.movePct.toFixed(1)}%`, inline: true },
        { name: 'Fresh turnover', value: `$${Math.round(detection.freshTurnover).toLocaleString()}`, inline: true },
        { name: 'Open-interest change', value: `${detection.oiGrowthPct >= 0 ? '+' : ''}${detection.oiGrowthPct.toFixed(1)}%`, inline: true },
        { name: market.fundingLabel, value: `${(detection.fundingRate * 100).toFixed(3)}%`, inline: true },
        { name: 'Venue', value: market.venueLabel, inline: true },
        { name: 'Perp DEX availability', value: perpDexAlertField(perpDexVenues), inline: false },
        { name: '24h turnover', value: `$${Math.round(Number(market.turnover24h)).toLocaleString()}`, inline: true },
      ], footer: { text: `${detection.direction} · ${flowAlertLabel(detection).toLowerCase()} · evidence-based follow-up enabled` }, timestamp: new Date().toISOString(),
    }],
  }) });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
}

async function sendFlowFollowUpDiscord(position, market, result) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error('DISCORD_WEBHOOK_URL is not configured');
  const labels = {
    SQUEEZE_CONFIRMED: 'SQUEEZE CONFIRMED', SQUEEZE_INVALIDATED: 'SQUEEZE PRESSURE INVALIDATED',
    SQUEEZE_UNCONFIRMED: 'SQUEEZE NOT CONFIRMED', SQUEEZE_EXHAUSTION: 'SQUEEZE EXHAUSTION',
    SQUEEZE_TRACKING_ENDED: 'SQUEEZE TRACKING ENDED',
  };
  const evidence = result.evidence;
  const liquidation = evidence.liquidationEvidence;
  const explanations = {
    SQUEEZE_CONFIRMED: 'Price continued against the crowded side and covering/liquidation evidence is now present.',
    SQUEEZE_INVALIDATED: 'Price reversed against the proposed squeeze direction before confirmation.',
    SQUEEZE_UNCONFIRMED: 'The pressure window expired without sufficient covering or liquidation evidence.',
    SQUEEZE_EXHAUSTION: 'The confirmed squeeze has materially surrendered its best move; acceleration is no longer intact.',
    SQUEEZE_TRACKING_ENDED: 'The maximum follow-up window expired. This closes tracking without claiming continued squeeze conditions.',
  };
  const fields = [
    { name: 'Project / entity', value: registryLabel(position.tokenIdentity), inline: false },
    { name: 'Direction', value: position.direction, inline: true },
    { name: 'Price since initial alert', value: `${evidence.directedMovePct >= 0 ? '+' : ''}${evidence.directedMovePct.toFixed(2)}% in alert direction`, inline: true },
    { name: 'Open-interest change since alert', value: evidence.oiChangePct == null ? 'Unavailable' : `${evidence.oiChangePct >= 0 ? '+' : ''}${evidence.oiChangePct.toFixed(2)}%`, inline: true },
    { name: 'What the data says', value: explanations[result.event], inline: false },
    { name: 'Venue', value: position.venueLabel || position.venue, inline: true },
  ];
  if (liquidation?.available) fields.push({ name: '1h liquidation evidence', value: `${liquidation.bias.replaceAll('_', ' ')} · $${Math.round(liquidation.total1hUsd).toLocaleString()} total`, inline: false });
  const color = result.event === 'SQUEEZE_CONFIRMED' ? (position.direction === 'BULLISH' ? 0x3ddc97 : 0xef5b5b) : 0xefbd5a;
  const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({
    username: 'Crypto News Radar', ...roleMention(process.env.DISCORD_ALERT_ROLE_ID), embeds: [{
      title: `${labels[result.event]} · ${position.direction} · ${position.symbol}`,
      description: explanations[result.event], color, fields,
      footer: { text: `Follow-up to ${position.id} · ${Math.round(evidence.elapsedMinutes)} minutes after initial alert` }, timestamp: new Date().toISOString(),
    }],
  }) });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
}

async function enrichFlowMarket(market, since) {
  if (market.venue === 'Bybit') {
    const symbol = `${market.symbol}USDT`;
    const [klineResponse, infoResponse] = await Promise.all([
      fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=1&start=${since}&limit=10`, { signal: AbortSignal.timeout(10000) }),
      fetch(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(10000) }),
    ]);
    if (!klineResponse.ok || !infoResponse.ok) throw new Error('Bybit flow enrichment failed');
    const [klines, info] = await Promise.all([klineResponse.json(), infoResponse.json()]);
    const intervalTurnoverUsd = (klines?.result?.list || []).filter(row => Number(row[0]) >= since).reduce((sum, row) => sum + Number(row[6] || 0), 0);
    const fundingInterval = Number(info?.result?.list?.[0]?.fundingInterval || 480);
    return { ...market, intervalTurnoverUsd, fundingRate: market.fundingRate * (480 / fundingInterval), fundingLabel: 'Funding (8h equivalent)' };
  }
  if (market.venue === 'Kraken') {
    const from = Math.floor(since / 1000), to = Math.ceil(Date.now() / 1000);
    const response = await fetch(`https://futures.kraken.com/api/charts/v1/trade/${encodeURIComponent(market.venueSymbol)}/1m?from=${from}&to=${to}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Kraken candles HTTP ${response.status}`);
    const payload = await response.json();
    const intervalTurnoverUsd = (payload?.candles || []).filter(candle => Number(candle.time) >= since)
      .reduce((sum, candle) => sum + Number(candle.volume || 0) * Number(candle.close || market.price), 0);
    return { ...market, intervalTurnoverUsd };
  }
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: market.symbol, interval: '1m', startTime: since, endTime: Date.now() } }),
  });
  if (!response.ok) throw new Error('Hyperliquid flow enrichment failed');
  const candles = await response.json();
  const rows = Array.isArray(candles) ? candles : [];
  const intervalTurnoverUsd = rows.reduce((sum, candle) => sum + Number(candle.v || 0) * Number(candle.c || market.price), 0);
  const tradeCount = rows.reduce((sum, candle) => sum + Number(candle.n || 0), 0);
  return { ...market, intervalTurnoverUsd, tradeCount: tradeCount || null };
}

function orderBookImbalance(levels = []) {
  const notional = rows => (rows || []).slice(0, 10).reduce((sum, row) => sum + Number(row.sz || row.size || 0) * Number(row.px || row.price || 0), 0);
  const bids = notional(levels[0]), asks = notional(levels[1]);
  return bids + asks > 0 ? (bids - asks) / (bids + asks) : null;
}

async function enrichPressureEvidence(market, since) {
  if (market.venue !== 'Hyperliquid') return market;
  const request = body => fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  }).then(async response => {
    if (!response.ok) throw new Error(`Hyperliquid evidence HTTP ${response.status}`);
    return response.json();
  });
  const [trades, book] = await Promise.all([
    request({ type: 'recentTrades', coin: market.symbol }),
    request({ type: 'l2Book', coin: market.symbol }),
  ]);
  const recent = (Array.isArray(trades) ? trades : []).filter(trade => Number(trade.time) >= since);
  const buyNotional = recent.filter(trade => trade.side === 'B').reduce((sum, trade) => sum + Number(trade.px) * Number(trade.sz), 0);
  const sellNotional = recent.filter(trade => trade.side === 'A').reduce((sum, trade) => sum + Number(trade.px) * Number(trade.sz), 0);
  return { ...market, aggressiveBuyRatio: buyNotional + sellNotional > 0 ? buyNotional / (buyNotional + sellNotional) : null, bookImbalance: orderBookImbalance(book?.levels), tradeCount: Number(market.tradeCount || recent.length) || null };
}

async function fetchPressureMarkets(now) {
  const requests = [
    ['Hyperliquid', async () => {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
      return normalizeHyperliquidMarkets(await response.json(), now);
    }],
    ['Kraken', async () => {
      const response = await fetch('https://futures.kraken.com/derivatives/api/v3/tickers', { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Kraken HTTP ${response.status}`);
      return normalizeKrakenMarkets(await response.json(), now);
    }],
  ];
  const outcomes = await Promise.allSettled(requests.map(([, request]) => request()));
  const markets = outcomes.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const failures = outcomes.flatMap((result, index) => result.status === 'rejected' ? [`${requests[index][0]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
  if (!markets.length) throw new Error(`All pressure venues failed${failures.length ? ` (${failures.join('; ')})` : ''}`);
  return { markets, failures };
}

async function attachCmcEvidenceBatch(alerts) {
  if (!cmcDerivativesClient || !alerts.length) return;
  const updates = await Promise.all(alerts.map(async alert => {
    const cmcEvidence = { liquidation: cmcDerivativesClient.peekLiquidationEvidence(alert.symbol, alert.direction), derivatives: cmcDerivativesClient.peekDerivativesEvidence(alert.symbol), errors: [] };
    const tasks = [cmcDerivativesClient.liquidationEvidence(alert.symbol, alert.direction).then(value => { cmcEvidence.liquidation = value; }).catch(error => { cmcEvidence.errors.push(`liquidations: ${error instanceof Error ? error.message : String(error)}`); })];
    if (alert.includeDerivatives) tasks.push(cmcDerivativesClient.derivativesEvidence(alert.symbol).then(value => { cmcEvidence.derivatives = value; }).catch(error => { cmcEvidence.errors.push(`derivatives: ${error instanceof Error ? error.message : String(error)}`); }));
    await Promise.all(tasks);
    return { id: alert.id, details: { cmcEvidence }, symbol: alert.symbol };
  }));
  await ledger.annotateMany(updates.map(({ id, details }) => ({ id, details })));
  await log(`pressure evidence_batch attached=${updates.length} errors=${updates.reduce((sum, update) => sum + update.details.cmcEvidence.errors.length, 0)}`);
}

async function scanPressure() {
  const startedAt = Date.now();
  if (String(process.env.DIRECTIONAL_PRESSURE_ENABLED || 'true').toLowerCase() === 'false') return;
  const pressureVenues = new Set(String(process.env.DIRECTIONAL_PRESSURE_VENUES || 'Hyperliquid,Kraken').split(',').map(value => value.trim()).filter(Boolean));
  const state = await loadPressureState();
  state.pressureHistory ||= {};
  state.pressureSignals ||= {};
  const cmcDay = new Date(startedAt).toISOString().slice(0, 10);
  if (state.cmcEvidenceUsage?.day !== cmcDay) state.cmcEvidenceUsage = { day: cmcDay, candidateRequests: 0 };
  const cmcCandidateDailyLimit = Math.max(0, Number(process.env.CMC_DERIVATIVES_CANDIDATE_DAILY_LIMIT || 50));
  if (!cmcDerivativesClient && process.env.COINMARKETCAP_API_KEY) cmcDerivativesClient = createCmcDerivativesClient({ apiKey: process.env.COINMARKETCAP_API_KEY });
  if (cmcDerivativesClient) void cmcDerivativesClient.primeLiquidations().catch(error => log(`pressure cmc_prime_failed error=${error instanceof Error ? error.message : String(error)}`));
  const fetched = await fetchPressureMarkets(startedAt);
  const markets = fetched.markets.filter(market => pressureVenues.has(market.venue));
  const { failures } = fetched;
  const prepared = markets.map(current => {
    const marketKey = `${current.venue}:${current.symbol}`;
    const history = state.pressureHistory[marketKey] || [];
    const observation = pressureObservation(current, history.at(-1), startedAt);
    return { current, marketKey, history, observation, detection: evaluateDirectionalPressure(history, observation, current) };
  });
  const enrichTargets = prepared.filter(item => item.detection.eligible).slice(0, 10);
  await Promise.all(enrichTargets.map(async item => {
    try {
      const since = Number(item.history.at(-1)?.observedAt || startedAt - 60_000);
      let current = item.current;
      if (!Number.isFinite(Number(current.intervalTurnoverUsd))) current = await enrichFlowMarket(current, since);
      current = await enrichPressureEvidence(current, since);
      item.current = current;
      item.observation = pressureObservation(current, item.history.at(-1), startedAt);
      item.detection = evaluateDirectionalPressure(item.history, item.observation, current);
    } catch (error) { await log(`pressure enrichment_failed symbol=${item.current.symbol} venue=${item.current.venue} error=${error instanceof Error ? error.message : String(error)}`); }
  }));
  const liveQuotes = new Map();
  const eventCandidates = [];
  state.tokenSources ||= {};
  for (const item of prepared) {
    const { current, marketKey, history, observation, detection } = item;
    liveQuotes.set(marketKey, current.price);
    const previous = state.pressureSignals[marketKey];
    const lifecycle = advancePressureLifecycle(previous, detection, startedAt);
    state.pressureSignals[marketKey] = lifecycle;
    if (lifecycle.event && !dryRun) eventCandidates.push({ ...item, lifecycle, previous });
    state.pressureHistory[marketKey] = [...history, observation].slice(-120);
  }
  const selectedEvents = selectPressureEvents(eventCandidates, { preferredVenueBySymbol: state.tokenSources });
  const recentRelated = selectedEvents.length ? await ledger.recent({ since: startedAt - 10 * 60_000, kinds: ['news', 'flow'] }) : [];
  const evidenceStates = new Set(['DEVELOPING', 'CONFIRMED_MOMENTUM', 'SUSTAINED', 'MOMENTUM_WEAKENING', 'MOMENTUM_LOSS', 'RESUMED_MOMENTUM', 'MOMENTUM_STABILIZED']);
  const alerts = selectedEvents.map(item => {
    const { current, marketKey, detection, lifecycle, previous, sourceSelection } = item;
    const id = `pressure:${marketKey}:${startedAt}`;
    const related = recentRelated.filter(record => record.symbol === current.symbol);
    const aligned = related.find(record => record.direction === lifecycle.direction);
    const conflicting = related.find(record => record.direction && record.direction !== lifecycle.direction);
    const correlation = aligned ? 'ALIGNED' : conflicting ? 'CONFLICTING' : 'PRESSURE_ONLY';
    const attachEvidence = sourceSelection.selected && evidenceStates.has(lifecycle.state);
    const cachedEvidence = cmcDerivativesClient && attachEvidence ? { liquidation: cmcDerivativesClient.peekLiquidationEvidence(current.symbol, lifecycle.direction), derivatives: cmcDerivativesClient.peekDerivativesEvidence(current.symbol), errors: [], pending: true } : null;
    state.pressureSignals[marketKey].id = id;
    if (sourceSelection.selected) {
      if (['MOMENTUM_ENDED', 'FAILED'].includes(lifecycle.state)) delete state.tokenSources[current.symbol];
      else state.tokenSources[current.symbol] = current.venue;
    }
    return { id, kind: 'pressure', telemetryVersion: 5, observedAt: new Date(startedAt).toISOString(), recordedAt: new Date().toISOString(), symbol: current.symbol, direction: lifecycle.direction, entryPrice: current.price, entryAt: new Date(startedAt).toISOString(), quoteKey: marketKey, venue: current.venue, shadow: true, state: lifecycle.state, character: detection.character || null, pressureScore: detection.pressureScore || 0, expansionScore: detection.expansionScore || 0, correlation, cmcEvidence: cachedEvidence, relatedAlertIds: related.map(record => record.id), priorSignalId: previous?.id || null, sourceSelection, metrics: detection.metrics || {}, components: detection.components || {} };
  });
  if (alerts.length) {
    await ledger.reserveMany(alerts);
    await ledger.deliveryMany(alerts.map(alert => ({ id: alert.id, status: 'shadow' })));
    const enrichmentTargets = alerts.filter(alert => alert.sourceSelection.selected && evidenceStates.has(alert.state)).map(alert => {
      const includeDerivatives = state.cmcEvidenceUsage.candidateRequests < cmcCandidateDailyLimit;
      if (includeDerivatives) state.cmcEvidenceUsage.candidateRequests += 1;
      return { ...alert, includeDerivatives };
    });
    void attachCmcEvidenceBatch(enrichmentTargets).catch(error => log(`pressure evidence_batch_failed error=${error instanceof Error ? error.message : String(error)}`));
    const publicCount = alerts.filter(alert => alert.sourceSelection.publishEligible).length;
    const digestCount = alerts.filter(alert => alert.sourceSelection.deliveryMode === 'terminal_digest').length;
    await log(`pressure shadow_batch events=${alerts.length} publicCandidates=${publicCount} terminalDigestItems=${digestCount} detectionLatencyMs=${Date.now() - startedAt}`);
  }
  const events = alerts.length;
  const retention = startedAt - 24 * 3600_000;
  state.pressureSignals = Object.fromEntries(Object.entries(state.pressureSignals).filter(([, signal]) => Number(signal.updatedAt || signal.at) >= retention));
  await savePressureState(state);
  await ledger.observe('pressure', liveQuotes, startedAt);
  await log(`pressure markets=${markets.length} events=${events} durationMs=${Date.now() - startedAt}${failures.length ? ` failures=${failures.join('|')}` : ''}${dryRun ? ' dry-run' : ''}`);
}

async function scanFlow() {
  const scanStartedAt = Date.now();
  const now = Date.now();
  const state = await loadFlowState();
  // Refresh secondary venue metadata in the background. It is useful context,
  // but it must never delay an otherwise fully validated Discord alert.
  void refreshPerpDexCatalogs({ now }).catch(() => []);
  const venueRequests = [
    ['Bybit', async () => {
      const response = await fetch('https://api.bybit.com/v5/market/tickers?category=linear', { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
      return normalizeBybitMarkets(await response.json(), now);
    }],
    ['Hyperliquid', async () => {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
      return normalizeHyperliquidMarkets(await response.json(), now);
    }],
    ['Kraken', async () => {
      const response = await fetch('https://futures.kraken.com/derivatives/api/v3/tickers', { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Kraken HTTP ${response.status}`);
      return normalizeKrakenMarkets(await response.json(), now);
    }],
  ];
  const outcomes = await Promise.allSettled(venueRequests.map(([, request]) => request()));
  const markets = outcomes.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const failures = outcomes.flatMap((result, index) => result.status === 'rejected'
    ? [`${venueRequests[index][0]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
  if (!markets.length) throw new Error(`All flow venues failed${failures.length ? ` (${failures.join('; ')})` : ''}`);
  let alerts = 0;
  state.symbolAlerted ||= {};
  state.shadowAlerted ||= {};
  state.flowTracking ||= {};
  state.pressureHistory ||= {};
  state.pressureSignals ||= {};
  state.cmcDerivatives ||= {};
  const cmcDay = new Date(now).toISOString().slice(0, 10);
  if (state.cmcEvidenceUsage?.day !== cmcDay) state.cmcEvidenceUsage = { day: cmcDay, candidateRequests: 0 };
  const cmcCandidateDailyLimit = Math.max(0, Number(process.env.CMC_DERIVATIVES_CANDIDATE_DAILY_LIMIT || 50));
  if (!cmcDerivativesClient && process.env.COINMARKETCAP_API_KEY) cmcDerivativesClient = createCmcDerivativesClient({ apiKey: process.env.COINMARKETCAP_API_KEY });
  const liveQuotes = new Map();
  const marketsByKey = new Map(markets.map(market => [`${market.venue}:${market.symbol}`, market]));
  for (const [trackingId, position] of Object.entries(state.flowTracking)) {
    const trackedMarket = marketsByKey.get(position.quoteKey);
    if (!trackedMarket) continue;
    let liquidationEvidence = null;
    if (cmcDerivativesClient && position.kind === 'SQUEEZE_PRESSURE') {
      try { liquidationEvidence = await cmcDerivativesClient.liquidationEvidence(position.symbol, position.direction); }
      catch (error) { await log(`flow followup_liquidation_unavailable symbol=${position.symbol} error=${error instanceof Error ? error.message : String(error)}`); }
    }
    const followUp = evaluateFlowFollowUp(position, trackedMarket, liquidationEvidence, now);
    if (!followUp) continue;
    position.peakDirectedMovePct = followUp.evidence.peakDirectedMovePct;
    position.stage = followUp.stage;
    position.updatedAt = now;
    if (followUp.event && !dryRun) {
      try {
        await sendFlowFollowUpDiscord(position, trackedMarket, followUp);
        await ledger.append({ type: 'flow_follow_up', id: trackingId, symbol: position.symbol, direction: position.direction, event: followUp.event, evidence: followUp.evidence });
        await log(`flow followup=${followUp.event} symbol=${position.symbol} direction=${position.direction} move=${followUp.evidence.directedMovePct.toFixed(2)} oi=${followUp.evidence.oiChangePct == null ? 'unavailable' : followUp.evidence.oiChangePct.toFixed(2)}`);
      } catch (error) {
        await log(`flow followup_delivery_failed symbol=${position.symbol} event=${followUp.event} error=${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    if (followUp.stage === 'CLOSED') delete state.flowTracking[trackingId];
  }
  let pressureCandidates = 0;
  let pressureEnrichmentBudget = 10;
  const pressureVenues = new Set(String(process.env.DIRECTIONAL_PRESSURE_VENUES || 'Hyperliquid,Kraken').split(',').map(value => value.trim()).filter(Boolean));
  // Directional Pressure has a dedicated fast scanner; this loop handles the
  // legacy Flow/Squeeze publisher only.
  const pressureEnabled = false;
  for (let current of markets) {
    const marketKey = `${current.venue}:${current.symbol}`;
    liveQuotes.set(marketKey, current.price);
    if (isFlowPriceCandidate(current, state.snapshots[marketKey], now)) {
      try { current = await enrichFlowMarket(current, Number(state.snapshots[marketKey].observedAt)); }
      catch (error) { await log(`flow enrichment_failed symbol=${current.symbol} venue=${current.venue} error=${error instanceof Error ? error.message : String(error)}`); }
    }
    const pressureHistory = state.pressureHistory[marketKey] || [];
    let observation = pressureObservation(current, state.snapshots[marketKey], now);
    let pressureDetection = pressureEnabled && pressureVenues.has(current.venue)
      ? evaluateDirectionalPressure(pressureHistory, observation, current)
      : { eligible: false, state: 'INELIGIBLE', reason: 'venue_not_enabled' };
    if (pressureDetection.eligible && pressureEnrichmentBudget > 0) {
      pressureEnrichmentBudget -= 1;
      try {
        const since = Number(state.snapshots[marketKey]?.observedAt || now - 60_000);
        if (!Number.isFinite(Number(current.intervalTurnoverUsd))) current = await enrichFlowMarket(current, since);
        current = await enrichPressureEvidence(current, since);
        observation = pressureObservation(current, state.snapshots[marketKey], now);
        pressureDetection = evaluateDirectionalPressure(pressureHistory, observation, current);
      } catch (error) {
        await log(`pressure enrichment_failed symbol=${current.symbol} venue=${current.venue} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const previousPressureSignal = state.pressureSignals[marketKey];
    const pressureLifecycle = pressureEnabled && pressureVenues.has(current.venue)
      ? advancePressureLifecycle(previousPressureSignal, pressureDetection, now)
      : null;
    if (pressureLifecycle) state.pressureSignals[marketKey] = pressureLifecycle;
    if (!dryRun && pressureLifecycle?.event) {
      // Venue-normalized perpetual symbols are sufficient for private shadow
      // measurement. Registry verification remains mandatory for publication.
      const id = `pressure:${marketKey}:${now}`;
      const related = await ledger.recent({ symbol: current.symbol, since: now - 10 * 60_000, kinds: ['news', 'flow'] });
      const aligned = related.find(record => record.direction === pressureLifecycle.direction);
      const conflicting = related.find(record => record.direction && record.direction !== pressureLifecycle.direction);
      const correlation = aligned ? 'ALIGNED' : conflicting ? 'CONFLICTING' : 'PRESSURE_ONLY';
      const cmcEvidence = { liquidation: null, derivatives: null, errors: [] };
      if (cmcDerivativesClient) {
        try { cmcEvidence.liquidation = await cmcDerivativesClient.liquidationEvidence(current.symbol, pressureLifecycle.direction); }
        catch (error) { cmcEvidence.errors.push(`liquidations: ${error instanceof Error ? error.message : String(error)}`); }
        const crossVenueStates = new Set(['DEVELOPING', 'CONFIRMED_MOMENTUM', 'SUSTAINED', 'MOMENTUM_LOSS', 'RESUMED_MOMENTUM']);
        if (crossVenueStates.has(pressureLifecycle.state) && state.cmcEvidenceUsage.candidateRequests < cmcCandidateDailyLimit) {
          state.cmcEvidenceUsage.candidateRequests += 1;
          try {
            const evidence = await cmcDerivativesClient.derivativesEvidence(current.symbol);
            const prior = state.cmcDerivatives[current.symbol];
            const priorOi = Number(prior?.totalOpenInterestUsd || 0);
            cmcEvidence.derivatives = { ...evidence, totalOpenInterestChangePct: priorOi > 0 ? (evidence.totalOpenInterestUsd / priorOi - 1) * 100 : null };
            state.cmcDerivatives[current.symbol] = { observedAt: now, totalOpenInterestUsd: evidence.totalOpenInterestUsd };
          } catch (error) { cmcEvidence.errors.push(`derivatives: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
      await ledger.reserve({ id, kind: 'pressure', telemetryVersion: 3, symbol: current.symbol, direction: pressureLifecycle.direction, entryPrice: current.price, entryAt: new Date(now).toISOString(), quoteKey: marketKey, venue: current.venue, shadow: true, state: pressureLifecycle.state, character: pressureDetection.character || null, pressureScore: pressureDetection.pressureScore || 0, expansionScore: pressureDetection.expansionScore || 0, correlation, cmcEvidence, relatedAlertIds: related.map(record => record.id), priorSignalId: previousPressureSignal?.id || null, metrics: pressureDetection.metrics || {}, components: pressureDetection.components || {} });
      await ledger.delivery(id, 'shadow');
      state.pressureSignals[marketKey].id = id;
      pressureCandidates += 1;
      await log(`pressure shadow_candidate symbol=${current.symbol} venue=${current.venue} state=${pressureLifecycle.state} direction=${pressureLifecycle.direction} pressure=${pressureDetection.pressureScore || 0} expansion=${pressureDetection.expansionScore || 0} correlation=${correlation} cmcLiquidation=${cmcEvidence.liquidation?.alignment || 'unavailable'} cmcVenues=${cmcEvidence.derivatives?.venueCount || 0}${cmcEvidence.errors.length ? ` cmcErrors=${cmcEvidence.errors.join('|')}` : ''}`);
    }
    if (pressureEnabled && pressureVenues.has(current.venue)) state.pressureHistory[marketKey] = [...pressureHistory, observation].slice(-120);
    const detection = detectFlowIgnition(current, state.snapshots[marketKey], now);
    const recentlyAlerted = state.symbolAlerted[current.symbol] && now - state.symbolAlerted[current.symbol] < 12 * 3600_000;
    const recentlyShadowed = state.shadowAlerted[marketKey] && now - state.shadowAlerted[marketKey] < 12 * 3600_000;
    if (detection.eligible && (current.shadow ? !recentlyShadowed : !recentlyAlerted)) {
      const candidateStartedAt = Date.now();
      const tokenIdentity = await resolveTrackedToken(current.symbol, { referencePrice: current.price });
      if (!tokenIdentity) {
        if (current.shadow) state.shadowAlerted[marketKey] = now;
        else state.symbolAlerted[current.symbol] = now;
        await log(`flow suppressed=unverified_token symbol=${current.symbol} venue=${current.venue}`);
        continue;
      }
      if (isMemeToken(tokenIdentity) && !hasVerifiedContract(tokenIdentity)) {
        if (current.shadow) state.shadowAlerted[marketKey] = now;
        else state.symbolAlerted[current.symbol] = now;
        await log(`flow suppressed=memecoin_missing_verified_address symbol=${current.symbol} venue=${current.venue}`);
        continue;
      }
      if (!dryRun && current.shadow) {
        const alertId = `flow-shadow:${marketKey}:${now}`;
        state.shadowAlerted[marketKey] = now;
        await saveFlowState(state);
        await ledger.reserve({ id: alertId, kind: 'flow', symbol: current.symbol, direction: detection.direction, entryPrice: current.price, entryOpenInterest: current.openInterest, entryAt: new Date(now).toISOString(), quoteKey: marketKey, venue: current.venue, shadow: true, trigger: detection });
        await ledger.delivery(alertId, 'shadow');
        await recordFlowAlert({ ...current, tokenIdentity, shadow: true }, detection);
        await log(`flow shadow_candidate symbol=${current.symbol} venue=Kraken direction=${detection.direction}`);
      } else if (!dryRun) {
        // Reserve before delivery. Discord may accept a webhook even when its
        // response times out; pre-commit prevents a duplicate retry.
        state.alerted[marketKey] = now;
        state.symbolAlerted[current.symbol] = now;
        await saveFlowState(state);
        const alertId = `flow:${marketKey}:${now}`;
        await ledger.reserve({ id: alertId, kind: 'flow', symbol: current.symbol, direction: detection.direction, entryPrice: current.price, entryOpenInterest: current.openInterest, entryAt: new Date(now).toISOString(), quoteKey: marketKey, venue: current.venue, trigger: detection });
        try {
          // Use the already observed Hyperliquid market plus any cached venue
          // catalogs. A background refresh will improve later alerts without
          // placing network latency in front of this delivery.
          const perpDexVenues = findPerpDexVenues(current.symbol, markets, undefined, current.price);
          const deliveryStartedAt = Date.now();
          await sendFlowDiscord(current, detection, tokenIdentity, perpDexVenues);
          await ledger.delivery(alertId, 'sent');
          const tracking = createFlowTrackingPosition({ id: alertId, market: current, detection, tokenIdentity, now });
          if (tracking.kind === 'SQUEEZE_PRESSURE') state.flowTracking[alertId] = tracking;
          await recordFlowAlert({ ...current, tokenIdentity }, detection);
          alerts += 1;
          await log(`flow delivery_timing symbol=${current.symbol} venue=${current.venue} candidateToDiscordMs=${Date.now() - candidateStartedAt} discordMs=${Date.now() - deliveryStartedAt} scanAgeMs=${Date.now() - scanStartedAt}`);
        } catch (error) {
          await ledger.delivery(alertId, 'uncertain', { error: error instanceof Error ? error.message : String(error) });
          await log(`flow delivery_uncertain_reserved symbol=${current.symbol} venue=${current.venue} error=${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    state.snapshots[marketKey] = current;
  }
  const retention = now - 24 * 3600_000;
  state.alerted = Object.fromEntries(Object.entries(state.alerted).filter(([, timestamp]) => timestamp >= retention));
  state.symbolAlerted = Object.fromEntries(Object.entries(state.symbolAlerted).filter(([, timestamp]) => timestamp >= retention));
  state.shadowAlerted = Object.fromEntries(Object.entries(state.shadowAlerted).filter(([, timestamp]) => timestamp >= retention));
  state.flowTracking = Object.fromEntries(Object.entries(state.flowTracking).filter(([, position]) => Number(position.entryAt) >= retention));
  state.pressureSignals = Object.fromEntries(Object.entries(state.pressureSignals).filter(([, signal]) => Number(signal.updatedAt || signal.at) >= retention));
  state.cmcDerivatives = Object.fromEntries(Object.entries(state.cmcDerivatives).filter(([, snapshot]) => Number(snapshot.observedAt) >= retention));
  delete state.pressureHistory;
  delete state.pressureSignals;
  delete state.cmcDerivatives;
  delete state.cmcEvidenceUsage;
  await saveFlowState(state);
  await ledger.observe('flow', liveQuotes, now);
  const venueSummary = venueRequests.map(([name], index) => `${name}=${outcomes[index].status === 'fulfilled' ? outcomes[index].value.length : 'offline'}`).join(' ');
  await log(`flow markets=${markets.length} ${venueSummary} alerts=${alerts} pressureShadow=${pressureCandidates} durationMs=${Date.now() - scanStartedAt}${failures.length ? ` failures=${failures.join('|')}` : ''}${dryRun ? ' dry-run' : ''}`);
}

async function scan({ includePublishers = true } = {}) {
  const now = Date.now();
  const state = await loadState();
  const { raw, unique, online } = await collect(includePublishers);
  if (includePublishers && online === 0) throw new Error('All publisher feeds failed');
  const newItems = unique.filter(item => !state.seen[idFor(item)]);
  if (!newItems.length && !includePublishers && state.initialized) return;
  if (!state.initialized) {
    for (const item of unique) state.seen[idFor(item)] = now;
    state.initialized = true;
    await saveState(state);
    await log(`baseline recorded items=${unique.length} feeds=${online}/${sources.length}`);
    return;
  }
  const markets = await fetchMarkets();
  let sent = 0;
  let editorialRejected = 0;
  state.scopeAlerts ||= {};
  state.editorialHistory ||= [];
  state.canonicalEvents ||= {};
  for (const rawItem of newItems) {
    const item = rawItem.sourceKind === 'primary_x'
      ? await enrichXPostContent(rawItem, { timeoutMs: Number(process.env.X_LINK_FETCH_TIMEOUT_MS || 6000) })
      : rawItem;
    const preliminary = analyzeItem(item, raw, null, now);
    const market = preliminary.tokens.map(token => markets.get(token)).find(Boolean) || null;
    const analysis = analyzeItem(item, raw, market, now);
    const richPrimaryReview = item.sourceKind === 'primary_x' && item.trackedSymbol
      && (item.hasReviewableContent || hasReviewableXContent(item));
    const alertTokens = analysis.tokens.length ? analysis.tokens
      : analysis.editorialRescue && analysis.rescueToken ? [analysis.rescueToken]
        : richPrimaryReview ? [item.trackedSymbol] : [];
    const signal = { ...analysis, tokens: alertTokens, id: idFor(item), title: item.title, source: item.source, sourceKind: item.sourceKind || 'publisher', url: item.url, publishedAt: item.publishedAt.toISOString(),
      marketClassification: classifyMarketStatus({ eventType: analysis.eventType, token: alertTokens[0], title: item.title, description: item.description, market }) };
    const maxAgeMinutes = Number(process.env.DISCORD_MAX_AGE_MINUTES || DEFAULT_MAX_DISPATCH_AGE_MINUTES);
    const decision = dispatchDecision(signal, now, maxAgeMinutes);
    const rescueEligible = (signal.editorialRescue || richPrimaryReview) && signal.tokens.length === 1 && signal.ageMinutes >= 0 && signal.ageMinutes <= maxAgeMinutes;
    await ledger.append({ type: 'news_candidate', id: signal.id, headline: signal.title, source: signal.source, publishedAt: signal.publishedAt, symbol: signal.tokens[0] || '', mentionedTokens: signal.mentionedTokens, rulesEligible: decision.eligible, rulesReason: decision.reason, editorialRescue: rescueEligible, eventType: signal.eventType, score: signal.score });
    const key = eventKey(signal);
    const scope = alertScopeKey(signal);
    const legacyScopeTimes = Object.entries(state.events).filter(([priorKey]) => priorKey.startsWith(`${signal.tokens[0]}:`)).map(([, timestamp]) => timestamp);
    const scopeTimes = [...new Set([...(state.scopeAlerts[scope] || []), ...legacyScopeTimes])];
    const frequency = alertFrequencyDecision(scopeTimes, now);
    const duplicateEvent = state.events[key] && now - state.events[key] < 48 * 3600_000;
    const reviewEligible = (decision.eligible || rescueEligible) && ((frequency.eligible && !duplicateEvent) || signal.sourceKind !== 'primary_x');
    if (reviewEligible) {
      const tokenIdentity = await resolveTrackedToken(signal.tokens[0], { contextText: `${item.title} ${item.description}`, referencePrice: market?.price });
      if (!tokenIdentity) {
        editorialRejected += 1;
        await ledger.append({ type: 'editorial_decision', id: signal.id, approved: false, reason: 'unverified_token', symbol: signal.tokens[0], headline: signal.title, url: signal.url });
        await log(`editorial rejected=unverified_token token=${signal.tokens[0]} title=${JSON.stringify(signal.title)}`);
        state.seen[signal.id] = now;
        continue;
      }
      if (isMemeToken(tokenIdentity, { title: item.title, description: item.description }) && !hasVerifiedContract(tokenIdentity)) {
        editorialRejected += 1;
        await ledger.append({ type: 'editorial_decision', id: signal.id, approved: false, reason: 'memecoin_missing_verified_address', symbol: signal.tokens[0], headline: signal.title, url: signal.url, tokenIdentity });
        await log(`editorial rejected=memecoin_missing_verified_address token=${signal.tokens[0]} title=${JSON.stringify(signal.title)}`);
        state.seen[signal.id] = now;
        continue;
      }
      const tokenRisk = await checkTokenRisk(tokenIdentity);
      if (tokenRisk.blocked) {
        editorialRejected += 1;
        await ledger.append({ type: 'token_risk_decision', id: signal.id, approved: false, reason: 'high_risk_token', symbol: signal.tokens[0], headline: signal.title, url: signal.url, tokenIdentity, tokenRisk });
        await log(`editorial rejected=high_risk_token token=${signal.tokens[0]} blockers=${JSON.stringify(tokenRisk.blockers)} title=${JSON.stringify(signal.title)}`);
        state.seen[signal.id] = now;
        continue;
      }
      signal.tokenIdentity = tokenIdentity;
      signal.tokenRisk = tokenRisk;
      if (signal.marketClassification.untracked) signal.marketClassification = { ...signal.marketClassification, untracked: false, labels: [], label: `${tokenIdentity.provider.toUpperCase()} TRACKED` };
      const content = signal.sourceKind === 'primary_x'
        ? { text: item.extractedContent || item.description, source: item.contentSource || 'primary_x_post' }
        : await fetchArticleContent(item.url, item.description);
      const reviewArgs = { signal, article: { ...item, content: content.text, contentSource: content.source, imageUrls: item.imageUrls || [] }, recentAlerts: state.editorialHistory };
      const editorialShadowModel = process.env.EDITORIAL_SHADOW_MODEL || 'gpt-5.6-luna';
      const editorialShadowSampleRate = Math.max(0, Math.min(1, Number(process.env.EDITORIAL_SHADOW_SAMPLE_RATE || 0.1)));
      const runShadow = signal.sourceKind === 'primary_x' && selectedForEditorialShadow(signal.id, editorialShadowSampleRate)
        && editorialShadowModel !== (process.env.OPENAI_EDITORIAL_MODEL || 'gpt-5.6-terra');
      const [editorial, shadowEditorial] = await Promise.all([
        reviewEditorialCandidate(reviewArgs),
        runShadow ? reviewEditorialCandidate({ ...reviewArgs, env: { ...process.env, OPENAI_EDITORIAL_MODEL: editorialShadowModel } }) : null,
      ]);
      if (shadowEditorial) {
        await ledger.append({
          type: 'editorial_shadow_decision', id: signal.id, model: editorialShadowModel,
          approved: shadowEditorial.approved, reason: shadowEditorial.reason, symbol: signal.tokens[0],
          primaryApproved: editorial.approved, primaryReason: editorial.reason,
          verdict: shadowEditorial.verdict, usage: shadowEditorial.usage || null,
        });
      }
      const entryPrice = Number(tokenIdentity.currentPrice || market?.price || 0);
      if (signal.sourceKind === 'primary_x' && entryPrice > 0) {
        const benchmark = signal.tokens[0] === 'BTC' ? markets.get('ETH') : markets.get('BTC');
        const rangeBase = Number(market?.price || entryPrice);
        const preEventDailyVolatilityPct = rangeBase > 0 && Number(market?.high24h) > Number(market?.low24h)
          ? ((Number(market.high24h) - Number(market.low24h)) / rangeBase) * 100 : null;
        const verdictDirection = editorial.verdict?.direction;
        const evaluationDirection = ['BULLISH', 'BEARISH'].includes(verdictDirection) ? verdictDirection
          : ['BULLISH', 'BEARISH'].includes(signal.direction) ? signal.direction : 'UNCLEAR';
        const evaluationText = [item.title, content.text, editorial.verdict?.primary_subject, editorial.verdict?.what_changed].filter(Boolean).join(' ');
        const catalyst = classifyCatalystText(evaluationText);
        const evaluationId = `x-eval:${signal.id}`;
        await ledger.reserve({
          id: evaluationId, candidateId: signal.id, kind: 'x_candidate', symbol: signal.tokens[0], direction: evaluationDirection,
          entryPrice, entryAt: new Date(now).toISOString(), publishedAt: signal.publishedAt, ingestionLatencyMs: Math.max(0, now - Date.parse(signal.publishedAt)),
          quoteKey: `cg:${tokenIdentity.id}`, benchmarkQuoteKey: benchmark?.id ? `cg:${benchmark.id}` : '', benchmarkEntryPrice: Number(benchmark?.price || 0),
          preEventDailyVolatilityPct, headline: signal.title, source: signal.source, eventType: signal.eventType,
          catalystFamilies: catalyst.families, editorialApproved: editorial.approved, editorialReason: editorial.reason,
          editorialConfidence: Number(editorial.verdict?.confidence || 0), canonicalEventId: editorial.verdict?.canonical_event_id || '', shadow: true,
        });
        await ledger.delivery(evaluationId, 'shadow');
      }
      const delivery = classifyNewsDelivery({ sourceKind: signal.sourceKind, editorial, canonicalEvents: state.canonicalEvents });
      const throttleAllowsDelivery = !delivery.ping || (frequency.eligible && !duplicateEvent);
      await ledger.append({ type: 'editorial_decision', id: signal.id, approved: editorial.approved, contextApproved: editorial.contextApproved || false, deliveryKind: delivery.kind, reason: editorial.reason, symbol: signal.tokens[0], headline: signal.title, url: signal.url, contentSource: content.source, tokenIdentity, verdict: editorial.verdict, usage: editorial.usage || null });
      if (!delivery.deliver || !throttleAllowsDelivery) {
        editorialRejected += 1;
        await log(`editorial rejected=${throttleAllowsDelivery ? editorial.reason : 'frequency_or_duplicate'} token=${signal.tokens[0]} title=${JSON.stringify(signal.title)}`);
        state.seen[signal.id] = now;
        continue;
      }
      if (rescueEligible && !decision.eligible) {
        signal.score = Math.max(70, signal.score);
        signal.level = 'WATCH';
        signal.actionability = 'ACTIONABLE';
        signal.opportunityStatus = signal.ageMinutes <= 15 ? 'FLASH_EARLY' : 'MOMENTUM_UNDERWAY';
        if (signal.eventType === 'Market context') signal.eventType = 'Editorially confirmed catalyst';
      }
      if (editorial.verdict?.direction) signal.direction = editorial.verdict.direction;
      if (editorial.verdict?.what_changed || editorial.verdict?.rationale) signal.reason = [editorial.verdict.what_changed || editorial.verdict.rationale];
      if (!dryRun) {
        // Reserve before delivery for the same timeout/idempotency reason as flow.
        if (delivery.ping) {
          state.events[key] = now;
          state.scopeAlerts[scope] = [...(state.scopeAlerts[scope] || []), now];
        }
        const canonicalEventId = delivery.eventId;
        state.editorialHistory.push({ sentAt: new Date(now).toISOString(), asset: signal.tokens[0], eventType: signal.eventType, title: signal.title, primarySubject: editorial.verdict?.primary_subject || '', canonicalEventId, sourceKind: signal.sourceKind });
        if (canonicalEventId) {
          const prior = state.canonicalEvents[canonicalEventId] || {};
          state.canonicalEvents[canonicalEventId] = { ...prior, asset: signal.tokens[0], title: prior.title || signal.title,
            ...(delivery.kind === 'PRIMARY_ALERT' ? { primarySeenAt: new Date(now).toISOString(), primaryUrl: signal.url } : {}),
            ...(delivery.kind === 'CONTEXT_UPDATE' ? { contextSentAt: new Date(now).toISOString(), contextUrl: signal.url } : {}),
            lastSeenAt: new Date(now).toISOString() };
        }
        state.seen[signal.id] = now;
        await saveState(state);
        if (delivery.ping && entryPrice > 0) await ledger.reserve({ id: signal.id, kind: 'news', symbol: signal.tokens[0], direction: signal.direction, entryPrice, entryAt: new Date(now).toISOString(), quoteKey: `cg:${tokenIdentity.id}`, headline: signal.title, canonicalEventId: editorial.verdict?.canonical_event_id || '' });
        try {
          await sendDiscord(signal, delivery.kind);
          if (delivery.ping && entryPrice > 0) await ledger.delivery(signal.id, 'sent');
          sent += 1;
        } catch (error) {
          if (delivery.ping && entryPrice > 0) await ledger.delivery(signal.id, 'uncertain', { error: error instanceof Error ? error.message : String(error) });
          await log(`news delivery_uncertain_reserved token=${signal.tokens[0]} title=${JSON.stringify(signal.title)} error=${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    state.seen[signal.id] = now;
  }
  const retention = now - 72 * 3600_000;
  state.seen = Object.fromEntries(Object.entries(state.seen).filter(([, timestamp]) => timestamp >= retention));
  state.events = Object.fromEntries(Object.entries(state.events).filter(([, timestamp]) => timestamp >= retention));
  state.scopeAlerts = Object.fromEntries(Object.entries(state.scopeAlerts).map(([scope, timestamps]) => [scope, [...new Set(timestamps)].filter(timestamp => timestamp > now - ALERT_SCOPE_DAY_MS)]).filter(([, timestamps]) => timestamps.length));
  state.editorialHistory = state.editorialHistory.filter(entry => Date.parse(entry.sentAt) > now - 72 * 3600_000).slice(-100);
  state.canonicalEvents = Object.fromEntries(Object.entries(state.canonicalEvents).filter(([, event]) => Date.parse(event.lastSeenAt || event.primarySeenAt || 0) > now - 72 * 3600_000));
  await saveState(state);
  xInbox = xInbox.filter(item => !state.seen[idFor(item)] && now - item.publishedAt.getTime() < 6 * 3600_000);
  const [pendingNews, pendingXCandidates] = await Promise.all([ledger.pending('news'), ledger.pending('x_candidate')]);
  const quoteIds = [...pendingNews, ...pendingXCandidates].flatMap(record => [record.quoteKey, record.benchmarkQuoteKey])
    .map(value => String(value || '').replace(/^cg:/, '')).filter(Boolean);
  const prices = await fetchCoinGeckoPrices(quoteIds);
  const quoteMap = new Map(Object.entries(prices).map(([id, quote]) => [`cg:${id}`, Number(quote?.usd || 0)]));
  await Promise.all([ledger.observe('news', quoteMap, now), ledger.observe('x_candidate', quoteMap, now)]);
  await log(`scan new=${newItems.length} sent=${sent} editorialRejected=${editorialRejected} feeds=${online}/${sources.length}${dryRun ? ' dry-run' : ''}`);
}

if (!(await acquireInstanceLock())) process.exit(0);
await loadEnvironment();
intervalMs = Math.max(15, Number(process.env.PRESSURE_POLL_SECONDS || 30)) * 1000;
slowIntervalMs = Math.max(30, Number(process.env.RADAR_POLL_SECONDS || 60)) * 1000;
// Flow uses an independent clock so news collection cannot make a validated
// market alert wait. The detector itself requires at least 20 seconds between
// observations, so keep that as the safe lower bound.
flowIntervalMs = Math.max(20, Number(process.env.FLOW_POLL_SECONDS || 30)) * 1000;
await loadTokenCatalog();
await initializePressureState();
await startXPrimaryIngestion();
let nextSlowScanAt = 0;
let nextFlowScanAt = 0;
do {
  const cycleStartedAt = Date.now();
  const slowCycle = once || cycleStartedAt >= nextSlowScanAt;
  const flowCycle = once || cycleStartedAt >= nextFlowScanAt;
  const flowEnabled = String(process.env.FLOW_SQUEEZE_ENABLED || 'true').toLowerCase() !== 'false';
  const newsEnabled = String(process.env.NEWS_ALERTS_ENABLED || 'true').toLowerCase() !== 'false';
  const tasks = [scanPressure()];
  if (newsEnabled) tasks.push(scheduleNewsScan({ includePublishers: slowCycle }));
  if (flowCycle && flowEnabled) {
    tasks.push(scanFlow());
    nextFlowScanAt = cycleStartedAt + flowIntervalMs;
  }
  if (slowCycle) nextSlowScanAt = cycleStartedAt + slowIntervalMs;
  const results = await Promise.allSettled(tasks);
  for (const result of results) if (result.status === 'rejected') await log(`ERROR ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  if (once) break;
  const delay = Math.max(0, intervalMs - (Date.now() - cycleStartedAt));
  await new Promise(resolvePromise => setTimeout(resolvePromise, delay));
} while (true);
