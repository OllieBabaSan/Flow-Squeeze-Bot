import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBreakoutAdmission } from '../lib/breakout-admission.mjs';

test('qualified episodes are admitted outside cooldown', () => {
  const result = evaluateBreakoutAdmission({ episodeId: 'one', episodeKey: 'Binance:BTC', direction: 'BULLISH', qualityStatus: 'QUALIFIED_SHADOW', now: 1000 });
  assert.equal(result.admitted, true);
});

test('same-market same-direction episodes respect cooldown', () => {
  const result = evaluateBreakoutAdmission({ episodeId: 'two', episodeKey: 'Binance:BTC', direction: 'BULLISH', qualityStatus: 'QUALIFIED_SHADOW', now: 3_000_000, recentAdmissions: { 'Binance:BTC:BULLISH': 2_000_000 } });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'SAME_DIRECTION_COOLDOWN');
});

test('opposite direction is not blocked by prior admission', () => {
  const result = evaluateBreakoutAdmission({ episodeId: 'three', episodeKey: 'Binance:BTC', direction: 'BEARISH', qualityStatus: 'QUALIFIED_SHADOW', now: 3_000_000, recentAdmissions: { 'Binance:BTC:BULLISH': 2_000_000 } });
  assert.equal(result.admitted, true);
});

test('zero-rate controls are suppressed deterministically', () => {
  const result = evaluateBreakoutAdmission({ episodeId: 'four', episodeKey: 'Binance:DOGE', direction: 'BULLISH', qualityStatus: 'WATCH_SHADOW', now: 1000, rates: { WATCH_SHADOW: 0 } });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'QUALITY_CONTROL_SAMPLE');
});

test('configured control rates are deterministic and auditable', () => {
  const args = { episodeId: 'stable-sample', episodeKey: 'Bybit:ETH', direction: 'BEARISH', qualityStatus: 'WATCH_SHADOW', now: 1000, rates: { WATCH_SHADOW: 0.5 } };
  const first = evaluateBreakoutAdmission(args);
  const second = evaluateBreakoutAdmission(args);
  assert.deepEqual(first, second);
  assert.equal(first.rate, 0.5);
  assert.ok(first.sampleValue >= 0 && first.sampleValue < 1);
});

test('unknown quality statuses fail into the bounded control sample', () => {
  const result = evaluateBreakoutAdmission({ episodeId: 'unknown', episodeKey: 'Bybit:ETH', direction: 'BULLISH', qualityStatus: 'FUTURE_STATUS', now: 1000 });
  assert.equal(result.rate, 0.05);
});
