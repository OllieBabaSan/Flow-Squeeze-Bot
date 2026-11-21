const INDEXER_URL = 'https://indexer.dydx.trade/v4';

async function getJson(path) {
  const response = await fetch(`${INDEXER_URL}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`dYdX HTTP ${response.status} for ${path}`);
  return response.json();
}

export function normalizeMarkets(payload) {
  const rows = payload?.markets || payload?.perpetualMarkets || payload || {};
  const values = Array.isArray(rows) ? rows : Object.values(rows);
  const markets = new Map();
  for (const row of values) {
    const ticker = String(row?.ticker || row?.market || row?.symbol || '').toUpperCase();
    if (!ticker) continue;
    const base = String(row?.baseAsset || ticker.replace(/-USD(?:C)?$/, '')).toUpperCase();
    markets.set(base, {
      symbol: base,
      ticker,
      status: row?.status || null,
      oraclePrice: Number(row?.oraclePrice || row?.indexPrice || 0) || null,
      openInterest: Number(row?.openInterest || 0) || null,
      volume24hUsd: Number(row?.volume24H || row?.volume24h || row?.trades24H || 0) || null,
      raw: row,
    });
  }
  return markets;
}

export async function fetchDydxMarkets() {
  return normalizeMarkets(await getJson('/perpetualMarkets'));
}

export function normalizeOrderbook(payload) {
  const normalizeSide = rows => (rows || []).map(row => ({
    price: Number(row?.price ?? row?.px ?? row?.[0]),
    size: Number(row?.size ?? row?.sz ?? row?.[1]),
  })).filter(level => level.price > 0 && level.size > 0);
  return {
    bids: normalizeSide(payload?.bids).sort((a, b) => b.price - a.price),
    asks: normalizeSide(payload?.asks).sort((a, b) => a.price - b.price),
  };
}

export async function fetchDydxBook(ticker) {
  return normalizeOrderbook(await getJson(`/orderbooks/perpetualMarket/${encodeURIComponent(ticker)}`));
}
