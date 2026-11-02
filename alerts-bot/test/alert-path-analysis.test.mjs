import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAlertPath, summarizeAlertPaths } from '../lib/alert-path-analysis.mjs';

const record = horizons => ({ id: 'a', symbol: 'TEST', venue: 'Bybit', direction: 'BULLISH', entryAt: '2026-01-01T00:00:00Z', horizons });
const outcome = (directedReturnPct, maxFavorablePct, maxAdversePct = 0) => ({ directedReturnPct, maxFavorablePct, maxAdversePct });

test('classifies a delayed winner that later reverses', () => {
  const path = analyzeAlertPath(record({
    1: outcome(0, 0.35), 5: outcome(0.24, 1.12), 30: outcome(4.03, 4.09),
    60: outcome(2.55, 4.5, -0.36), 120: outcome(-0.65, 4.5, -0.71),
  }));
  assert.equal(path.classification, 'WORKED_THEN_REVERSED');
  assert.equal(path.firstActivationMinutes, 5);
  assert.equal(path.reversalMinutes, 120);
});

test('separates failure, spike without hold, and pending paths', () => {
  assert.equal(analyzeAlertPath(record({ 60: outcome(-1.2, 0.4, -1.5) })).classification, 'FAILED_60M');
  assert.equal(analyzeAlertPath(record({ 30: outcome(1.2, 1.2), 60: outcome(-0.1, 1.4, -0.5) })).classification, 'SPIKED_BUT_FAILED_TO_HOLD_60M');
  assert.equal(analyzeAlertPath(record({ 30: outcome(0.5, 0.7) })).classification, 'PENDING_60M');
});

test('summarizes worked paths without calling pending signals failures', () => {
  const paths = [
    { classification: 'WORKED_60M' }, { classification: 'WORKED_THEN_REVERSED' },
    { classification: 'FAILED_60M' }, { classification: 'PENDING_60M' },
  ];
  const summary = summarizeAlertPaths(paths);
  assert.equal(summary.matured60m, 3);
  assert.equal(summary.workedAt60m, 2);
  assert.equal(summary.workedAt60mPct, 2 / 3 * 100);
});
