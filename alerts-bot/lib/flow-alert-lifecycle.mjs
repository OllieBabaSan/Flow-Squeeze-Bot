const finite = value => Number.isFinite(Number(value));

export function flowAlertKind(detection = {}) {
  return ['crowded_shorts', 'crowded_longs'].includes(detection.reason) ? 'SQUEEZE_PRESSURE' : 'FLOW';
}

export function flowAlertLabel(detection = {}) {
  return flowAlertKind(detection) === 'SQUEEZE_PRESSURE' ? 'SQUEEZE PRESSURE' : 'FLOW';
}

export function createFlowTrackingPosition({ id, market, detection, tokenIdentity, now = Date.now() }) {
  return {
    id,
    symbol: market.symbol,
    venue: market.venue,
    venueLabel: market.venueLabel,
    quoteKey: `${market.venue}:${market.symbol}`,
    direction: detection.direction,
    kind: flowAlertKind(detection),
    reason: detection.reason,
    entryPrice: Number(market.price),
    entryOpenInterest: Number(market.openInterest),
    entryAt: now,
    stage: 'PRESSURE',
    peakDirectedMovePct: 0,
    tokenIdentity,
  };
}

export function evaluateFlowFollowUp(position, market, liquidationEvidence, now = Date.now(), options = {}) {
  const rules = {
    confirmationMovePct: 0.5,
    confirmationOiDropPct: 0.25,
    invalidationMovePct: 0.75,
    exhaustionGivebackPct: 0.75,
    maximumPressureMinutes: 120,
    maximumTrackingMinutes: 360,
    ...options,
  };
  if (!position || position.kind !== 'SQUEEZE_PRESSURE' || !finite(position.entryPrice) || !finite(market?.price)) return null;
  const sign = position.direction === 'BEARISH' ? -1 : 1;
  const rawMovePct = (Number(market.price) / Number(position.entryPrice) - 1) * 100;
  const directedMovePct = rawMovePct * sign;
  const oiChangePct = finite(position.entryOpenInterest) && Number(position.entryOpenInterest) > 0 && finite(market.openInterest)
    ? (Number(market.openInterest) / Number(position.entryOpenInterest) - 1) * 100
    : null;
  const elapsedMinutes = (now - Number(position.entryAt)) / 60000;
  const peakDirectedMovePct = Math.max(Number(position.peakDirectedMovePct || 0), directedMovePct);
  const liquidationConfirmed = liquidationEvidence?.alignment === 'ALIGNED';
  const coveringConfirmed = oiChangePct != null && oiChangePct <= -rules.confirmationOiDropPct;
  const evidence = { directedMovePct, oiChangePct, elapsedMinutes, peakDirectedMovePct, liquidationEvidence };

  if (position.stage === 'PRESSURE') {
    if (directedMovePct >= rules.confirmationMovePct && (coveringConfirmed || liquidationConfirmed)) {
      return { event: 'SQUEEZE_CONFIRMED', stage: 'CONFIRMED', evidence };
    }
    if (directedMovePct <= -rules.invalidationMovePct) return { event: 'SQUEEZE_INVALIDATED', stage: 'CLOSED', evidence };
    if (elapsedMinutes >= rules.maximumPressureMinutes) return { event: 'SQUEEZE_UNCONFIRMED', stage: 'CLOSED', evidence };
    return { event: null, stage: 'PRESSURE', evidence };
  }

  if (position.stage === 'CONFIRMED') {
    const givebackPct = peakDirectedMovePct - directedMovePct;
    if (givebackPct >= rules.exhaustionGivebackPct || directedMovePct <= 0) {
      return { event: 'SQUEEZE_EXHAUSTION', stage: 'CLOSED', evidence: { ...evidence, givebackPct } };
    }
    if (elapsedMinutes >= rules.maximumTrackingMinutes) return { event: 'SQUEEZE_TRACKING_ENDED', stage: 'CLOSED', evidence };
    return { event: null, stage: 'CONFIRMED', evidence };
  }
  return null;
}

