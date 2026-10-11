import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowTrackingPosition, evaluateFlowFollowUp, flowAlertKind, flowAlertLabel } from '../lib/flow-alert-lifecycle.mjs';

const market = { symbol: 'TEST', venue: 'Hyperliquid', venueLabel: 'Hyperliquid perpetuals', price: 100, openInterest: 10_000 };

test('labels ordinary positioning as flow and crowded positioning as squeeze pressure', () => {
  assert.equal(flowAlertKind({ reason: 'rising_open_interest' }), 'FLOW');
  assert.equal(flowAlertLabel({ reason: 'rising_open_interest' }), 'FLOW');
  assert.equal(flowAlertKind({ reason: 'crowded_shorts' }), 'SQUEEZE_PRESSURE');
  assert.equal(flowAlertLabel({ reason: 'crowded_longs' }), 'SQUEEZE PRESSURE');
});

test('does not call adverse price action a confirmed squeeze while open interest is rising', () => {
  const position = createFlowTrackingPosition({ id: 'a', market, detection: { direction: 'BULLISH', reason: 'crowded_shorts' }, tokenIdentity: {}, now: 0 });
  const result = evaluateFlowFollowUp(position, { ...market, price: 101, openInterest: 10_100 }, null, 30 * 60_000);
  assert.equal(result.event, null);
  assert.equal(result.stage, 'PRESSURE');
});

test('confirms a bullish squeeze when price rises and short covering reduces open interest', () => {
  const position = createFlowTrackingPosition({ id: 'a', market, detection: { direction: 'BULLISH', reason: 'crowded_shorts' }, tokenIdentity: {}, now: 0 });
  const result = evaluateFlowFollowUp(position, { ...market, price: 101, openInterest: 9_900 }, null, 30 * 60_000);
  assert.equal(result.event, 'SQUEEZE_CONFIRMED');
  assert.equal(result.stage, 'CONFIRMED');
});

test('accepts direction-aligned liquidation evidence as confirmation', () => {
  const position = createFlowTrackingPosition({ id: 'a', market, detection: { direction: 'BEARISH', reason: 'crowded_longs' }, tokenIdentity: {}, now: 0 });
  const result = evaluateFlowFollowUp(position, { ...market, price: 99, openInterest: 10_100 }, { available: true, alignment: 'ALIGNED' }, 20 * 60_000);
  assert.equal(result.event, 'SQUEEZE_CONFIRMED');
});

test('closes unconfirmed pressure and reports confirmed squeeze exhaustion', () => {
  const pressure = createFlowTrackingPosition({ id: 'a', market, detection: { direction: 'BULLISH', reason: 'crowded_shorts' }, tokenIdentity: {}, now: 0 });
  const expired = evaluateFlowFollowUp(pressure, { ...market, price: 100.2, openInterest: 10_100 }, null, 121 * 60_000);
  assert.equal(expired.event, 'SQUEEZE_UNCONFIRMED');
  const confirmed = { ...pressure, stage: 'CONFIRMED', peakDirectedMovePct: 3 };
  const exhausted = evaluateFlowFollowUp(confirmed, { ...market, price: 101.5, openInterest: 9_800 }, null, 60 * 60_000);
  assert.equal(exhausted.event, 'SQUEEZE_EXHAUSTION');
});
