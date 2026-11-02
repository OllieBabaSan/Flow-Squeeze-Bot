export const PATH_HORIZONS_MINUTES = [1, 3, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];

const outcomeAt = (record, horizon) => record?.horizons?.[horizon] || record?.horizons?.[String(horizon)] || null;

export function analyzeAlertPath(record, options = {}) {
  const activationThresholdPct = Number(options.activationThresholdPct ?? 1);
  const failureThresholdPct = Number(options.failureThresholdPct ?? -1);
  const decisionHorizonMinutes = Number(options.decisionHorizonMinutes ?? 60);
  const activationHorizons = PATH_HORIZONS_MINUTES.filter(horizon => horizon <= decisionHorizonMinutes);
  const firstActivationMinutes = activationHorizons.find(horizon => Number(outcomeAt(record, horizon)?.maxFavorablePct) >= activationThresholdPct) ?? null;
  const decision = outcomeAt(record, decisionHorizonMinutes);
  const later = PATH_HORIZONS_MINUTES
    .filter(horizon => horizon > decisionHorizonMinutes && outcomeAt(record, horizon))
    .map(horizon => ({ horizon, outcome: outcomeAt(record, horizon) }));
  let classification = 'PENDING_60M';
  if (decision) {
    const directed = Number(decision.directedReturnPct);
    if (firstActivationMinutes != null && directed > 0) classification = 'WORKED_60M';
    else if (firstActivationMinutes != null) classification = 'SPIKED_BUT_FAILED_TO_HOLD_60M';
    else if (directed <= failureThresholdPct) classification = 'FAILED_60M';
    else classification = 'INCONCLUSIVE_60M';
  }
  const firstReversal = later.find(({ outcome }) => Number(outcome.directedReturnPct) <= 0);
  if (classification === 'WORKED_60M' && firstReversal) classification = 'WORKED_THEN_REVERSED';
  return {
    id: record.id,
    symbol: record.symbol,
    venue: record.venue,
    direction: record.direction,
    entryAt: record.entryAt,
    classification,
    firstActivationMinutes,
    reversalMinutes: firstReversal?.horizon ?? null,
    activationThresholdPct,
    decisionHorizonMinutes,
    horizons: Object.fromEntries(PATH_HORIZONS_MINUTES.flatMap(horizon => {
      const outcome = outcomeAt(record, horizon);
      return outcome ? [[horizon, {
        directedReturnPct: Number(outcome.directedReturnPct),
        maxFavorablePct: Number(outcome.maxFavorablePct),
        maxAdversePct: Number(outcome.maxAdversePct),
      }]] : [];
    })),
  };
}

export function summarizeAlertPaths(paths) {
  const counts = Object.fromEntries([...new Set(paths.map(path => path.classification))].sort()
    .map(classification => [classification, paths.filter(path => path.classification === classification).length]));
  const matured = paths.filter(path => path.classification !== 'PENDING_60M');
  const worked = matured.filter(path => ['WORKED_60M', 'WORKED_THEN_REVERSED'].includes(path.classification));
  return {
    signals: paths.length,
    matured60m: matured.length,
    classifications: counts,
    workedAt60m: worked.length,
    workedAt60mPct: matured.length ? worked.length / matured.length * 100 : null,
    laterReversals: paths.filter(path => path.classification === 'WORKED_THEN_REVERSED').length,
  };
}
