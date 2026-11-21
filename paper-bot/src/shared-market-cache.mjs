import { readFile } from 'node:fs/promises';

export function normalizeCacheErrorFingerprint(message) {
  return String(message || 'UNKNOWN_CACHE_ERROR')
    .split('\n')[0]
    .replace(/\(-?\d+ms\)/g, '(<age>ms)');
}

export function serializeMarkets(markets, generatedAtMs = Date.now(), catalogUpdatedAtMs = generatedAtMs) {
  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    generatedAtMs,
    catalogUpdatedAtMs,
    markets: Object.fromEntries([...markets].map(([symbol, market]) => [symbol, market])),
  };
}

export function parseMarketSnapshot(snapshot, now = Date.now(), maximumAgeMs = 15_000, maximumBookAgeMs = 5_000, maximumCatalogAgeMs = 45_000) {
  if (snapshot?.schemaVersion !== 1 || !Number.isFinite(Number(snapshot.generatedAtMs)) || !snapshot.markets) {
    throw new Error('Shared Hyperliquid market cache is invalid');
  }
  const ageMs = now - Number(snapshot.generatedAtMs);
  if (ageMs < -5_000 || ageMs > maximumAgeMs) throw new Error(`Shared Hyperliquid market cache is stale (${ageMs}ms)`);
  const catalogAgeMs = now - Number(snapshot.catalogUpdatedAtMs || snapshot.generatedAtMs);
  if (catalogAgeMs < -5_000 || catalogAgeMs > maximumCatalogAgeMs) throw new Error(`Shared Hyperliquid catalog is stale (${catalogAgeMs}ms)`);
  return new Map(Object.entries(snapshot.markets).map(([symbol, market]) => {
    const bookAgeMs = now - Number(market.bookUpdatedAtMs || 0);
    return [symbol, bookAgeMs >= 0 && bookAgeMs <= maximumBookAgeMs
      ? market : { ...market, bid: null, ask: null, bidLevels: null, askLevels: null }];
  }));
}

export async function readMarketSnapshot(path, now = Date.now(), maximumAgeMs = 15_000, maximumBookAgeMs = 5_000, maximumCatalogAgeMs = 45_000) {
  return parseMarketSnapshot(JSON.parse(await readFile(path, 'utf8')), now, maximumAgeMs, maximumBookAgeMs, maximumCatalogAgeMs);
}
