function increment(target, key, amount = 1) {
  const normalized = String(key || 'UNKNOWN');
  target[normalized] = Number(target[normalized] || 0) + amount;
}

export function summarizeFastMoveEvaluations(records = []) {
  const latestBySignal = new Map();
  for (const record of records) {
    if (!record?.signalId) continue;
    latestBySignal.set(String(record.signalId), record);
  }
  const candidates = [...latestBySignal.values()];
  const byConfirmationAction = {};
  const byFinalEvaluationReason = {};
  const rejectionReasonOccurrences = {};
  const candidatesByRejectionReason = {};
  for (const record of candidates) {
    increment(byConfirmationAction, record.confirmationAction);
    increment(byFinalEvaluationReason, record.evaluation?.lastReason);
    for (const [reason, count] of Object.entries(record.evaluation?.reasonCounts || {})) {
      increment(rejectionReasonOccurrences, reason, Number(count) || 0);
      increment(candidatesByRejectionReason, reason);
    }
  }
  return {
    candidates: candidates.length,
    qualified: candidates.filter(record => record.qualified).length,
    unqualified: candidates.filter(record => !record.qualified).length,
    byConfirmationAction,
    byFinalEvaluationReason,
    rejectionReasonOccurrences,
    candidatesByRejectionReason,
  };
}
