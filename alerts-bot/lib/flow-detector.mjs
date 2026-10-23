export const FLOW_DEFAULTS = {
  // This detector is an early-warning screen, not a report that a large move
  // has already happened. Derivatives participation supplies confirmation.
  minimumMovePct: 0.75,
  maximumEarlyMovePct: 3.5,
  minimumFreshTurnoverUsd: 250_000,
  minimumTurnover24hUsd: 10_000_000,
  maximumTurnover24hUsd: 500_000_000,
  crowdedShortFundingRate: -0.0005,
  crowdedLongFundingRate: 0.0005,
  minimumOpenInterestGrowthPct: 0.5,
  minimumCrowdedPositioningOiGrowthPct: 0.15,
};

const finiteMarket = market => [market.price, market.turnover24h, market.openInterest, market.fundingRate]
  .every(value => Number.isFinite(value));

export function normalizeBybitMarkets(payload, observedAt = Date.now()) {
  if (Number(payload?.retCode) !== 0) throw new Error(`Bybit ${payload?.retMsg || 'feed error'}`);
  return (payload?.result?.list || []).flatMap(row => {
    const contract = String(row.symbol || '');
    if (!contract.endsWith('USDT')) return [];
    const market = {
      symbol: contract.replace(/USDT$/, ''), venue: 'Bybit', venueLabel: 'Bybit perpetuals',
      price: Number(row.lastPrice), turnover24h: Number(row.turnover24h),
      openInterest: Number(row.openInterest), fundingRate: Number(row.fundingRate),
      fundingLabel: 'Funding', observedAt,
    };
    return finiteMarket(market) ? [market] : [];
  });
}

export function normalizeBinanceMarkets({ tickers = [], premiums = [], openInterests = [], symbols = [] }, observedAt = Date.now()) {
  const premiumBySymbol = new Map(premiums.map(row => [String(row.symbol || ''), row]));
  const oiBySymbol = new Map(openInterests.map(row => [String(row.symbol || ''), row]));
  const enabled = new Set(symbols
    .filter(row => row?.contractType === 'PERPETUAL' && row?.quoteAsset === 'USDT' && row?.status === 'TRADING')
    .map(row => String(row.symbol || '')));
  return tickers.flatMap(row => {
    const contract = String(row.symbol || '');
    if (!enabled.has(contract) || !contract.endsWith('USDT')) return [];
    const premium = premiumBySymbol.get(contract);
    const oi = oiBySymbol.get(contract);
    const market = {
      symbol: contract.replace(/USDT$/, ''), venue: 'Binance', venueLabel: 'Binance USD-M perpetuals (shadow)',
      venueSymbol: contract, price: Number(premium?.markPrice || row.lastPrice), turnover24h: Number(row.quoteVolume),
      openInterest: Number(oi?.openInterest), fundingRate: Number(premium?.lastFundingRate),
      fundingLabel: 'Funding (8h)', observedAt, shadow: true,
    };
    return market.symbol && finiteMarket(market) ? [market] : [];
  });
}

export function normalizeOkxMarkets({ tickers = [], openInterests = [], fundingRates = [] }, observedAt = Date.now()) {
  const oiByInstrument = new Map(openInterests.map(row => [String(row.instId || ''), row]));
  const fundingByInstrument = new Map(fundingRates.map(row => [String(row.instId || ''), row]));
  return tickers.flatMap(row => {
    const instrument = String(row.instId || '');
    const match = /^(.+)-USDT-SWAP$/.exec(instrument);
    if (!match) return [];
    const price = Number(row.last);
    const market = {
      symbol: match[1], venue: 'OKX', venueLabel: 'OKX USDT perpetuals (shadow)',
      venueSymbol: instrument, price, turnover24h: Number(row.volCcy24h) * price,
      openInterest: Number(oiByInstrument.get(instrument)?.oiCcy),
      fundingRate: Number(fundingByInstrument.get(instrument)?.fundingRate),
      fundingLabel: 'Funding', observedAt, shadow: true,
    };
    return market.symbol && finiteMarket(market) ? [market] : [];
  });
}

