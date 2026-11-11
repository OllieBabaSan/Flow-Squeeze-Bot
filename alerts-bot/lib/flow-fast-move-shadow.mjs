import { directedMovePct } from './flow-confirmation.mjs';

export const FLOW_FAST_MOVE_SHADOW_VERSION = 'flow-fast-move-shadow-v1';

export const FLOW_FAST_MOVE_SHADOW_DEFAULTS = {
  minimumAgeSeconds: 20,
  maximumAgeSeconds: 59,
  minimumMovePct: 0.5,
  maximumSpreadBps: 15,
  minimumFreshTurnoverUsd: 500_000,
  minimumDetectionOiGrowthPct: 0.3,
  minimumLiveOiChangePct: 0,
  maximumRetracementFromPeakPct: 0.25,
};

export function updateFastMoveEvaluationTelemetry(previous = {}, evaluation, now = Date.now()) {
  const reason = String(evaluation?.reason || 'UNKNOWN');
  return {
    evaluations: Number(previous.evaluations || 0) + 1,
    firstEvaluatedAt: previous.firstEvaluatedAt || new Date(now).toISOString(),
    lastEvaluatedAt: new Date(now).toISOString(),
    lastAction: evaluation?.action || 'UNKNOWN',
    lastReason: reason,
    lastMetrics: evaluation?.metrics || null,
    reasonCounts: {
      ...(previous.reasonCounts || {}),
      [reason]: Number(previous.reasonCounts?.[reason] || 0) + 1,
    },
  };
}

const finite = value => value !== null && value !== '' && Number.isFinite(Number(value));

export function evaluateFastMoveShadow(candidate, market, regime = {}, now = Date.now(), options = {}) {
  const rules = { ...FLOW_FAST_MOVE_SHADOW_DEFAULTS, ...options };
  const ageSeconds = (now - Number(candidate.detectedAt)) / 1000;
  const movePct = directedMovePct(candidate.referencePrice, market?.price, candidate.direction);
  const peakDirectedMovePct = Math.max(Number(candidate.peakDirectedMovePct) || 0, movePct);
  const retracementFromPeakPct = Math.max(0, peakDirectedMovePct - movePct);
  const bid = Number(market?.bestBid), ask = Number(market?.bestAsk), price = Number(market?.price);
  const spreadBps = bid > 0 && ask > 0 && price > 0 ? ((ask - bid) / price) * 10_000 : null;
  const detectionOiGrowthPct = finite(candidate.detection?.oiGrowthPct) ? Number(candidate.detection.oiGrowthPct) : null;
  const freshTurnoverUsd = finite(candidate.detection?.freshTurnover) ? Number(candidate.detection.freshTurnover) : null;
  const referenceOi = Number(candidate.referenceOpenInterest);
  const liveOiChangePct = referenceOi > 0 && finite(market?.openInterest)
    ? (Number(market.openInterest) / referenceOi - 1) * 100 : null;
  const regimeAligned = regime.state === 'NEUTRAL'
    || (regime.state === 'BULLISH' && candidate.direction === 'BULLISH')
    || (['BEARISH', 'SEVERE_RISK_OFF'].includes(regime.state) && candidate.direction === 'BEARISH');
  const metrics = {
    ageSeconds, movePct, peakDirectedMovePct, retracementFromPeakPct, spreadBps,
    freshTurnoverUsd, detectionOiGrowthPct, liveOiChangePct,
    regime: regime.state || 'UNKNOWN', regimeAligned,
    venueDivergence: market?.venueDivergence || null,
  };
  if (ageSeconds < rules.minimumAgeSeconds) return { action: 'WAIT', reason: 'FAST_MOVE_TOO_EARLY', metrics };
  if (ageSeconds > rules.maximumAgeSeconds) return { action: 'CLOSED', reason: 'FAST_MOVE_WINDOW_CLOSED', metrics };
  if (spreadBps == null) return { action: 'WAIT', reason: 'FAST_MOVE_SPREAD_UNAVAILABLE', metrics };
  if (spreadBps > rules.maximumSpreadBps) return { action: 'WAIT', reason: 'FAST_MOVE_SPREAD_TOO_WIDE', metrics };
  if (market?.venueDivergence?.researchExcluded) return { action: 'WAIT', reason: 'FAST_MOVE_VENUE_PRICE_DIVERGENCE', metrics };
  if (!regimeAligned) return { action: 'WAIT', reason: 'FAST_MOVE_REGIME_OPPOSED', metrics };
  if (freshTurnoverUsd == null || freshTurnoverUsd < rules.minimumFreshTurnoverUsd) return { action: 'WAIT', reason: 'FAST_MOVE_TURNOVER_WEAK', metrics };
  if (detectionOiGrowthPct == null || detectionOiGrowthPct < rules.minimumDetectionOiGrowthPct) return { action: 'WAIT', reason: 'FAST_MOVE_DETECTION_OI_WEAK', metrics };
  if (liveOiChangePct == null || liveOiChangePct < rules.minimumLiveOiChangePct) return { action: 'WAIT', reason: 'FAST_MOVE_LIVE_OI_NOT_EXPANDING', metrics };
  if (movePct < rules.minimumMovePct) return { action: 'WAIT', reason: 'FAST_MOVE_PRICE_NOT_ACCELERATING', metrics };
  if (retracementFromPeakPct > rules.maximumRetracementFromPeakPct) return { action: 'WAIT', reason: 'FAST_MOVE_MOMENTUM_FADING', metrics };
  return { action: 'QUALIFY_SHADOW', reason: 'FAST_MOVE_MULTI_FACTOR_CONFIRMED', metrics };
}
