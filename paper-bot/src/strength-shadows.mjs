export function evaluateStrengthShadowRules(position, decision, config) {
  const settings = config.strengthShadowRules || {};
  const triggered = [];
  for (const [name, givebackPct] of Object.entries(settings.trailingGivebackVariantsPct || {})) {
    if (decision.peakProgressPct >= config.trailingActivationPct
        && decision.peakProgressPct - decision.progressPct >= Number(givebackPct)) {
      triggered.push({ rule: `TRAIL_GIVEBACK_${name}`, model: 'FULL_EXIT' });
    }
  }
  for (const triggerPct of settings.partialProfit?.triggerProgressVariantsPct || []) {
    if (decision.progressPct < Number(triggerPct)) continue;
    for (const fraction of settings.partialProfit?.fractionVariants || []) {
      const triggerLabel = String(triggerPct).replace('.', '_');
      const fractionLabel = String(Math.round(Number(fraction) * 100)).padStart(2, '0');
      triggered.push({
        rule: `PARTIAL_${fractionLabel}_AT_${triggerLabel}PCT`, model: 'PARTIAL_EXIT',
        fraction: Number(fraction), triggerProgressPct: Number(triggerPct),
      });
    }
  }
  return triggered;
}

export function partialExitAccounting(position, partialExitPrice, finalExitPrice, fraction, config) {
  const sign = position.direction === 'BEARISH' ? -1 : 1;
  const partialQuantity = position.quantity * fraction;
  const remainingQuantity = position.quantity - partialQuantity;
  const partialGrossPnlUsd = partialQuantity * (partialExitPrice - position.entryPrice) * sign;
  const remainingGrossPnlUsd = remainingQuantity * (finalExitPrice - position.entryPrice) * sign;
  const partialExitFeeUsd = partialQuantity * partialExitPrice * config.takerFeeRate;
  const remainingExitFeeUsd = remainingQuantity * finalExitPrice * config.takerFeeRate;
  const grossPnlUsd = partialGrossPnlUsd + remainingGrossPnlUsd;
  const exitFeeUsd = partialExitFeeUsd + remainingExitFeeUsd;
  return {
    grossPnlUsd, exitFeeUsd,
    netPnlUsd: grossPnlUsd - position.entryFeeUsd - exitFeeUsd,
    partialGrossPnlUsd, remainingGrossPnlUsd, partialExitFeeUsd, remainingExitFeeUsd,
  };
}
