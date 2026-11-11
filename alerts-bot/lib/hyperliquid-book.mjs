const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function normalizeHyperliquidTopOfBook(payload, observedAt = Date.now()) {
  const levels = payload?.levels;
  const bid = finitePositive(levels?.[0]?.[0]?.px);
  const ask = finitePositive(levels?.[1]?.[0]?.px);
  if (bid == null || ask == null || ask < bid) return null;
  return {
    bestBid: bid,
    bestAsk: ask,
    bookObservedAt: observedAt,
    spreadSource: 'HYPERLIQUID_L2_BOOK',
  };
}

export async function fetchHyperliquidTopOfBook(symbol, { timeoutMs = 6000, now = Date.now() } = {}) {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'l2Book', coin: symbol }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Hyperliquid l2Book HTTP ${response.status}`);
  const book = normalizeHyperliquidTopOfBook(await response.json(), now);
  if (!book) throw new Error('Hyperliquid l2Book missing usable top levels');
  return book;
}
