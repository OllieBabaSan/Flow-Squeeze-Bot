export const FLOW_CONFIRMATION_DEFAULTS = {
  minimumAgeSeconds: 60,
  minimumMovePct: 0.25,
  maximumAgeSeconds: 180,
  maximumAdverseMovePct: 0.5,
  minimumAllowedPeakRetracementPct: 0.35,
  maximumPeakRetracementRatio: 0.35,
};

export const directedMovePct = (from, to, direction) => ((Number(to) / Number(from) - 1) * 100)
  * (direction === 'BEARISH' ? -1 : 1);

export function createFlowConfirmationCandidate({ id, key, market, detection, now = Date.now() }) {
  return {
    id, key, symbol: market.symbol, venue: market.venue, direction: detection.direction,
    referencePrice: Number(market.price), referenceOpenInterest: Number(market.openInterest),
    detectedAt: now, peakDirectedMovePct: 0, detection,
  };
}

export function evaluateFlowConfirmation(candidate, market, now = Date.now(), options = {}) {
  const rules = { ...FLOW_CONFIRMATION_DEFAULTS, ...options };
  const thresholdEpsilon = 1e-9;
  const ageSeconds = (now - Number(candidate.detectedAt)) / 1000;
  const movePct = directedMovePct(candidate.referencePrice, market.price, candidate.direction);
  const peakDirectedMovePct = Math.max(Number(candidate.peakDirectedMovePct) || 0, movePct);
  const retracementFromPeakPct = Math.max(0, peakDirectedMovePct - movePct);
  const allowedPeakRetracementPct = Math.max(
    rules.minimumAllowedPeakRetracementPct,
    peakDirectedMovePct * rules.maximumPeakRetracementRatio,
  );
  const metrics = { ageSeconds, movePct, peakDirectedMovePct, retracementFromPeakPct, allowedPeakRetracementPct, referencePrice: candidate.referencePrice, confirmationPrice: Number(market.price) };
  if (movePct <= -rules.maximumAdverseMovePct + thresholdEpsilon) return { action: 'REJECT', reason: 'MOVED_AGAINST_FLOW', metrics };
  if (ageSeconds > rules.maximumAgeSeconds) return { action: 'REJECT', reason: 'CONFIRMATION_EXPIRED', metrics };
  if (ageSeconds < rules.minimumAgeSeconds || movePct < rules.minimumMovePct) return { action: 'WAIT', reason: 'AWAITING_DIRECTIONAL_CONFIRMATION', metrics };
  if (retracementFromPeakPct > allowedPeakRetracementPct) return { action: 'REJECT', reason: 'MOMENTUM_FADED_BEFORE_CONFIRMATION', metrics };
  return { action: 'PUBLISH', reason: 'DIRECTION_CONFIRMED', metrics };
}
