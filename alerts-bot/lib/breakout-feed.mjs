const clamp = (value, minimum = 0, maximum = 100) => Math.min(maximum, Math.max(minimum, Number(value) || 0));
const finite = value => Number.isFinite(Number(value));
const majorSymbols = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK']);
const destinationKeys = [['bybit', 'Bybit'], ['hyperliquid', 'Hyperliquid'], ['binance', 'Binance']];

function destinationSnapshot(catalogs, venueKey, venueLabel, symbol) {
  const market = catalogs?.[venueKey]?.get?.(symbol);
  if (!market) return null;
  const price = finite(market.price) ? Number(market.price) : null;
  const bid = finite(market.bestBid) ? Number(market.bestBid) : null;
  const ask = finite(market.bestAsk) ? Number(market.bestAsk) : null;
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  return {
    venue: venueLabel,
    symbol: market.venueSymbol || market.symbol,
    price,
    turnover24h: finite(market.turnover24h) ? Number(market.turnover24h) : null,
    spreadBps: midpoint > 0 && ask >= bid ? ((ask - bid) / midpoint) * 10_000 : null,
  };
}

function selectForFeed(candidates, limit) {
  const selected = candidates.slice(0, limit);
  const ids = new Set(selected.map(candidate => candidate.id));
  for (const candidate of candidates) if (majorSymbols.has(candidate.symbol) && !ids.has(candidate.id)) selected.push(candidate);
  return selected;
}

function rankCandidate({ key, market, breakout, series, firstSeenAt, activity, qualityGate }, now, destinationCatalogs) {
  const turnover = finite(market.turnover24h) ? Number(market.turnover24h) : null;
  const relativeActivity = finite(activity?.relativeActivity) ? Number(activity.relativeActivity) : null;
  const directed15m = finite(breakout.directedReturn15mPct) ? Number(breakout.directedReturn15mPct) : null;
  const directed60m = finite(breakout.directedReturn60mPct) ? Number(breakout.directedReturn60mPct) : null;
  const change24hPct = finite(market.change24hPct) ? Number(market.change24hPct) : null;
  const broadDirectedChange = change24hPct == null ? null : change24hPct * (breakout.direction === 'BEARISH' ? -1 : 1);
  const intermediateTrend = directed60m == null ? 'UNKNOWN' : directed60m >= 0.1 ? 'ALIGNED' : directed60m <= -0.1 ? 'OPPOSED' : 'NEUTRAL';
  const broadTrend = broadDirectedChange == null ? 'UNKNOWN' : broadDirectedChange >= 0.25 ? 'ALIGNED' : broadDirectedChange <= -0.25 ? 'OPPOSED' : 'NEUTRAL';
  const reversalEvidence = broadTrend === 'OPPOSED' && intermediateTrend === 'ALIGNED'
    && Number(breakout.clearanceAtr) >= 1 && Number(directed15m) >= 0.2
    && breakout.derivativesContext !== 'UNAVAILABLE';
  const trendAlignment = broadTrend === 'OPPOSED' && intermediateTrend === 'OPPOSED' ? 'COUNTERTREND'
    : reversalEvidence ? 'REVERSAL_WATCH'
      : (broadTrend === 'ALIGNED' && intermediateTrend !== 'OPPOSED') || (intermediateTrend === 'ALIGNED' && broadTrend !== 'OPPOSED') ? 'ALIGNED'
        : 'MIXED';
  const clearance = clamp(breakout.clearanceAtr, 0, 5);
  const continuation = clamp(directed15m, -1, 4);
  const activityLift = relativeActivity == null ? 0 : clamp(relativeActivity - 1, 0, 4);
  const heat = Math.round(clamp(35 + clearance * 9 + continuation * 10 + activityLift * 4));

  let quality = 42;
  if (turnover != null) quality += turnover >= 10_000_000 ? 15 : turnover >= 1_000_000 ? 10 : turnover >= 100_000 ? 5 : -15;
  if (breakout.derivativesContext !== 'UNAVAILABLE') quality += 8;
  if (breakout.derivativesContext === 'EXPANDING_OPEN_INTEREST') quality += 5;
  if (finite(breakout.channelWidthAtr) && Number(breakout.channelWidthAtr) >= 3) quality += 5;
  if (directed15m != null && directed15m > 0) quality += 8;
  if (directed60m != null && directed60m > 0) quality += 7;
  if (relativeActivity != null) quality += relativeActivity >= 1.5 ? 8 : relativeActivity < 0.8 ? -5 : 0;
  if (trendAlignment === 'ALIGNED') quality += 10;
  else if (trendAlignment === 'COUNTERTREND') quality -= 25;
  else if (trendAlignment === 'REVERSAL_WATCH') quality -= 8;
  else quality -= 5;
  quality = Math.round(clamp(qualityGate?.score ?? quality));

  const atrMove = Math.max(Number(breakout.atrPct) || 0, 0.01);
  const trend = directed15m != null && directed15m < 0 ? 'fading'
    : directed15m != null && directed15m >= Math.max(0.15, atrMove * 2) ? 'rising' : 'steady';
  const bars = Array.isArray(series?.bars) ? series.bars.slice(-16) : [];
  const path = bars.map(bar => Number(bar.close)).filter(value => value > 0);
  const observedAt = Number(firstSeenAt) > 0 ? Number(firstSeenAt) : now;
  const destinations = Object.fromEntries(destinationKeys.flatMap(([venueKey, venueLabel]) => {
    const snapshot = destinationSnapshot(destinationCatalogs, venueKey, venueLabel, market.symbol);
    return snapshot ? [[venueKey, snapshot]] : [];
  }));

  return {
    id: key,
    symbol: market.symbol,
    venue: market.venue,
    tradableVenues: Object.values(destinations).map(destination => destination.venue),
    destinations,
    direction: breakout.direction,
    price: Number(market.price),
    heat,
    quality,
    qualityGateStatus: qualityGate?.status || null,
    qualityGateFlags: qualityGate?.flags || [],
    qualityGateVersion: qualityGate?.version || null,
    movePct: directed15m,
    move60mPct: directed60m,
    change24hPct,
    intermediateTrend,
    broadTrend,
    trendAlignment,
    ageSeconds: Math.max(0, Math.round((now - observedAt) / 1000)),
    relativeActivity,
    openInterestContext: breakout.derivativesContext,
    openInterestChangePct: finite(breakout.oiChangePct) ? Number(breakout.oiChangePct) : null,
    clearanceAtr: Number(breakout.clearanceAtr),
    boundary: Number(breakout.boundary),
    trend,
    turnover24h: turnover,
    path,
  };
}

