import test from 'node:test';
import assert from 'node:assert/strict';
import { closeAccounting, evaluateCandidate, evaluateExit, signalKind, sizePosition } from '../src/strategy.mjs';

const config = {
  maximumAlertAgeSeconds: 120, maximumSpreadBps: 20, minimumHyperliquidVolume24hUsd: 10_000_000,
  maximumAdditionalMoveBeforeEntryPct: 1, maximumAdverseMoveBeforeEntryPct: 0.5, confirmationWindowSeconds: 300,
  minimumConfirmationMovePct: 0.2, minimumSqueezeConfirmationMovePct: 0.35,
  riskPerTradePct: 1, maximumNotionalUsd: 800, stopLossPct: 1.25, takeProfitPct: 2.5,
  slippageBpsPerSide: 2, takerFeeRate: 0.00045, trailingActivationPct: 1, trailingGivebackPct: 0.75,
  timeStopMinutesBullishFlow: 20, timeStopMinutesBearishFlow: 10, timeStopMinutesSqueezePressure: 10,
  minimumTimeStopProgressPct: 0.25, maximumHoldMinutes: 240,
};
const candidate = { alertedAtMs: 0, stage: 'NEW', alertPrice: 100, alertOpenInterest: 1000, direction: 'BULLISH', kind: 'FLOW' };
const market = { mid: 100.3, bid: 100.29, ask: 100.31, openInterest: 1010, volume24hUsd: 20_000_000, isDelisted: false };

test('rejects assets absent from Hyperliquid', () => {
  assert.equal(evaluateCandidate(candidate, null, 30_000, config).reason, 'NOT_LISTED_ON_HYPERLIQUID');
});

test('rejects stale and extended entries', () => {
  assert.equal(evaluateCandidate(candidate, market, 121_000, config).reason, 'STALE_ALERT');
  assert.equal(evaluateCandidate({ ...candidate, stage: 'OBSERVING' }, { ...market, mid: 101.2, bid: 101.19, ask: 101.21 }, 60_000, config).reason, 'MOVE_ALREADY_EXTENDED');
});

test('enters confirmed flow but requires covering for squeeze pressure', () => {
  assert.equal(evaluateCandidate(candidate, market, 30_000, config).action, 'ENTER');
  const squeeze = { ...candidate, kind: 'SQUEEZE_PRESSURE' };
  assert.equal(evaluateCandidate(squeeze, { ...market, mid: 100.4, bid: 100.39, ask: 100.41, openInterest: 1010 }, 30_000, config).reason, 'AWAITING_COVERING_EVIDENCE');
  assert.equal(evaluateCandidate(squeeze, { ...market, mid: 100.4, bid: 100.39, ask: 100.41, openInterest: 990 }, 30_000, config).reason, 'SQUEEZE_CONFIRMED');
});

test('sizes one percent risk and caps notional', () => {
  const sized = sizePosition(1000, 100, 'BULLISH', config);
  assert.equal(sized.notional, 800);
  assert.equal(sized.plannedLossUsd, 10);
  assert.equal(sized.stopPrice, 98.75);
});

test('applies hard, time, trailing, and target exits', () => {
  const base = { direction: 'BULLISH', kind: 'FLOW', entryPrice: 100, enteredAtMs: 0, peakProgressPct: 0, maxAdverseProgressPct: 0 };
  assert.equal(evaluateExit(base, { bid: 98.6, ask: 98.62 }, 60_000, config).reason, 'HARD_STOP');
  assert.equal(evaluateExit(base, { bid: 100.1, ask: 100.12 }, 11 * 60_000, config).exit, false);
  assert.equal(evaluateExit(base, { bid: 100.1, ask: 100.12 }, 21 * 60_000, config).reason, 'TIME_STOP_NO_MOVEMENT');
  assert.equal(evaluateExit({ ...base, direction: 'BEARISH' }, { bid: 99.9, ask: 99.91 }, 11 * 60_000, config).reason, 'TIME_STOP_NO_MOVEMENT');
  assert.equal(evaluateExit({ ...base, kind: 'SQUEEZE_PRESSURE' }, { bid: 100.1, ask: 100.12 }, 11 * 60_000, config).reason, 'TIME_STOP_NO_MOVEMENT');
  assert.equal(evaluateExit({ ...base, peakProgressPct: 1.5 }, { bid: 100.6, ask: 100.62 }, 5 * 60_000, config).reason, 'TRAILING_STOP');
  assert.equal(evaluateExit(base, { bid: 102.6, ask: 102.62 }, 5 * 60_000, config).reason, 'TARGET_REACHED');
});

test('short accounting includes both taker fees', () => {
  const result = closeAccounting({ direction: 'BEARISH', quantity: 10, entryPrice: 100, entryFeeUsd: 0.45 }, 99, config);
  assert.equal(result.grossPnlUsd, 10);
  assert.ok(result.netPnlUsd < 10 && result.netPnlUsd > 9);
});

test('classifies crowded positioning as squeeze pressure', () => {
  assert.equal(signalKind('crowded_shorts'), 'SQUEEZE_PRESSURE');
  assert.equal(signalKind('rising_open_interest'), 'FLOW');
});
