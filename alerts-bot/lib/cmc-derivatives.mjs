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

export function createCmcDerivativesClient({ apiKey, fetchImpl = fetch, now = () => Date.now(), liquidationCacheMs = 10 * 60_000, derivativesCacheMs = 15 * 60_000 } = {}) {
  let liquidationCache = null;
  const derivativesCache = new Map();
  const request = async path => {
    if (!apiKey) throw new Error('COINMARKETCAP_API_KEY is not configured');
    const response = await fetchImpl(`https://pro-api.coinmarketcap.com${path}`, {
      headers: { Accept: 'application/json', 'X-CMC_PRO_API_KEY': apiKey }, signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (!response.ok || Number(payload?.status?.error_code || 0)) throw new Error(payload?.status?.error_message || `CMC HTTP ${response.status}`);
    return payload.data;
  };
  const liquidationMap = async () => {
    const timestamp = now();
    if (liquidationCache && timestamp - liquidationCache.at < liquidationCacheMs) return liquidationCache.data;
    const data = await request('/v5/derivatives/liquidations/cryptocurrency/list/latest?limit=250');
    const mapped = new Map((data?.cryptocurrencies || []).map(asset => [String(asset.symbol || '').toUpperCase(), asset.quotes?.[0] || null]));
    liquidationCache = { at: timestamp, data: mapped };
    return mapped;
  };
  return {
    liquidationEvidence: async (symbol, direction) => liquidationClassification((await liquidationMap()).get(String(symbol).toUpperCase()), direction),
    peekLiquidationEvidence: (symbol, direction) => liquidationClassification(liquidationCache?.data?.get(String(symbol).toUpperCase()), direction),
    primeLiquidations: liquidationMap,
    derivativesEvidence: async symbol => {
      const key = String(symbol).toUpperCase(), timestamp = now(), cached = derivativesCache.get(key);
      if (cached && timestamp - cached.at < derivativesCacheMs) return cached.data;
      const data = derivativesSummary(await request(`/v5/cryptocurrency/derivatives/market-pairs/list/latest?crypto_symbol=${encodeURIComponent(key)}&limit=100`));
      derivativesCache.set(key, { at: timestamp, data });
      return data;
    },
    peekDerivativesEvidence: symbol => derivativesCache.get(String(symbol).toUpperCase())?.data || null,
  };
}

export { derivativesSummary, liquidationClassification };