export function buildBreakoutFeed({ active = [], destinationCatalogs = {}, regime = {}, marketCount = 0, coverage = null, now = Date.now(), scanIntervalSeconds = 30, limitPerSide = 20 } = {}) {
  const candidates = active.map(candidate => rankCandidate(candidate, now, destinationCatalogs));
  const rank = (a, b) => (b.heat + b.quality * 0.45) - (a.heat + a.quality * 0.45);
  const bullishCandidates = candidates.filter(candidate => candidate.direction === 'BULLISH').sort(rank);
  const bearishCandidates = candidates.filter(candidate => candidate.direction === 'BEARISH').sort(rank);
  const bullish = selectForFeed(bullishCandidates, limitPerSide);
  const bearish = selectForFeed(bearishCandidates, limitPerSide);
  return {
    schemaVersion: 1,
    detectorVersion: 'breakout-observer-v1-live-feed-v4-quality-shadow-v2',
    supportedDestinations: ['Bybit', 'Hyperliquid', 'Binance'],
    generatedAt: new Date(now).toISOString(),
    scanIntervalSeconds,
    marketCount,
    coverage,
    activeCount: candidates.length,
    bullishActiveCount: bullishCandidates.length,
    bearishActiveCount: bearishCandidates.length,
    regime: {
      state: regime.state || 'UNKNOWN',
      reliable: Boolean(regime.reliable),
      benchmarkChangePct: finite(regime.benchmarkChangePct) ? Number(regime.benchmarkChangePct) : null,
      negativeBreadthRatio: finite(regime.negativeBreadthRatio) ? Number(regime.negativeBreadthRatio) : null,
      positiveBreadthRatio: finite(regime.positiveBreadthRatio) ? Number(regime.positiveBreadthRatio) : null,
    },
    bullish,
    bearish,
  };
}
