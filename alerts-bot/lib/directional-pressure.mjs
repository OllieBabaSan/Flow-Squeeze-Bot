export const PRESSURE_DEFAULTS = {
  minimumHistory: 20,
  baselineWindow: 120,
  watchScore: 55,
  pressureScore: 60,
  earlyExpansionScore: 60,
  strongExpansionScore: 75,
  extendedZ: 6,
  minimumTurnover24hUsd: 5_000_000,
  breakoutWindowMinutes: 20,
  breakoutMemoryMinutes: 10,
  trendEmaMinutes: 50,
  atrMinutes: 14,
  confirmedPressureScore: 60,
  confirmedExpansionScore: 60,
};

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const median = values => {
  const sorted = values.filter(finite).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const pct = (from, to) => Number(from) > 0 ? (Number(to) / Number(from) - 1) * 100 : 0;
const points = (value, start, strong, maximum) => maximum * clamp((value - start) / Math.max(0.000001, strong - start));
const average = values => values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;

function minuteBars(rows) {
  const bars = new Map();
  for (const row of rows) {
    const observedAt = Number(row.observedAt || 0);
    const price = Number(row.price);
    if (!observedAt || !Number.isFinite(price) || price <= 0) continue;
    const bucket = Math.floor(observedAt / 60_000) * 60_000;
    const existing = bars.get(bucket);
    if (!existing) {
      bars.set(bucket, { observedAt: bucket, open: price, high: finite(row.high) ? Number(row.high) : price, low: finite(row.low) ? Number(row.low) : price, close: price, volume: Number(row.intervalTurnoverUsd || 0) });
      continue;
    }
    existing.high = Math.max(existing.high, finite(row.high) ? Number(row.high) : price, price);
    existing.low = Math.min(existing.low, finite(row.low) ? Number(row.low) : price, price);
    existing.close = price;
    existing.volume += Number(row.intervalTurnoverUsd || 0);
  }
  return [...bars.values()].sort((a, b) => a.observedAt - b.observedAt);
}

function ema(values, period) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce((value, current) => Number(current) * alpha + value * (1 - alpha), Number(values[0]));
}

function atr(bars, period) {
  if (bars.length < 2) return 0;
  const ranges = bars.slice(1).map((bar, index) => Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - bars[index].close),
    Math.abs(bar.low - bars[index].close),
  ));
  return average(ranges.slice(-period));
}

export function pressureObservation(market, previous, observedAt = Date.now()) {
  const turnoverDelta = previous ? Number(market.turnover24h) - Number(previous.turnover24h) : 0;
  return {
    observedAt,
    price: Number(market.price),
    high: finite(market.high) ? Number(market.high) : Number(market.price),
    low: finite(market.low) ? Number(market.low) : Number(market.price),
    openInterest: Number(market.openInterest),
    intervalTurnoverUsd: finite(market.intervalTurnoverUsd) ? Math.max(0, Number(market.intervalTurnoverUsd)) : Math.max(0, turnoverDelta),
    tradeCount: finite(market.tradeCount) ? Number(market.tradeCount) : null,
    aggressiveBuyRatio: finite(market.aggressiveBuyRatio) ? Number(market.aggressiveBuyRatio) : null,
    bookImbalance: finite(market.bookImbalance) ? Number(market.bookImbalance) : null,
  };
}

