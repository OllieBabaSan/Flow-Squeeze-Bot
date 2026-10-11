export const directedPct = (from, to, direction) => ((Number(to) / Number(from) - 1) * 100) * (direction === 'BEARISH' ? -1 : 1);
export const signalKind = reason => ['crowded_shorts', 'crowded_longs'].includes(reason) ? 'SQUEEZE_PRESSURE' : 'FLOW';

export function evaluateCandidate(candidate, market, now, config) {
  if (!market) return { action: 'REJECT', reason: 'NOT_LISTED_ON_HYPERLIQUID' };
  if (market.isDelisted) return { action: 'REJECT', reason: 'HYPERLIQUID_MARKET_DELISTED' };
  const ageSeconds = (now - candidate.alertedAtMs) / 1000;
  if (ageSeconds > config.maximumAlertAgeSeconds && candidate.stage === 'NEW') return { action: 'REJECT', reason: 'STALE_ALERT' };
  if (!(market.mid > 0) || !(market.bid > 0) || !(market.ask > 0)) return { action: 'WAIT', reason: 'INCOMPLETE_MARKET_DATA' };
  const spreadBps = ((market.ask - market.bid) / market.mid) * 10000;
  if (spreadBps > config.maximumSpreadBps) return { action: 'REJECT', reason: 'SPREAD_TOO_WIDE', metrics: { spreadBps } };
  if (market.volume24hUsd < config.minimumHyperliquidVolume24hUsd) return { action: 'REJECT', reason: 'INSUFFICIENT_HYPERLIQUID_LIQUIDITY' };
  const referencePrice = Number(candidate.referencePrice || candidate.alertPrice);
  const referenceOpenInterest = Number(candidate.referenceOpenInterest || candidate.alertOpenInterest);
  const movePct = directedPct(referencePrice, market.mid, candidate.direction);
  if (movePct > config.maximumAdditionalMoveBeforeEntryPct) return { action: 'REJECT', reason: 'MOVE_ALREADY_EXTENDED', metrics: { movePct, spreadBps } };
  if (movePct < -config.maximumAdverseMoveBeforeEntryPct) return { action: 'REJECT', reason: 'MOVED_AGAINST_ALERT', metrics: { movePct, spreadBps } };
  if (ageSeconds > config.confirmationWindowSeconds) return { action: 'REJECT', reason: 'INSUFFICIENT_CONFIRMATION', metrics: { movePct, spreadBps } };
  const squeeze = candidate.kind === 'SQUEEZE_PRESSURE';
  const oiChangePct = referenceOpenInterest > 0 ? (market.openInterest / referenceOpenInterest - 1) * 100 : null;
  const requiredMove = squeeze ? config.minimumSqueezeConfirmationMovePct : config.minimumConfirmationMovePct;
  const squeezeConfirmed = !squeeze || (oiChangePct != null && oiChangePct < 0);
  if (movePct >= requiredMove && squeezeConfirmed) return { action: 'ENTER', reason: squeeze ? 'SQUEEZE_CONFIRMED' : 'FLOW_CONFIRMED', metrics: { movePct, oiChangePct, spreadBps } };
  return { action: 'WAIT', reason: squeeze && movePct >= requiredMove ? 'AWAITING_COVERING_EVIDENCE' : 'AWAITING_DIRECTIONAL_CONFIRMATION', metrics: { movePct, oiChangePct, spreadBps } };
}

export function sizePosition(equity, entryPrice, direction, config) {
  const riskBudget = equity * config.riskPerTradePct / 100;
  const stopFraction = config.stopLossPct / 100;
  const notional = Math.min(config.maximumNotionalUsd, riskBudget / stopFraction);
  const quantity = notional / entryPrice;
  const sign = direction === 'BEARISH' ? -1 : 1;
  const stopPrice = entryPrice * (1 - sign * stopFraction);
  const targetPrice = entryPrice * (1 + sign * config.takeProfitPct / 100);
  return { notional, quantity, stopPrice, targetPrice, plannedLossUsd: notional * stopFraction };
}

export function simulatedFill(market, direction, side, config) {
  const entering = side === 'ENTRY';
  const buy = entering ? direction === 'BULLISH' : direction === 'BEARISH';
  const touch = buy ? market.ask : market.bid;
  const slip = config.slippageBpsPerSide / 10000;
  return touch * (buy ? 1 + slip : 1 - slip);
}

export function evaluateExit(position, market, now, config) {
  const exitPrice = simulatedFill(market, position.direction, 'EXIT', config);
  const progressPct = directedPct(position.entryPrice, exitPrice, position.direction);
  const peakProgressPct = Math.max(position.peakProgressPct || 0, progressPct);
  const maxAdverseProgressPct = Math.min(position.maxAdverseProgressPct || 0, progressPct);
  const heldMinutes = (now - position.enteredAtMs) / 60000;
  const timeStopMinutes = position.kind === 'SQUEEZE_PRESSURE'
    ? config.timeStopMinutesSqueezePressure
    : position.direction === 'BULLISH' ? config.timeStopMinutesBullishFlow : config.timeStopMinutesBearishFlow;
  const result = { exitPrice, progressPct, peakProgressPct, maxAdverseProgressPct };
  if (progressPct <= -config.stopLossPct) return { ...result, exit: true, reason: 'HARD_STOP' };
  if (progressPct >= config.takeProfitPct) return { ...result, exit: true, reason: 'TARGET_REACHED' };
  if (peakProgressPct >= config.trailingActivationPct && peakProgressPct - progressPct >= config.trailingGivebackPct) return { ...result, exit: true, reason: 'TRAILING_STOP' };
  if (heldMinutes >= timeStopMinutes && peakProgressPct < config.minimumTimeStopProgressPct) return { ...result, exit: true, reason: 'TIME_STOP_NO_MOVEMENT' };
  if (heldMinutes >= config.maximumHoldMinutes) return { ...result, exit: true, reason: 'MAXIMUM_HOLD_TIME' };
  return { ...result, exit: false };
}

export function closeAccounting(position, exitPrice, config) {
  const sign = position.direction === 'BEARISH' ? -1 : 1;
  const grossPnlUsd = position.quantity * (exitPrice - position.entryPrice) * sign;
  const exitNotional = position.quantity * exitPrice;
  const exitFeeUsd = exitNotional * config.takerFeeRate;
  return { grossPnlUsd, exitFeeUsd, netPnlUsd: grossPnlUsd - position.entryFeeUsd - exitFeeUsd };
}
