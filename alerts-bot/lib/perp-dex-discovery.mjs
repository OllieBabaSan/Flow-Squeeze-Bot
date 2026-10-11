const CACHE_MS = 15 * 60_000;

let catalogCache = { at: 0, venues: [] };
let pendingCatalogs = null;

const clean = value => String(value || '').trim().toUpperCase();

export function normalizeAsterCatalog(payload) {
  return (payload?.symbols || []).flatMap(row => {
    if (clean(row.status) !== 'TRADING' || clean(row.contractType) !== 'PERPETUAL') return [];
    const symbol = clean(row.baseAsset);
    const contract = clean(row.symbol);
    if (!symbol || !contract) return [];
    return [{ symbol, contract }];
  });
}

export function normalizeGmxCatalog(payload, chain = 'Arbitrum') {
  return (payload?.markets || payload || []).flatMap(row => {
    if (!row?.isListed || /^SWAP-ONLY/i.test(String(row.name || ''))) return [];
    const match = String(row.name || '').match(/^([^/\s]+)\/USD\b/i);
    return match ? [{ symbol: clean(match[1]), contract: row.marketToken || '', chain }] : [];
  });
}

export function normalizeLighterCatalog(payload) {
  return (payload?.order_book_details || []).flatMap(row => {
    if (String(row.status || '').toLowerCase() !== 'active' || String(row.market_type || '').toLowerCase() !== 'perp') return [];
    const symbol = clean(row.symbol);
    const marketId = Number(row.market_id);
    const markPrice = Number(row.mark_price);
    const indexPrice = Number(row.index_price);
    if (!symbol || !Number.isInteger(marketId) || marketId < 0) return [];
    return [{ symbol, contract: String(marketId), markPrice: markPrice > 0 ? markPrice : null, indexPrice: indexPrice > 0 ? indexPrice : null }];
  });
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Perp DEX catalog HTTP ${response.status}`);
  return response.json();
}

export async function refreshPerpDexCatalogs({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (catalogCache.venues.length && now - catalogCache.at < CACHE_MS) return catalogCache.venues;
  if (pendingCatalogs) return pendingCatalogs;
  pendingCatalogs = Promise.allSettled([
    fetchJson(fetchImpl, 'https://fapi.asterdex.com/fapi/v1/exchangeInfo').then(normalizeAsterCatalog),
    fetchJson(fetchImpl, 'https://arbitrum-api.gmxinfra.io/markets/info').then(payload => normalizeGmxCatalog(payload, 'Arbitrum')),
    fetchJson(fetchImpl, 'https://avalanche-api.gmxinfra.io/markets/info').then(payload => normalizeGmxCatalog(payload, 'Avalanche')),
    fetchJson(fetchImpl, 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails').then(normalizeLighterCatalog),
  ]).then(results => {
    const [aster, gmxArbitrum, gmxAvalanche, lighter] = results.map(result => result.status === 'fulfilled' ? result.value : []);
    const venues = [
      { name: 'Aster', markets: aster, tradeUrl: contract => `https://www.asterdex.com/en/trade/pro/${encodeURIComponent(contract)}` },
      { name: 'GMX', markets: [...gmxArbitrum, ...gmxAvalanche], tradeUrl: () => 'https://app.gmx.io/trade' },
      { name: 'Lighter', markets: lighter, requirePriceMatch: true, tradeUrl: (_contract, market) => `https://lighter.exchange/trade/${encodeURIComponent(market.symbol)}` },
    ];
    if (venues.some(venue => venue.markets.length)) catalogCache = { at: now, venues };
    return venues;
  }).finally(() => { pendingCatalogs = null; });
  return pendingCatalogs;
}

export function findPerpDexVenues(symbol, observedMarkets = [], catalogs = catalogCache.venues, referencePrice = null) {
  const target = clean(symbol);
  if (!target) return [];
  const found = [];
  if (observedMarkets.some(market => market.venue === 'Hyperliquid' && clean(market.symbol) === target)) {
    found.push({ name: 'Hyperliquid', contract: target, marketLabel: `${target}/USD perpetual`, url: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(target)}` });
  }
  for (const venue of catalogs) {
    const matches = venue.markets.filter(market => market.symbol === target);
    for (const market of matches) {
      if (venue.requirePriceMatch) {
        const venuePrice = Number(market.indexPrice || market.markPrice);
        const triggerPrice = Number(referencePrice);
        if (!(venuePrice > 0 && triggerPrice > 0) || Math.abs(Math.log(venuePrice / triggerPrice)) > Math.log(1.2)) continue;
      }
      const suffix = market.chain ? ` (${market.chain})` : '';
      const quote = market.contract.endsWith('USDT') ? 'USDT' : 'USD';
      found.push({ name: `${venue.name}${suffix}`, contract: market.contract, marketLabel: `${target}/${quote} perpetual`, url: venue.tradeUrl(market.contract, market) });
    }
  }
  return found.filter((venue, index, all) => all.findIndex(other => other.name === venue.name && other.contract === venue.contract) === index);
}

export function perpDexAlertField(venues) {
  if (!venues?.length) return 'No supported perp DEX market located';
  return venues.map(venue => `[${venue.name} · ${venue.marketLabel || venue.contract}](${venue.url})`).join('\n');
}