export function evaluateDirectionalPressure(history, current, market = {}, options = {}) {
  const rules = { ...PRESSURE_DEFAULTS, ...options };
  const prior = history.slice(-rules.baselineWindow);
  if (prior.length < rules.minimumHistory) return { eligible: false, state: 'BASELINE', reason: 'insufficient_history' };
  if (Number(market.turnover24h || 0) < rules.minimumTurnover24hUsd) return { eligible: false, state: 'INELIGIBLE', reason: 'insufficient_liquidity' };

  const series = [...prior, current];
  const bars = minuteBars(series);
  const currentAt = Number(current.observedAt || 0);
  const atMinutesAgo = minutes => {
    if (currentAt > 0) {
      const target = currentAt - minutes * 60_000;
      for (let index = series.length - 1; index >= 0; index -= 1) if (Number(series[index].observedAt) <= target) return series[index];
    }
    return series.at(-(minutes + 1));
  };
  const rowsWithin = minutes => currentAt > 0 ? series.filter(row => Number(row.observedAt) > currentAt - minutes * 60_000) : series.slice(-minutes);
  const windowReturn = minutes => pct(atMinutesAgo(minutes)?.price, current.price);
  const oneMinuteReturn = windowReturn(1), threeMinuteReturn = windowReturn(3), fiveMinuteReturn = windowReturn(5);
  const tenMinuteReturn = windowReturn(10), fifteenMinuteReturn = windowReturn(15);
  const thirtyMinuteReturn = windowReturn(30), sixtyMinuteReturn = windowReturn(60);
  const baselineReturns = bars.slice(1).map((bar, index) => Math.abs(pct(bars[index].close, bar.close))).filter(value => value > 0);
  const normalMove = Math.max(median(baselineReturns), 0.01);
  const priceZ = Math.abs(threeMinuteReturn) / (normalMove * Math.sqrt(3));
  const directionalImpulse = threeMinuteReturn + fiveMinuteReturn * 0.75 + tenMinuteReturn * 0.5;
  const flowVote = finite(current.aggressiveBuyRatio) ? (Number(current.aggressiveBuyRatio) - 0.5) * normalMove * 8 : 0;
  const direction = directionalImpulse + flowVote >= 0 ? 'BULLISH' : 'BEARISH';

  const baselineVolume = median(prior.map(row => row.intervalTurnoverUsd).filter(value => value > 0));
  const volumeRatio1m = baselineVolume > 0 ? Number(current.intervalTurnoverUsd) / baselineVolume : 0;
  const averageVolumeRatio = minutes => {
    const rows = rowsWithin(minutes);
    return baselineVolume > 0 && rows.length ? rows.reduce((sum, row) => sum + Number(row.intervalTurnoverUsd || 0), 0) / (baselineVolume * rows.length) : 0;
  };
  const volumeRatio3m = averageVolumeRatio(3);
  const volumeRatio5m = averageVolumeRatio(5);
  const volumeRatio10m = averageVolumeRatio(10);
  const volumeRatio = Math.max(volumeRatio1m, volumeRatio3m);

  const breakoutWindow = Math.max(10, Number(rules.breakoutWindowMinutes));
  const breakoutMemory = Math.max(1, Number(rules.breakoutMemoryMinutes));
  const atrValue = atr(bars, Number(rules.atrMinutes));
  const breakoutCandidates = [];
  for (let index = Math.max(breakoutWindow, bars.length - breakoutMemory); index < bars.length; index += 1) {
    const comparison = bars.slice(index - breakoutWindow, index);
    if (comparison.length < breakoutWindow) continue;
    const rangeHigh = Math.max(...comparison.map(bar => bar.high));
    const rangeLow = Math.min(...comparison.map(bar => bar.low));
    const close = bars[index].close;
    const signedDistance = close > rangeHigh ? close - rangeHigh : close < rangeLow ? close - rangeLow : 0;
    breakoutCandidates.push({ signedDistance, rangeHigh, rangeLow, observedAt: bars[index].observedAt });
  }
  const recentBreakout = breakoutCandidates.reverse().find(candidate => candidate.signedDistance !== 0) || { signedDistance: 0, rangeHigh: null, rangeLow: null, observedAt: null };
  const breakoutAtr = atrValue > 0 ? recentBreakout.signedDistance / atrValue : 0;

  const closes = bars.map(bar => bar.close);
  const trendPeriod = Math.max(10, Number(rules.trendEmaMinutes));
  const emaNow = closes.length >= trendPeriod ? ema(closes, trendPeriod) : null;
  const emaPast = closes.length >= trendPeriod + 5 ? ema(closes.slice(0, -5), trendPeriod) : null;
  const emaSlopePct = emaNow && emaPast ? (emaNow / emaPast - 1) * 100 : 0;
  const recentBarVolumes = bars.slice(-3).map(bar => bar.volume);
  const priorBarVolumes = bars.slice(-13, -3).map(bar => bar.volume).filter(value => value > 0);
  const volumeAcceleration = priorBarVolumes.length && recentBarVolumes.length ? average(recentBarVolumes) / Math.max(1, average(priorBarVolumes)) : 0;
  const barVolumeBaseline = median(bars.slice(-21, -1).map(bar => bar.volume).filter(value => value > 0));
  const barVolumeRatio = barVolumeBaseline > 0 && bars.length ? bars.at(-1).volume / barVolumeBaseline : 0;

  const baselineTrades = median(prior.map(row => row.tradeCount).filter(value => Number(value) > 0));
  const tradeRatio = baselineTrades > 0 && Number(current.tradeCount) >= 0 ? Number(current.tradeCount) / baselineTrades : null;
  const oiThreeMinutePct = pct(atMinutesAgo(3)?.openInterest, current.openInterest);
  const flowStrength = finite(current.aggressiveBuyRatio) ? Math.abs(Number(current.aggressiveBuyRatio) - 0.5) * 2 : null;
  const bookStrength = finite(current.bookImbalance) ? Math.abs(Number(current.bookImbalance)) : null;
  const breakoutDirection = breakoutAtr > 0 ? 'BULLISH' : breakoutAtr < 0 ? 'BEARISH' : null;
  const trendDirection = emaNow == null ? null : current.price >= emaNow && emaSlopePct > 0 ? 'BULLISH' : current.price <= emaNow && emaSlopePct < 0 ? 'BEARISH' : null;
  const structuralDirection = breakoutDirection || trendDirection;
  const resolvedDirection = structuralDirection || direction;
  const resolvedSign = resolvedDirection === 'BULLISH' ? 1 : -1;
  const resolvedAlignedOneMinute = oneMinuteReturn * resolvedSign;
  const flowAligned = flowStrength == null || (resolvedDirection === 'BULLISH' ? current.aggressiveBuyRatio >= 0.5 : current.aggressiveBuyRatio < 0.5);
  const bookAligned = bookStrength == null || (resolvedDirection === 'BULLISH' ? current.bookImbalance > 0 : current.bookImbalance < 0);
  const breakoutAligned = breakoutDirection === resolvedDirection;
  const trendAligned = trendDirection === resolvedDirection;
  const pressureParts = {
    volume: points(volumeRatio, 1.5, 5, 35),
    openInterest: points(Math.abs(oiThreeMinutePct), 0.25, 3, 25),
    price: points(Math.max(0, resolvedAlignedOneMinute / normalMove), 0.5, 3, 10),
    trades: tradeRatio == null ? null : points(tradeRatio, 1.5, 4, 10),
    flow: flowStrength == null ? null : (flowAligned ? points(flowStrength, 0.1, 0.5, 10) : 0),
    book: bookStrength == null ? null : (bookAligned ? points(bookStrength, 0.05, 0.4, 10) : 0),
  };
  const expansionParts = {
    breakout: breakoutAligned ? points(Math.abs(breakoutAtr), 0.1, 1.25, 25) : 0,
    trend: trendAligned ? points(Math.abs(emaSlopePct), 0.02, 0.35, 10) : 0,
    price: points(priceZ, 1.5, 5, 20),
    volume: points(Math.max(volumeRatio, barVolumeRatio), 1.5, 5, 15),
    volumeAcceleration: points(volumeAcceleration, 1.1, 3, 10),
    openInterest: points(Math.abs(oiThreeMinutePct), 0.25, 3, 10),
    trades: tradeRatio == null ? null : points(tradeRatio, 1.5, 4, 5),
    flow: flowStrength == null ? null : (flowAligned ? points(flowStrength, 0.1, 0.5, 3) : 0),
    book: bookStrength == null ? null : (bookAligned ? points(bookStrength, 0.05, 0.4, 2) : 0),
  };
  // Missing evidence earns no points. Rescaling an incomplete feed to 100 made
  // price+volume-only history look as strong as a fully confirmed live signal.
  const score = parts => Math.round(Object.values(parts).filter(value => value != null).reduce((sum, value) => sum + value, 0));
  const pressureScore = score(pressureParts), expansionScore = score(expansionParts);
  const confirmations = [volumeRatio >= 1.5, Math.abs(oiThreeMinutePct) >= 0.25, tradeRatio >= 1.5, flowStrength >= 0.1 && flowAligned, bookStrength >= 0.05 && bookAligned].filter(Boolean).length;
  const extended = Math.abs(fifteenMinuteReturn) / (normalMove * Math.sqrt(15)) >= rules.extendedZ;
  const persistenceRows = rowsWithin(10);
  const aligned30m = thirtyMinuteReturn * resolvedSign, aligned60m = sixtyMinuteReturn * resolvedSign;
  const priorFiveMinuteAligned = pct(atMinutesAgo(10)?.price, atMinutesAgo(5)?.price) * resolvedSign;
  const structuralSign = resolvedSign;
  const structurallyAligned10m = tenMinuteReturn * structuralSign;
  const structurallyAligned15m = fifteenMinuteReturn * structuralSign;
  const structurallyAlignedPrior5m = pct(atMinutesAgo(10)?.price, atMinutesAgo(5)?.price) * structuralSign;
  const structuralPersistence = persistenceRows.slice(1).map((row, index) => pct(persistenceRows[index].price, row.price) * structuralSign);
  const structuralPersistence10m = structuralPersistence.length ? structuralPersistence.filter(value => value > 0).length / structuralPersistence.length : 0;
  const confirmationMove = structurallyAligned10m / (normalMove * Math.sqrt(10));
  const sustainedDirection = structurallyAligned10m > 0 && structurallyAligned15m > 0 && structurallyAlignedPrior5m > normalMove * 0.5 && structuralPersistence10m >= 0.8;
  const participationSustained = volumeRatio10m >= 1.25 || Math.abs(oiThreeMinutePct) >= 0.5 || (flowStrength >= 0.15 && flowAligned);
  let state = 'NONE';
  if (pressureScore >= rules.watchScore || expansionScore >= rules.watchScore) state = 'EARLY_PRESSURE';
  if (pressureScore >= rules.pressureScore && confirmations >= 2 && fiveMinuteReturn * structuralSign > 0) state = 'DEVELOPING';
  if (sustainedDirection && participationSustained && confirmationMove >= 1.25 && confirmations >= 2
    && pressureScore >= rules.confirmedPressureScore && expansionScore >= rules.confirmedExpansionScore
    && breakoutAligned && trendAligned) state = 'CONFIRMED_MOMENTUM';
  if (state === 'CONFIRMED_MOMENTUM' && aligned30m > 0 && (aligned60m > 0 || bars.length < 61)) state = 'SUSTAINED';
  const trendFailed = emaNow != null && (resolvedDirection === 'BULLISH' ? current.price < emaNow && emaSlopePct <= 0 : current.price > emaNow && emaSlopePct >= 0);
  const participationCollapse = volumeRatio5m < 0.6 && oneMinuteReturn * resolvedSign <= 0;
  const weakening = fiveMinuteReturn * resolvedSign <= 0 || trendFailed || participationCollapse;
  const momentumLost = (structurallyAligned15m <= 0 && structuralPersistence10m < 0.4) || trendFailed;

  const oiAligned = oiThreeMinutePct > 0;
  const character = resolvedDirection === 'BULLISH'
    ? (oiAligned ? 'NEW_LONG_EXPANSION' : 'SHORT_COVER_SQUEEZE')
    : (oiAligned ? 'NEW_SHORT_EXPANSION' : 'LONG_LIQUIDATION');
  return {
    eligible: state !== 'NONE', state, direction: resolvedDirection, character, pressureScore, expansionScore, confirmations, extended, weakening, momentumLost,
    metrics: { oneMinuteReturn, threeMinuteReturn, fiveMinuteReturn, tenMinuteReturn, fifteenMinuteReturn, thirtyMinuteReturn, sixtyMinuteReturn, priorFiveMinuteAligned, normalMove, priceZ, confirmationMove, persistence10m: structuralPersistence10m, volumeRatio1m, volumeRatio3m, volumeRatio5m, volumeRatio10m, volumeRatio, barVolumeRatio, volumeAcceleration, tradeRatio, oiThreeMinutePct, aggressiveBuyRatio: current.aggressiveBuyRatio, bookImbalance: current.bookImbalance, breakoutAtr, breakoutRangeHigh: recentBreakout.rangeHigh, breakoutRangeLow: recentBreakout.rangeLow, breakoutObservedAt: recentBreakout.observedAt, atr: atrValue, ema: emaNow, emaSlopePct, breakoutAligned, trendAligned },
    components: { pressure: pressureParts, expansion: expansionParts },
  };
}