export function normalizeBitgetMarkets(payload, observedAt = Date.now()) {
  if (String(payload?.code) !== '00000') throw new Error(`Bitget ${payload?.msg || 'feed error'}`);
  return (payload?.data || []).flatMap(row => {
    const contract = String(row.symbol || '');
    if (!contract.endsWith('USDT')) return [];
    const market = {
      symbol: contract.replace(/USDT$/, ''), venue: 'Bitget', venueLabel: 'Bitget USDT perpetuals (shadow)',
      venueSymbol: contract, price: Number(row.markPrice || row.lastPrice),
      turnover24h: Number(row.turnover24h), openInterest: Number(row.openInterest),
      fundingRate: Number(row.fundingRate), fundingLabel: 'Funding', observedAt, shadow: true,
    };
    return market.symbol && finiteMarket(market) ? [market] : [];
  });
}

export function normalizeHyperliquidMarkets(payload, observedAt = Date.now()) {
  const [meta, contexts] = Array.isArray(payload) ? payload : [];
  if (!Array.isArray(meta?.universe) || !Array.isArray(contexts)) throw new Error('Hyperliquid malformed feed');
  return meta.universe.flatMap((asset, index) => {
    const context = contexts[index];
    if (!context || asset?.isDelisted) return [];
    const market = {
      symbol: String(asset.name || ''), venue: 'Hyperliquid', venueLabel: 'Hyperliquid perpetuals',
      price: Number(context.markPx), turnover24h: Number(context.dayNtlVlm),
      openInterest: Number(context.openInterest),
      // Hyperliquid reports hourly funding. Normalize it to an 8-hour equivalent
      // so the existing crowded-short threshold remains comparable across venues.
      fundingRate: Number(context.funding) * 8,
      fundingLabel: 'Funding (8h equivalent)', observedAt,
    };
    return market.symbol && finiteMarket(market) ? [market] : [];
  });
}

export function normalizeKrakenMarkets(payload, observedAt = Date.now()) {
  const aliases = { XBT: 'BTC' };
  return (payload?.tickers || []).flatMap(row => {
    if (row?.tag !== 'perpetual' || row?.suspended) return [];
    const [base, quote] = String(row.pair || '').split(':');
    if (!base || quote !== 'USD') return [];
    const price = Number(row.markPrice || row.last);
    const absoluteHourlyFunding = Number(row.fundingRate);
    const market = {
      symbol: aliases[base] || base, venue: 'Kraken', venueLabel: 'Kraken perpetuals (shadow)',
      venueSymbol: String(row.symbol || ''), price, turnover24h: Number(row.volumeQuote),
      openInterest: Number(row.openInterest),
      // Kraken's ticker funding is an absolute hourly payment per unit. Divide
      // by mark price and multiply by eight for comparison with 8h rates.
      fundingRate: price > 0 ? (absoluteHourlyFunding / price) * 8 : NaN,
      fundingLabel: 'Funding (8h equivalent)', observedAt, shadow: true,
    };
    return market.symbol && market.venueSymbol && finiteMarket(market) ? [market] : [];
  });
}

