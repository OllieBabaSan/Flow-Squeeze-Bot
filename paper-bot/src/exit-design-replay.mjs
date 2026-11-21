import { closeAccounting } from './strategy.mjs';
import { partialExitAccounting } from './strength-shadows.mjs';

export const progressPct = (entryPrice, price, direction) => ((price / entryPrice - 1) * 100) * (direction === 'BEARISH' ? -1 : 1);

export function modeledExitPrice(close, direction, config) {
  const slip = Number(config.slippageBpsPerSide || 0) / 10_000;
  return close * (direction === 'BEARISH' ? 1 + slip : 1 - slip);
}

function path(position, candles, config) {
  let peakProgressPct = 0;
  return candles.filter(candle => candle.timeMs >= position.enteredAtMs).map(candle => {
    const exitPrice = modeledExitPrice(candle.close, position.direction, config);
    const progress = progressPct(position.entryPrice, exitPrice, position.direction);
    peakProgressPct = Math.max(peakProgressPct, progress);
    return { ...candle, exitPrice, progressPct: progress, peakProgressPct, heldMinutes: (candle.timeMs - position.enteredAtMs) / 60_000 };
  });
}

export function replayFailure(position, candles, rule, actualNetPnlUsd, config) {
  const point = path(position, candles, config).find(row => row.heldMinutes >= rule.minimumHeldMinutes
    && row.progressPct <= rule.maximumProgressPct && row.peakProgressPct < rule.maximumPeakProgressPct);
  if (!point) return { triggered: false, netPnlUsd: actualNetPnlUsd };
  const accounting = closeAccounting(position, point.exitPrice, config);
  return { triggered: true, atMinutes: point.heldMinutes, progressPct: point.progressPct, peakProgressPct: point.peakProgressPct, exitPrice: point.exitPrice, netPnlUsd: accounting.netPnlUsd };
}

export function replayTrail(position, candles, givebackPct, actualNetPnlUsd, config) {
  const point = path(position, candles, config).find(row => row.peakProgressPct >= config.trailingActivationPct
    && row.peakProgressPct - row.progressPct >= givebackPct);
  if (!point) return { triggered: false, netPnlUsd: actualNetPnlUsd };
  const accounting = closeAccounting(position, point.exitPrice, config);
  return { triggered: true, atMinutes: point.heldMinutes, progressPct: point.progressPct, peakProgressPct: point.peakProgressPct, exitPrice: point.exitPrice, netPnlUsd: accounting.netPnlUsd };
}

export function replayPartial(position, candles, triggerPct, fraction, actualExitPrice, actualNetPnlUsd, config) {
  const point = path(position, candles, config).find(row => row.progressPct >= triggerPct);
  if (!point) return { triggered: false, netPnlUsd: actualNetPnlUsd };
  const accounting = partialExitAccounting(position, point.exitPrice, actualExitPrice, fraction, config);
  return { triggered: true, atMinutes: point.heldMinutes, progressPct: point.progressPct, exitPrice: point.exitPrice, netPnlUsd: accounting.netPnlUsd };
}

export function summarizeReplay(results) {
  const triggered = results.filter(row => row.shadow.triggered);
  return {
    trades: results.length, triggers: triggered.length,
    actualNetPnlUsd: results.reduce((sum, row) => sum + row.actualNetPnlUsd, 0),
    shadowNetPnlUsd: results.reduce((sum, row) => sum + row.shadow.netPnlUsd, 0),
    improvementUsd: results.reduce((sum, row) => sum + row.shadow.netPnlUsd - row.actualNetPnlUsd, 0),
    actualWinnersCut: triggered.filter(row => row.actualNetPnlUsd > 0 && row.shadow.netPnlUsd < row.actualNetPnlUsd).length,
    losersImproved: triggered.filter(row => row.actualNetPnlUsd <= 0 && row.shadow.netPnlUsd > row.actualNetPnlUsd).length,
    winnersImproved: triggered.filter(row => row.actualNetPnlUsd > 0 && row.shadow.netPnlUsd > row.actualNetPnlUsd).length,
  };
}
