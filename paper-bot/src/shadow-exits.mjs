export function evaluateShadowExitRules(position, decision, now, config) {
  const rules = config.shadowExitRules || {};
  const heldMinutes = (now - position.enteredAtMs) / 60_000;
  const metrics = {
    heldMinutes,
    progressPct: decision.progressPct,
    peakProgressPct: decision.peakProgressPct,
    maxAdverseProgressPct: decision.maxAdverseProgressPct,
  };
  const triggered = [];
  const five = rules.fiveMinuteFailure;
  if (five && heldMinutes >= five.minimumHeldMinutes
      && decision.progressPct <= five.maximumProgressPct
      && decision.peakProgressPct < five.maximumPeakProgressPct) {
    triggered.push({ rule: 'FIVE_MINUTE_FAILURE', metrics });
  }
  const ten = rules.tenMinuteFailure;
  if (ten && heldMinutes >= ten.minimumHeldMinutes
      && decision.progressPct <= ten.maximumProgressPct
      && decision.peakProgressPct < ten.maximumPeakProgressPct) {
    triggered.push({ rule: 'TEN_MINUTE_FAILURE', metrics });
  }
  const giveback = rules.failedWinnerGiveback;
  if (giveback && heldMinutes >= Number(giveback.minimumHeldMinutes || 0)
      && decision.peakProgressPct >= giveback.minimumPeakProgressPct
      && decision.progressPct <= giveback.maximumProgressPct) {
    triggered.push({ rule: 'FAILED_WINNER_GIVEBACK', metrics });
  }
  return triggered;
}