export function detectFlowIgnition(current, previous, now = Date.now(), options = {}) {
  const rules = { ...FLOW_DEFAULTS, ...options };
  if (!previous) return { eligible: false, reason: 'baseline' };
  const elapsedMs = now - previous.observedAt;
  if (elapsedMs < 20_000 || elapsedMs > 10 * 60_000) return { eligible: false, reason: 'invalid_window' };
  const priorPrice = Number(previous.price);
  const price = Number(current.price);
  const turnover24h = Number(current.turnover24h);
  const freshTurnover = Number.isFinite(Number(current.intervalTurnoverUsd))
    ? Math.max(0, Number(current.intervalTurnoverUsd))
    : Math.max(0, turnover24h - Number(previous.turnover24h));
  if (!(priorPrice > 0 && price > 0)) return { eligible: false, reason: 'invalid_price' };
  const movePct = ((price / priorPrice) - 1) * 100;
  const direction = movePct > 0 ? 'BULLISH' : movePct < 0 ? 'BEARISH' : 'NEUTRAL';
  if (Math.abs(movePct) < rules.minimumMovePct) return { eligible: false, reason: 'insufficient_move', movePct, direction };
  if (Math.abs(movePct) > rules.maximumEarlyMovePct) return { eligible: false, reason: 'extended_move', movePct, direction };
  if (freshTurnover < rules.minimumFreshTurnoverUsd) return { eligible: false, reason: 'insufficient_fresh_turnover', movePct, freshTurnover };
  if (turnover24h < rules.minimumTurnover24hUsd || turnover24h > rules.maximumTurnover24hUsd) return { eligible: false, reason: 'outside_liquidity_band', movePct, freshTurnover };
  // Open-interest growth must measure contracts/coins, not USD notional. Using
  // price * OI lets the price move itself masquerade as new positioning.
  const priorOpenInterest = Number(previous.openInterest);
  const openInterest = Number(current.openInterest);
  const oiGrowthPct = priorOpenInterest > 0 ? ((openInterest / priorOpenInterest) - 1) * 100 : 0;
  const fundingRate = Number(current.fundingRate);
  const crowdedShorts = fundingRate <= rules.crowdedShortFundingRate;
  const crowdedLongs = fundingRate >= rules.crowdedLongFundingRate;
  const risingOi = oiGrowthPct >= rules.minimumOpenInterestGrowthPct;
  const crowdedPositioning = direction === 'BULLISH' ? crowdedShorts : crowdedLongs;
  const crowdedPositioningConfirmed = crowdedPositioning && oiGrowthPct >= rules.minimumCrowdedPositioningOiGrowthPct;
  if (!crowdedPositioningConfirmed && !risingOi) return { eligible: false, reason: 'no_derivatives_confirmation', direction, movePct, freshTurnover, oiGrowthPct, fundingRate };
  const reason = crowdedPositioningConfirmed ? (direction === 'BULLISH' ? 'crowded_shorts' : 'crowded_longs') : 'rising_open_interest';
  return { eligible: true, direction, reason, movePct, freshTurnover, oiGrowthPct, fundingRate, elapsedMinutes: elapsedMs / 60000 };
}

export function isFlowPriceCandidate(current, previous, now = Date.now(), options = {}) {
  const rules = { ...FLOW_DEFAULTS, ...options };
  if (!previous) return false;
  const elapsedMs = now - previous.observedAt;
  if (elapsedMs < 20_000 || elapsedMs > 10 * 60_000) return false;
  const priorPrice = Number(previous.price), price = Number(current.price), turnover24h = Number(current.turnover24h);
  if (!(priorPrice > 0 && price > 0)) return false;
  const movePct = Math.abs(((price / priorPrice) - 1) * 100);
  if (movePct < rules.minimumMovePct || movePct > rules.maximumEarlyMovePct) return false;
  const priorOpenInterest = Number(previous.openInterest);
  const oiGrowthPct = priorOpenInterest > 0 ? ((Number(current.openInterest) / priorOpenInterest) - 1) * 100 : 0;
  const direction = Number(current.price) >= priorPrice ? 'BULLISH' : 'BEARISH';
  const fundingRate = Number(current.fundingRate);
  const crowded = direction === 'BULLISH'
    ? fundingRate <= rules.crowdedShortFundingRate
    : fundingRate >= rules.crowdedLongFundingRate;
  const derivativesCandidate = oiGrowthPct >= rules.minimumOpenInterestGrowthPct
    || (crowded && oiGrowthPct >= rules.minimumCrowdedPositioningOiGrowthPct);
  return derivativesCandidate && turnover24h >= rules.minimumTurnover24hUsd && turnover24h <= rules.maximumTurnover24hUsd;
}
