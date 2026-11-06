const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const median = values => {
  const sorted = values.filter(finite).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const TRUSTED_EXCHANGES = new Set(['binance', 'okx', 'bybit', 'kraken', 'hyperliquid', 'deribit', 'gate-io', 'gate']);

function liquidationClassification(row, direction) {
  if (!row) return { available: false };
  const total1hUsd = Number(row.total_liquidations_1h || 0);
  const long1hUsd = Number(row.long_liquidations_1h || 0);
  const short1hUsd = Number(row.short_liquidations_1h || 0);
  let bias = 'MIXED';
  if (total1hUsd < 25_000) bias = 'LOW_ACTIVITY';
  else if (short1hUsd >= Math.max(1, long1hUsd) * 2) bias = 'SHORT_LIQUIDATION_DOMINANT';
  else if (long1hUsd >= Math.max(1, short1hUsd) * 2) bias = 'LONG_LIQUIDATION_DOMINANT';
  const aligned = (direction === 'BULLISH' && bias === 'SHORT_LIQUIDATION_DOMINANT')
    || (direction === 'BEARISH' && bias === 'LONG_LIQUIDATION_DOMINANT');
  const opposed = (direction === 'BULLISH' && bias === 'LONG_LIQUIDATION_DOMINANT')
    || (direction === 'BEARISH' && bias === 'SHORT_LIQUIDATION_DOMINANT');
  return {
    available: true, bias, alignment: aligned ? 'ALIGNED' : opposed ? 'OPPOSED' : bias,
    total1hUsd, long1hUsd, short1hUsd,
    total4hUsd: Number(row.total_liquidations_4h || 0), long4hUsd: Number(row.long_liquidations_4h || 0), short4hUsd: Number(row.short_liquidations_4h || 0),
    lastUpdated: row.last_updated || null,
  };
}

function liquidationDeltaEvidence(current, baseline, direction) {
  if (!current?.available || !baseline?.available) return { available: false, source: 'POST_ALERT_DELTA', reason: 'BASELINE_UNAVAILABLE' };
  const total1hUsd = Math.max(0, Number(current.total1hUsd || 0) - Number(baseline.total1hUsd || 0));
  const long1hUsd = Math.max(0, Number(current.long1hUsd || 0) - Number(baseline.long1hUsd || 0));
  const short1hUsd = Math.max(0, Number(current.short1hUsd || 0) - Number(baseline.short1hUsd || 0));
  const classified = liquidationClassification({
    total_liquidations_1h: total1hUsd,
    long_liquidations_1h: long1hUsd,
    short_liquidations_1h: short1hUsd,
    total_liquidations_4h: Math.max(0, Number(current.total4hUsd || 0) - Number(baseline.total4hUsd || 0)),
    long_liquidations_4h: Math.max(0, Number(current.long4hUsd || 0) - Number(baseline.long4hUsd || 0)),
    short_liquidations_4h: Math.max(0, Number(current.short4hUsd || 0) - Number(baseline.short4hUsd || 0)),
    last_updated: current.lastUpdated,
  }, direction);
  return {
    ...classified,
    source: 'POST_ALERT_DELTA',
    baselineLastUpdated: baseline.lastUpdated || null,
    currentLastUpdated: current.lastUpdated || null,
    baselineCapturedAt: baseline.capturedAt || null,
    currentCapturedAt: current.capturedAt || null,
    freshSnapshot: Boolean(current.lastUpdated && current.lastUpdated !== baseline.lastUpdated),
  };
}

function exchangeDerivativesContext(payload, capturedAt = new Date().toISOString()) {
  const exchanges = (payload?.exchanges || []).flatMap(exchange => {
    const quote = exchange.quotes?.[0] || {};
    if (!finite(quote.open_interest_usd ?? quote.open_interest)) return [];
    return [{
      exchangeId: exchange.exchange_id ?? null,
      exchange: exchange.exchange_name || exchange.exchange_slug || 'Unknown',
      slug: exchange.exchange_slug || null,
      openInterestUsd: Number(quote.open_interest_usd ?? quote.open_interest),
      derivativeVolumeUsd: Number(quote.derivative_volume_usd ?? quote.derivative_volume ?? 0),
      lastUpdated: quote.last_updated || exchange.last_updated || null,
    }];
  });
  return {
    available: exchanges.length > 0,
    source: 'CMC_EXCHANGE_DERIVATIVES',
    capturedAt,
    exchangeCount: exchanges.length,
    aggregateOpenInterestUsd: exchanges.reduce((sum, row) => sum + row.openInterestUsd, 0),
    aggregateDerivativeVolumeUsd: exchanges.reduce((sum, row) => sum + row.derivativeVolumeUsd, 0),
    latestUpdated: exchanges.map(row => row.lastUpdated).filter(Boolean).sort().at(-1) || null,
    exchanges,
  };
}

function derivativesSummary(payload) {
  const pairs = (payload?.market_pairs || []).filter(pair => {
    const slug = String(pair.exchange?.exchange_slug || '').toLowerCase();
    return pair.category === 'perpetual' && !pair.outlier_detected && TRUSTED_EXCHANGES.has(slug);
  });
  const rows = pairs.flatMap(pair => {
    const reported = pair.exchange_reported_quotes?.[0] || {};
    const quote = pair.quotes?.[0] || {};
    if (!finite(reported.price || quote.price)) return [];
    return [{
      exchange: pair.exchange?.exchange_name || pair.exchange?.exchange_slug || 'Unknown',
      price: Number(reported.price || quote.price),
      openInterestUsd: Number(reported.open_interest || quote.open_interest || 0),
      fundingRate: finite(reported.funding_rate) ? Number(reported.funding_rate) : null,
      indexBasis: finite(reported.index_basis) ? Number(reported.index_basis) : null,
      lastUpdated: reported.last_updated || quote.last_updated || null,
    }];
  });
  const funding = rows.map(row => row.fundingRate).filter(finite);
  const positiveFunding = funding.filter(value => value > 0).length;
  const negativeFunding = funding.filter(value => value < 0).length;
  const prices = rows.map(row => row.price).filter(value => value > 0);
  const midpoint = median(prices);
  const dispersionPct = midpoint && prices.length > 1 ? (Math.max(...prices) / Math.min(...prices) - 1) * 100 : null;
  const venues = [...new Set(rows.map(row => row.exchange))];
  return {
    available: rows.length > 0,
    venueCount: venues.length,
    marketCount: rows.length,
    venues,
    totalOpenInterestUsd: rows.reduce((sum, row) => sum + row.openInterestUsd, 0),
    medianFundingRate: median(funding),
    fundingSkew: positiveFunding > negativeFunding ? 'LONG_BIASED' : negativeFunding > positiveFunding ? 'SHORT_BIASED' : 'BALANCED',
    positiveFundingVenues: positiveFunding,
    negativeFundingVenues: negativeFunding,
    medianIndexBasis: median(rows.map(row => row.indexBasis)),
    priceDispersionPct: dispersionPct,
    markets: rows,
  };
}

export function createCmcDerivativesClient({
  apiKey,
  fetchImpl = fetch,
  now = () => Date.now(),
  liquidationCacheMs = 2 * 60_000,
  derivativesCacheMs = 15 * 60_000,
  exchangeContextCacheMs = 15 * 60_000,
  keyInfoCacheMs = 60 * 60_000,
  monthlyCreditReserve = 1500,
} = {}) {
  let liquidationCache = null;
  let exchangeContextCache = null;
  let keyInfoCache = null;
  const derivativesCache = new Map();
  const rawRequest = async path => {
    if (!apiKey) throw new Error('COINMARKETCAP_API_KEY is not configured');
    const response = await fetchImpl(`https://pro-api.coinmarketcap.com${path}`, {
      headers: { Accept: 'application/json', 'X-CMC_PRO_API_KEY': apiKey }, signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (!response.ok || Number(payload?.status?.error_code || 0)) throw new Error(payload?.status?.error_message || `CMC HTTP ${response.status}`);
    return payload.data;
  };
  const ensureCreditBudget = async () => {
    const timestamp = now();
    if (!keyInfoCache || timestamp - keyInfoCache.at >= keyInfoCacheMs) {
      const data = await rawRequest('/v1/key/info');
      keyInfoCache = { at: timestamp, data };
    }
    const creditsLeft = Number(keyInfoCache.data?.usage?.current_month?.credits_left);
    if (Number.isFinite(creditsLeft) && creditsLeft <= monthlyCreditReserve) throw new Error(`CMC_CREDIT_RESERVE_REACHED creditsLeft=${creditsLeft}`);
    return keyInfoCache.data;
  };
  const request = async path => {
    await ensureCreditBudget();
    return rawRequest(path);
  };
  const liquidationMap = async ({ force = false } = {}) => {
    const timestamp = now();
    if (!force && liquidationCache && timestamp - liquidationCache.at < liquidationCacheMs) return liquidationCache.data;
    const data = await request('/v5/derivatives/liquidations/cryptocurrency/list/latest?limit=250');
    const byId = new Map(); const bySymbol = new Map(); const ambiguousSymbols = new Set();
    for (const asset of data?.cryptocurrencies || []) {
      const evidence = { ...(asset.quotes?.[0] || {}), captured_at: new Date(timestamp).toISOString() };
      const cryptoId = String(asset.id ?? asset.crypto_id ?? '');
      const symbol = String(asset.symbol || '').toUpperCase();
      if (cryptoId) byId.set(cryptoId, evidence);
      if (bySymbol.has(symbol)) ambiguousSymbols.add(symbol);
      else bySymbol.set(symbol, evidence);
    }
    for (const symbol of ambiguousSymbols) bySymbol.delete(symbol);
    const mapped = { byId, bySymbol, ambiguousSymbols };
    liquidationCache = { at: timestamp, data: mapped };
    return mapped;
  };
  const classifyAsset = (map, symbol, direction, cryptoId) => {
    const row = cryptoId ? map?.byId?.get(String(cryptoId)) : map?.bySymbol?.get(String(symbol).toUpperCase());
    const evidence = liquidationClassification(row, direction);
    return evidence.available ? { ...evidence, capturedAt: row.captured_at || null, cryptoId: cryptoId || null } : evidence;
  };
  const exchangeContext = async ({ force = false } = {}) => {
    const timestamp = now();
    if (!force && exchangeContextCache && timestamp - exchangeContextCache.at < exchangeContextCacheMs) return exchangeContextCache.data;
    const data = exchangeDerivativesContext(await request('/v5/exchange/derivatives/list?limit=250'), new Date(timestamp).toISOString());
    exchangeContextCache = { at: timestamp, data };
    return data;
  };
  return {
    liquidationEvidence: async (symbol, direction, { cryptoId = null, force = false } = {}) => classifyAsset(await liquidationMap({ force }), symbol, direction, cryptoId),
    peekLiquidationEvidence: (symbol, direction, { cryptoId = null } = {}) => classifyAsset(liquidationCache?.data, symbol, direction, cryptoId),
    primeLiquidations: liquidationMap,
    liquidationDeltaEvidence,
    exchangeContext,
    peekExchangeContext: () => exchangeContextCache?.data || null,
    keyInfo: ensureCreditBudget,
    derivativesEvidence: async (symbol, { cryptoId = null } = {}) => {
      const key = cryptoId ? `id:${cryptoId}` : `symbol:${String(symbol).toUpperCase()}`;
      const timestamp = now(), cached = derivativesCache.get(key);
      if (cached && timestamp - cached.at < derivativesCacheMs) return cached.data;
      const identityQuery = cryptoId ? `crypto_id=${encodeURIComponent(cryptoId)}` : `crypto_symbol=${encodeURIComponent(String(symbol).toUpperCase())}`;
      const data = derivativesSummary(await request(`/v5/cryptocurrency/derivatives/market-pairs/list/latest?${identityQuery}&limit=100`));
      derivativesCache.set(key, { at: timestamp, data });
      return data;
    },
    peekDerivativesEvidence: (symbol, { cryptoId = null } = {}) => derivativesCache.get(cryptoId ? `id:${cryptoId}` : `symbol:${String(symbol).toUpperCase()}`)?.data || null,
  };
}

export { derivativesSummary, exchangeDerivativesContext, liquidationClassification, liquidationDeltaEvidence };