export function shouldRecordPressure(previousSignal, detection) {
  if (!detection.eligible) return false;
  if (!previousSignal) return true;
  const ranks = { EARLY_PRESSURE: 1, DEVELOPING: 2, CONFIRMED_MOMENTUM: 3, SUSTAINED: 4 };
  return (ranks[detection.state] || 0) > (ranks[previousSignal.state] || 0);
}

export function advancePressureLifecycle(previous, detection, now = Date.now()) {
  const base = previous || { state: 'INACTIVE', weakCount: 0, inactiveCount: 0, direction: detection.direction };
  const confirmedStates = new Set(['CONFIRMED_MOMENTUM', 'SUSTAINED', 'RESUMED_MOMENTUM', 'MOMENTUM_STABILIZED', 'RESUMED']);
  let next = { ...base, direction: base.direction || detection.direction, updatedAt: now, event: false };
  const confirmedNow = detection.eligible && ['CONFIRMED_MOMENTUM', 'SUSTAINED'].includes(detection.state);
  if (base.state === 'MOMENTUM_LOSS') {
    if (confirmedNow && detection.direction === base.direction) return { ...next, state: 'RESUMED_MOMENTUM', event: true, at: now, weakCount: 0, postLossCount: 0 };
    if (confirmedNow && detection.direction !== base.direction) return { ...next, state: detection.state, direction: detection.direction, event: true, at: now, weakCount: 0, postLossCount: 0 };
    const postLossCount = Number(base.postLossCount || 0) + 1;
    const lossAt = Number(base.lossAt || base.at || now);
    if (now - lossAt >= 10 * 60_000) return { ...next, state: 'MOMENTUM_ENDED', event: true, at: now, postLossCount, lossAt };
    return { ...next, postLossCount };
  }
  if (!detection.eligible) {
    next.inactiveCount = Number(base.inactiveCount || 0) + 1;
    if (confirmedStates.has(base.state)) {
      const directionChanged = detection.direction && detection.direction !== base.direction;
      if (directionChanged || detection.weakening || detection.momentumLost) return { ...next, state: 'MOMENTUM_WEAKENING', event: true, at: now, weakCount: 1, weakSince: now };
      return next;
    }
    if (['MOMENTUM_WEAKENING', 'SLOWING'].includes(base.state)) {
      const directionChanged = detection.direction && detection.direction !== base.direction;
      if (!directionChanged && !detection.weakening && !detection.momentumLost) return { ...next, state: 'MOMENTUM_STABILIZED', event: true, at: now, weakCount: 0, weakSince: null };
      next.weakCount = Number(base.weakCount || 0) + 1;
      const weakSince = Number(base.weakSince || base.at || now);
      const hardLoss = Boolean(detection.momentumLost);
      if ((hardLoss && now - weakSince >= 3 * 60_000) || now - weakSince >= 10 * 60_000) next = { ...next, state: 'MOMENTUM_LOSS', event: true, at: now, lossAt: now, weakSince };
    } else if (next.inactiveCount >= 5 && !['INACTIVE', 'FAILED', 'MOMENTUM_LOSS', 'MOMENTUM_ENDED'].includes(base.state)) {
      next = { ...next, state: 'FAILED', event: true, at: now };
    }
    return next;
  }
  next.inactiveCount = 0;
  if (['MOMENTUM_WEAKENING', 'SLOWING'].includes(base.state)) {
    const directionChanged = detection.direction !== base.direction;
    const hardLoss = directionChanged || detection.momentumLost;
    if (confirmedNow && !detection.weakening && !hardLoss && detection.direction === base.direction) {
      return { ...next, state: 'MOMENTUM_STABILIZED', event: true, at: now, weakCount: 0 };
    }
    const weakCount = Number(base.weakCount || 1) + 1;
    const weakSince = Number(base.weakSince || base.at || now);
    if ((hardLoss && now - weakSince >= 3 * 60_000) || now - weakSince >= 10 * 60_000) return { ...next, state: 'MOMENTUM_LOSS', event: true, at: now, weakCount, weakSince, lossAt: now };
    return { ...next, state: 'MOMENTUM_WEAKENING', weakCount, weakSince };
  }
  if (confirmedStates.has(base.state)) {
    const directionChanged = detection.direction !== base.direction;
    const weak = directionChanged || detection.weakening || detection.momentumLost;
    if (weak) return { ...next, state: 'MOMENTUM_WEAKENING', event: true, at: now, weakCount: 1, weakSince: now };
    const weakCount = Number(base.weakCount || 0);
    if (detection.state === 'SUSTAINED' && base.state !== 'SUSTAINED') return { ...next, state: 'SUSTAINED', event: true, at: now, weakCount };
    return { ...next, weakCount };
  }
  if (shouldRecordPressure(base.state === 'INACTIVE' || base.state === 'FAILED' ? null : base, detection)) {
    // A detector may first qualify after the move is already sustained.  The
    // public lifecycle must still emit the initial confirmation rather than
    // silently jumping to the internal-only SUSTAINED state.
    const state = detection.state === 'SUSTAINED' ? 'CONFIRMED_MOMENTUM' : detection.state;
    return { ...next, state, direction: detection.direction, event: true, at: now, weakCount: 0 };
  }
  return next;
}

