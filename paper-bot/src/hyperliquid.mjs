const INFO_URL = 'https://api.hyperliquid.xyz/info';

async function info(body) {
  const response = await fetch(INFO_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json();
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
  const bid = Number(book?.levels?.[0]?.[0]?.px), ask = Number(book?.levels?.[1]?.[0]?.px);
  return { ...market, bid, ask, mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : market.mid };
}
