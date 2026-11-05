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

test('closes unconfirmed pressure and requires durable confirmed squeeze exhaustion', () => {
  const pressure = createFlowTrackingPosition({ id: 'a', market, detection: { direction: 'BULLISH', reason: 'crowded_shorts' }, tokenIdentity: {}, now: 0 });
  const expired = evaluateFlowFollowUp(pressure, { ...market, price: 100.2, openInterest: 10_100 }, null, 121 * 60_000);
  assert.equal(expired.event, 'SQUEEZE_UNCONFIRMED');
  const confirmed = { ...pressure, stage: 'CONFIRMED', confirmedAt: 10 * 60_000, peakDirectedMovePct: 3 };
  const candidate = evaluateFlowFollowUp(confirmed, { ...market, price: 100.5, openInterest: 9_800 }, null, 12 * 60_000);
  assert.equal(candidate.event, null);
  assert.equal(candidate.stage, 'CONFIRMED');
  const exhausted = evaluateFlowFollowUp({ ...confirmed, exhaustionCandidateAt: 12 * 60_000 }, { ...market, price: 100.5, openInterest: 9_800 }, null, 16 * 60_000);
  assert.equal(exhausted.event, 'SQUEEZE_EXHAUSTION');
});

test('clears an early exhaustion candidate when squeeze direction resumes', () => {
  const confirmed = { ...createFlowTrackingPosition({ id: 'a', market, detection: { direction: 'BEARISH', reason: 'crowded_longs' }, tokenIdentity: {}, now: 0 }), stage: 'CONFIRMED', confirmedAt: 20_000, peakDirectedMovePct: 0.9 };
  const earlyFade = evaluateFlowFollowUp(confirmed, { ...market, price: 100.2, openInterest: 9_900 }, null, 80_000);
  assert.equal(earlyFade.event, null);
  assert.equal(earlyFade.stage, 'CONFIRMED');
  assert.equal(earlyFade.exhaustionCandidateAt, 80_000);
  const resumed = evaluateFlowFollowUp({ ...confirmed, exhaustionCandidateAt: earlyFade.exhaustionCandidateAt }, { ...market, price: 99.3, openInterest: 9_800 }, null, 5 * 60_000);
  assert.equal(resumed.event, null);
  assert.equal(resumed.exhaustionCandidateAt, null);
});
