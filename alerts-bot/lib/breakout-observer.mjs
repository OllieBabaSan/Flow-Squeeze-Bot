export const BREAKOUT_OBSERVER_DEFAULTS = {
  bucketMs: 5 * 60_000,
  channelBars: 20,
  atrBars: 14,
  minimumClearanceAtr: 0.2,
  retainedBars: 26,
};

const finite = value => Number.isFinite(Number(value));

export function updateBreakoutSeries(existing = {}, market, now = Date.now(), options = {}) {
  const rules = { ...BREAKOUT_OBSERVER_DEFAULTS, ...options };
  const price = Number(market.price);
  if (!(price > 0)) return existing;
  const bucketStart = Math.floor(now / rules.bucketMs) * rules.bucketMs;
  const bars = Array.isArray(existing.bars) ? [...existing.bars] : [];
  const latest = bars.at(-1);
  if (!latest || latest.start !== bucketStart) {
    bars.push({ start: bucketStart, open: price, high: price, low: price, close: price,
      openInterest: Number(market.openInterest), turnover24h: Number(market.turnover24h) });
  } else {
    latest.high = Math.max(Number(latest.high), price);
    latest.low = Math.min(Number(latest.low), price);
    latest.close = price;
    latest.openInterest = Number(market.openInterest);
    latest.turnover24h = Number(market.turnover24h);
  }
  return { bars: bars.slice(-rules.retainedBars), updatedAt: now };
}

export function averageTrueRange(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const sample = bars.slice(-(period + 1));
  const ranges = [];
  for (let index = 1; index < sample.length; index++) {
    const current = sample[index], previous = sample[index - 1];
    ranges.push(Math.max(
      Number(current.high) - Number(current.low),
      Math.abs(Number(current.high) - Number(previous.close)),
      Math.abs(Number(current.low) - Number(previous.close)),
    ));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

export function preliminaryBreakout(series, market, now = Date.now(), options = {}) {
  const rules = { ...BREAKOUT_OBSERVER_DEFAULTS, ...options };
  const bars = Array.isArray(series?.bars) ? series.bars : [];
  const currentBucket = Math.floor(now / rules.bucketMs) * rules.bucketMs;
  const closed = bars.filter(bar => Number(bar.start) < currentBucket);
  if (closed.length < Math.max(rules.channelBars, rules.atrBars + 1)) return { eligible: false, reason: 'WARMING_UP', closedBars: closed.length };
  const channel = closed.slice(-rules.channelBars);
  const atr = averageTrueRange(closed, rules.atrBars);
  if (!(atr > 0)) return { eligible: false, reason: 'NO_VOLATILITY_BASELINE' };
  const channelHigh = Math.max(...channel.map(bar => Number(bar.high)));
  const channelLow = Math.min(...channel.map(bar => Number(bar.low)));
  const price = Number(market.price);
  const band = atr * rules.minimumClearanceAtr;
  const bullish = price > channelHigh + band;
  const bearish = price < channelLow - band;
  if (!bullish && !bearish) return { eligible: false, reason: 'INSIDE_CHANNEL', channelHigh, channelLow, atr };
  const direction = bullish ? 'BULLISH' : 'BEARISH';
  const boundary = bullish ? channelHigh : channelLow;
  const clearanceAtr = Math.abs(price - boundary) / atr;
  const firstOi = Number(channel[0]?.openInterest);
  const currentOi = Number(market.openInterest);
  const oiChangePct = firstOi > 0 && currentOi > 0 ? (currentOi / firstOi - 1) * 100 : null;
  const derivativesContext = oiChangePct == null ? 'UNAVAILABLE'
    : oiChangePct >= 0.5 ? 'EXPANDING_OPEN_INTEREST'
      : oiChangePct <= -0.5 ? 'CONTRACTING_OPEN_INTEREST' : 'STABLE_OPEN_INTEREST';
  const close15m = closed.at(-3)?.close;
  const close60m = closed.at(-12)?.close;
  const directed = from => finite(from) && Number(from) > 0
    ? (price / Number(from) - 1) * 100 * (direction === 'BEARISH' ? -1 : 1) : null;
  return {
    eligible: true, reason: 'CHANNEL_BREAKOUT', direction, boundary, price,
    channelHigh, channelLow, channelBars: rules.channelBars,
    atr, atrPct: atr / price * 100, clearanceAtr,
    channelWidthAtr: (channelHigh - channelLow) / atr,
    oiChangePct, derivativesContext,
    directedReturn15mPct: directed(close15m), directedReturn60mPct: directed(close60m),
    fundingRate: finite(market.fundingRate) ? Number(market.fundingRate) : null,
    turnover24h: finite(market.turnover24h) ? Number(market.turnover24h) : null,
  };
}

export function relativeVolume(currentVolume, priorVolumes = []) {
  const valid = priorVolumes.map(Number).filter(value => value > 0);
  if (!(Number(currentVolume) >= 0) || !valid.length) return null;
  const baseline = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return baseline > 0 ? Number(currentVolume) / baseline : null;
}