const PUBLIC_STATES = new Set(['CONFIRMED_MOMENTUM', 'MOMENTUM_WEAKENING', 'MOMENTUM_STABILIZED', 'MOMENTUM_LOSS', 'RESUMED_MOMENTUM', 'MOMENTUM_ENDED']);

function sourceScore(candidate, preferredVenue = '') {
  const market = candidate.current || {};
  const detection = candidate.detection || {};
  const evidence = [market.openInterest, market.intervalTurnoverUsd, market.aggressiveBuyRatio, market.bookImbalance].filter(value => value != null && Number.isFinite(Number(value))).length;
  const liquidity = Math.min(20, Math.log10(Math.max(1, Number(market.turnover24h || 0))));
  return (market.venue === 'Hyperliquid' ? 30 : market.venue === 'Kraken' ? 20 : 0)
    + (market.venue === preferredVenue ? 35 : 0)
    + evidence * 4 + liquidity
    + Number(detection.pressureScore || 0) / 10 + Number(detection.expansionScore || 0) / 10;
}

export function selectPressureEvents(candidates, { preferredVenueBySymbol = {}, terminalDigestThreshold = 5 } = {}) {
  const groups = new Map();
  for (const candidate of candidates) {
    const symbol = String(candidate.current?.symbol || '').toUpperCase();
    if (!groups.has(symbol)) groups.set(symbol, []);
    groups.get(symbol).push(candidate);
  }
  const selected = [];
  for (const [symbol, group] of groups) {
    const directions = new Set(group.map(item => item.lifecycle.direction).filter(Boolean));
    const ranked = [...group].sort((a, b) => sourceScore(b, preferredVenueBySymbol[symbol]) - sourceScore(a, preferredVenueBySymbol[symbol]));
    const winner = ranked[0];
    const conflict = directions.size > 1;
    for (const candidate of group) selected.push({
      ...candidate,
      sourceSelection: {
        selected: candidate === winner,
        primaryVenue: winner.current.venue,
        confirmingVenues: group.filter(item => item !== winner && item.lifecycle.direction === winner.lifecycle.direction).map(item => item.current.venue),
        conflictingVenues: group.filter(item => item.lifecycle.direction !== winner.lifecycle.direction).map(item => item.current.venue),
        publishEligible: candidate === winner && !conflict && PUBLIC_STATES.has(candidate.lifecycle.state),
        reason: conflict ? 'cross_venue_direction_conflict' : candidate === winner ? 'dominant_source' : 'cross_venue_secondary',
      },
    });
  }
  const terminalWinners = selected.filter(item => item.sourceSelection.publishEligible && item.lifecycle.state === 'MOMENTUM_ENDED');
  if (terminalWinners.length >= terminalDigestThreshold) {
    const digestId = `momentum-ended:${terminalWinners[0].lifecycle.at || Date.now()}`;
    for (const item of terminalWinners) item.sourceSelection = { ...item.sourceSelection, deliveryMode: 'terminal_digest', digestId };
  } else {
    for (const item of selected) if (item.sourceSelection.publishEligible) item.sourceSelection = { ...item.sourceSelection, deliveryMode: 'immediate' };
  }
  return selected;
}

export { median };
