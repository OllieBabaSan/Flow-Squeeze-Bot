const INFO_URL = 'https://api.hyperliquid.xyz/info';

async function info(body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(INFO_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
      if (response.ok) return response.json();
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error(`Hyperliquid HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 500 * 2 ** attempt));
    } catch (error) {
      if (attempt === 2 || /^Hyperliquid HTTP /.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

export async function fetchMarkets() {
  const [meta, contexts] = await info({ type: 'metaAndAssetCtxs' });
  const markets = new Map();
  for (let index = 0; index < (meta?.universe || []).length; index += 1) {
    const asset = meta.universe[index], context = contexts[index];
    if (!asset || !context) continue;
    const mark = Number(context.markPx), mid = Number(context.midPx || context.markPx);
    markets.set(String(asset.name), {
      symbol: String(asset.name), isDelisted: Boolean(asset.isDelisted), mark, mid,
      bid: null, ask: null, openInterest: Number(context.openInterest),
      volume24hUsd: Number(context.dayNtlVlm), fundingRate: Number(context.funding),
    });
  }
  return markets;
}

export async function attachBook(market) {
  if (!market) return null;
  const book = await info({ type: 'l2Book', coin: market.symbol });
  const normalizeLevels = rows => (rows || []).map(row => ({ price: Number(row.px), size: Number(row.sz) }))
    .filter(row => row.price > 0 && row.size > 0).slice(0, 20);
  const bidLevels = normalizeLevels(book?.levels?.[0]);
  const askLevels = normalizeLevels(book?.levels?.[1]);
  const bid = bidLevels[0]?.price, ask = askLevels[0]?.price;
  return { ...market, bid, ask, bidLevels, askLevels, mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : market.mid };
}

export async function fetchCandles(symbol, startTime, endTime, interval = '1m') {
  const rows = await info({ type: 'candleSnapshot', req: { coin: symbol, interval, startTime, endTime } });
  return (rows || []).map(row => ({
    timeMs: Number(row.t), open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume: Number(row.v),
  })).filter(row => row.timeMs > 0 && row.close > 0).sort((a, b) => a.timeMs - b.timeMs);
}
