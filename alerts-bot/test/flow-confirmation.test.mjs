import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowConfirmationCandidate, evaluateFlowConfirmation } from '../lib/flow-confirmation.mjs';

const market = price => ({ symbol: 'TEST', venue: 'Bybit', price, openInterest: 1000 });
const candidate = createFlowConfirmationCandidate({ id: 'a', key: 'Bybit:TEST', market: market(100), detection: { direction: 'BULLISH' }, now: 0 });

test('requires both observation time and directional continuation', () => {
  assert.equal(evaluateFlowConfirmation(candidate, market(100.4), 30_000).action, 'WAIT');
  assert.equal(evaluateFlowConfirmation(candidate, market(100.1), 60_000).action, 'WAIT');
  const result = evaluateFlowConfirmation(candidate, market(100.3), 60_000);
  assert.equal(result.action, 'PUBLISH');
  assert.equal(result.reason, 'DIRECTION_CONFIRMED');
});

test('rejects adverse and expired confirmations', () => {
  assert.equal(evaluateFlowConfirmation(candidate, market(99.5), 40_000).reason, 'MOVED_AGAINST_FLOW');
  assert.equal(evaluateFlowConfirmation(candidate, market(100.1), 181_000).reason, 'CONFIRMATION_EXPIRED');
});

test('preserves sharp momentum but rejects a materially faded spike', () => {
  assert.equal(evaluateFlowConfirmation(candidate, market(120), 60_000).action, 'PUBLISH');
  const faded = { ...candidate, peakDirectedMovePct: 5 };
  const result = evaluateFlowConfirmation(faded, market(102.5), 60_000);
  assert.equal(result.action, 'REJECT');
  assert.equal(result.reason, 'MOMENTUM_FADED_BEFORE_CONFIRMATION');
});

test('handles bearish confirmation directionally', () => {
  const bearish = createFlowConfirmationCandidate({ id: 'b', key: 'Bybit:TEST', market: market(100), detection: { direction: 'BEARISH' }, now: 0 });
  assert.equal(evaluateFlowConfirmation(bearish, market(99.7), 60_000).action, 'PUBLISH');
  assert.equal(evaluateFlowConfirmation(bearish, market(100.5), 60_000).reason, 'MOVED_AGAINST_FLOW');
});
