import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStrengthShadowRules, partialExitAccounting } from '../src/strength-shadows.mjs';

const config = {
  trailingActivationPct: 1, takerFeeRate: 0.00045,
  strengthShadowRules: {
    trailingGivebackVariantsPct: { '050': 0.5, '0625': 0.625 },
    partialProfit: { triggerProgressVariantsPct: [0.75, 1, 1.25, 1.5], fractionVariants: [0.25, 0.5, 0.75] },
  },
};

test('triggers tighter trail variants and partial profit independently', () => {
  const rules = evaluateStrengthShadowRules({}, { progressPct: 1.1, peakProgressPct: 1.7 }, config).map(row => row.rule);
  assert.deepEqual(rules, [
    'TRAIL_GIVEBACK_050',
    'PARTIAL_25_AT_0_75PCT', 'PARTIAL_50_AT_0_75PCT', 'PARTIAL_75_AT_0_75PCT',
    'PARTIAL_25_AT_1PCT', 'PARTIAL_50_AT_1PCT', 'PARTIAL_75_AT_1PCT',
  ]);
  const bothTrails = evaluateStrengthShadowRules({}, { progressPct: 1.0, peakProgressPct: 1.7 }, config).map(row => row.rule);
  assert.deepEqual(bothTrails, [
    'TRAIL_GIVEBACK_050', 'TRAIL_GIVEBACK_0625',
    'PARTIAL_25_AT_0_75PCT', 'PARTIAL_50_AT_0_75PCT', 'PARTIAL_75_AT_0_75PCT',
    'PARTIAL_25_AT_1PCT', 'PARTIAL_50_AT_1PCT', 'PARTIAL_75_AT_1PCT',
  ]);
});

test('partial accounting blends the partial and runner exits including fees', () => {
  const position = { direction: 'BULLISH', quantity: 8, entryPrice: 100, entryFeeUsd: 0.36 };
  const result = partialExitAccounting(position, 101, 102, 0.5, config);
  assert.equal(result.grossPnlUsd, 12);
  assert.ok(result.netPnlUsd < 12 && result.netPnlUsd > 10.9);
});
