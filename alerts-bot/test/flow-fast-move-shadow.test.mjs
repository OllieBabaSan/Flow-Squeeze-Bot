import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFastMoveShadow } from '../lib/flow-fast-move-shadow.mjs';

const candidate = {
  detectedAt: 0, direction: 'BULLISH', referencePrice: 100, referenceOpenInterest: 1000,
  peakDirectedMovePct: 0.55, detection: { freshTurnover: 750_000, oiGrowthPct: 0.5 },
};
const market = { price: 100.55, bestBid: 100.54, bestAsk: 100.56, openInterest: 1005 };

test('qualifies only multi-factor acceleration inside the early shadow window', () => {
  assert.equal(evaluateFastMoveShadow(candidate, market, { state: 'BULLISH' }, 30_000).action, 'QUALIFY_SHADOW');
  assert.equal(evaluateFastMoveShadow(candidate, market, { state: 'BULLISH' }, 10_000).reason, 'FAST_MOVE_TOO_EARLY');
  assert.equal(evaluateFastMoveShadow(candidate, market, { state: 'BULLISH' }, 60_000).reason, 'FAST_MOVE_WINDOW_CLOSED');
});

test('rejects countertrend, weak participation, and fading moves from the cohort', () => {
  assert.equal(evaluateFastMoveShadow(candidate, market, { state: 'BEARISH' }, 30_000).reason, 'FAST_MOVE_REGIME_OPPOSED');
  assert.equal(evaluateFastMoveShadow({ ...candidate, detection: { ...candidate.detection, freshTurnover: 100_000 } }, market, { state: 'BULLISH' }, 30_000).reason, 'FAST_MOVE_TURNOVER_WEAK');
  assert.equal(evaluateFastMoveShadow({ ...candidate, peakDirectedMovePct: 1 }, market, { state: 'BULLISH' }, 30_000).reason, 'FAST_MOVE_MOMENTUM_FADING');
});
