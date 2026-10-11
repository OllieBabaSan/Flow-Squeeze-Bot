import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCatalystText, movementMetrics } from '../lib/x-signal-evaluation.mjs';

test('classifies semantic catalyst families without relying on one exact phrase', () => {
  const result = classifyCatalystText('The protocol paused withdrawals after a bridge breach and announced remediation.');
  assert.deepEqual(result.families, ['security_incident']);
});

test('computes market and volatility adjusted movement-to-catalyst ratio', () => {
  const result = movementMetrics({ entryPrice: 100, exitPrice: 104, benchmarkEntryPrice: 100, benchmarkExitPrice: 101, direction: 'BULLISH', preEventDailyVolatilityPct: 6, horizonMinutes: 360 });
  assert.equal(Number(result.abnormalReturnPct.toFixed(6)), 3);
  assert.equal(Number(result.expectedMovePct.toFixed(6)), 3);
  assert.equal(Number(result.absoluteMovementToCatalystRatio.toFixed(6)), 1);
  assert.equal(Number(result.directionalMovementToCatalystRatio.toFixed(6)), 1);
});

test('bearish ratios reward abnormal declines', () => {
  const result = movementMetrics({ entryPrice: 100, exitPrice: 95, benchmarkEntryPrice: 100, benchmarkExitPrice: 99, direction: 'BEARISH', preEventDailyVolatilityPct: 8, horizonMinutes: 360 });
  assert.ok(result.directedAbnormalReturnPct > 0);
  assert.ok(result.directionalMovementToCatalystRatio > 0);
});
