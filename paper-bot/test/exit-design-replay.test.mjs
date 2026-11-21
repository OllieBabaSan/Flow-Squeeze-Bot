import test from 'node:test';
import assert from 'node:assert/strict';
import { replayFailure, replayPartial, replayTrail, summarizeReplay } from '../src/exit-design-replay.mjs';

const config = { slippageBpsPerSide: 0, takerFeeRate: 0, trailingActivationPct: 1 };
const position = { enteredAtMs: 0, entryPrice: 100, direction: 'BULLISH', quantity: 1, entryFeeUsd: 0 };
const candles = values => values.map(([minute, close]) => ({ timeMs: minute * 60_000, close }));

test('failure replay cuts a weak adverse path at the configured state', () => {
  const result = replayFailure(position, candles([[1, 99.9], [5, 99.4]]), { minimumHeldMinutes: 5, maximumProgressPct: -0.5, maximumPeakProgressPct: 0.25 }, -2, config);
  assert.equal(result.triggered, true); assert.ok(result.netPnlUsd > -2);
});

test('failure replay preserves a path that demonstrated sufficient strength', () => {
  const result = replayFailure(position, candles([[1, 100.4], [5, 99.4]]), { minimumHeldMinutes: 5, maximumProgressPct: -0.5, maximumPeakProgressPct: 0.25 }, 1, config);
  assert.equal(result.triggered, false); assert.equal(result.netPnlUsd, 1);
});

test('trail and partial models use only information available by each candle', () => {
  const rows = candles([[1, 101.2], [2, 100.6]]);
  assert.equal(replayTrail(position, rows, 0.5, 0, config).triggered, true);
  const partial = replayPartial(position, rows, 1, 0.5, 102, 2, config);
  assert.equal(partial.triggered, true); assert.ok(partial.netPnlUsd > 1);
});

test('summary reports savings and winner damage separately', () => {
  const summary = summarizeReplay([{ actualNetPnlUsd: -2, shadow: { triggered: true, netPnlUsd: -1 } }, { actualNetPnlUsd: 2, shadow: { triggered: true, netPnlUsd: 1 } }]);
  assert.equal(summary.improvementUsd, 0); assert.equal(summary.actualWinnersCut, 1); assert.equal(summary.losersImproved, 1);
});
