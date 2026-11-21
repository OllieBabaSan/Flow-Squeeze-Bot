import { closeAccounting, evaluateExit } from './strategy.mjs';

function executableOrderFill(market, buy, notionalUsd, slippageBps = 0) {
  const levels = buy ? market?.askLevels : market?.bidLevels;
  if (!Array.isArray(levels) || !(notionalUsd > 0)) return null;
  let remaining = Number(notionalUsd), baseFilled = 0, quoteFilled = 0;
  for (const level of levels) {
    const price = Number(level.price), availableBase = Number(level.size);
    if (!(price > 0) || !(availableBase > 0)) continue;
    const quote = Math.min(remaining, price * availableBase);
    baseFilled += quote / price;
    quoteFilled += quote;
    remaining -= quote;
    if (remaining <= 1e-8) break;
  }
  const fillRatio = quoteFilled / notionalUsd;
  if (fillRatio < 0.999999 || !(baseFilled > 0)) return { fillRatio, quoteFilledUsd: quoteFilled, entryPrice: null };
  const rawVwap = quoteFilled / baseFilled;
  const slip = Number(slippageBps || 0) / 10_000;
  return { fillRatio: 1, quoteFilledUsd: quoteFilled, entryPrice: rawVwap * (buy ? 1 + slip : 1 - slip) };
}

export function executableEntryFill(market, direction, notionalUsd, slippageBps = 0) {
  return executableOrderFill(market, direction === 'BULLISH', notionalUsd, slippageBps);
}

export function executableExitFill(market, direction, notionalUsd, slippageBps = 0) {
  return executableOrderFill(market, direction === 'BEARISH', notionalUsd, slippageBps);
}

export function createShadowPosition({ observation, model, notionalUsd, entryPrice, enteredAtMs, config, metadata = {} }) {
  const quantity = notionalUsd / entryPrice;
  return {
    id: `${observation.id}:${model}`,
    parentSignalId: observation.id,
    symbol: observation.symbol,
    direction: observation.direction,
    kind: observation.kind,
    rejectionReason: observation.reason,
    model,
    notional: notionalUsd,
    quantity,
    entryPrice,
    entryFeeUsd: notionalUsd * config.takerFeeRate,
    plannedLossUsd: notionalUsd * config.stopLossPct / 100,
    enteredAtMs,
    peakProgressPct: 0,
    maxAdverseProgressPct: 0,
    ...metadata,
  };
}

export function evaluateShadowPosition(position, market, now, config) {
  const decision = evaluateExit(position, market, now, config);
  position.peakProgressPct = decision.peakProgressPct;
  position.maxAdverseProgressPct = decision.maxAdverseProgressPct;
  if (!decision.exit) return null;
  const exitNotionalUsd = position.quantity * (position.direction === 'BULLISH' ? market.bid : market.ask);
  const fill = executableExitFill(market, position.direction, exitNotionalUsd, config.slippageBpsPerSide);
  if (!fill || fill.fillRatio < 0.999999 || !(fill.entryPrice > 0)) {
    return { pendingExit: true, decision, fill };
  }
  const depthAwareDecision = { ...decision, exitPrice: fill.entryPrice };
  return { decision: depthAwareDecision, fill, accounting: closeAccounting(position, fill.entryPrice, config) };
}
