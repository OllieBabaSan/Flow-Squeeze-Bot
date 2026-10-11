import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePressureLifecycle, evaluateDirectionalPressure, pressureObservation, selectPressureEvents, shouldRecordPressure } from '../lib/directional-pressure.mjs';

const start = Date.now() - 30 * 60_000;
const quiet = Array.from({ length: 25 }, (_, index) => ({
  observedAt: start + index * 60_000,
  price: 100 + (index % 2 ? 0.02 : 0), openInterest: 10_000 + index,
  intervalTurnoverUsd: 100_000, tradeCount: 100,
  aggressiveBuyRatio: 0.5, bookImbalance: 0,
}));

test('requires an asset-relative history baseline', () => {
  const result = evaluateDirectionalPressure(quiet.slice(0, 5), quiet[5], { turnover24h: 20_000_000 });
  assert.equal(result.state, 'BASELINE');
});

test('detects pressure before a large price move', () => {
  const current = { ...quiet.at(-1), observedAt: Date.now(), price: 100.15, openInterest: 10_300, intervalTurnoverUsd: 500_000, tradeCount: 350, aggressiveBuyRatio: 0.7, bookImbalance: 0.25 };
  const result = evaluateDirectionalPressure(quiet, current, { turnover24h: 20_000_000 });
  assert.ok(['EARLY_PRESSURE', 'DEVELOPING', 'CONFIRMED_MOMENTUM'].includes(result.state));
  assert.equal(result.direction, 'BULLISH');
  assert.ok(result.pressureScore >= 60);
});

test('classifies bearish expansion with rising open interest', () => {
  const current = { ...quiet.at(-1), observedAt: Date.now(), price: 98.8, openInterest: 10_500, intervalTurnoverUsd: 600_000, tradeCount: 450, aggressiveBuyRatio: 0.25, bookImbalance: -0.4 };
  const result = evaluateDirectionalPressure(quiet, current, { turnover24h: 20_000_000 });
  assert.equal(result.direction, 'BEARISH');
  assert.equal(result.character, 'NEW_SHORT_EXPANSION');
  assert.ok(['EARLY_PRESSURE', 'DEVELOPING', 'CONFIRMED_MOMENTUM'].includes(result.state));
});

test('does not require prior compression or universal price thresholds', () => {
  const trending = quiet.map((row, index) => ({ ...row, price: 100 + index * 0.2 }));
  const current = { ...trending.at(-1), price: 105.7, openInterest: 10_500, intervalTurnoverUsd: 500_000, tradeCount: 400, aggressiveBuyRatio: 0.7, bookImbalance: 0.2 };
  const result = evaluateDirectionalPressure(trending, current, { turnover24h: 20_000_000 });
  assert.notEqual(result.state, 'BASELINE');
  assert.ok(result.metrics.normalMove > 0.1);
});

test('records only new episodes and state upgrades', () => {
  assert.equal(shouldRecordPressure({ state: 'EARLY_PRESSURE' }, { eligible: true, state: 'DEVELOPING' }), true);
  assert.equal(shouldRecordPressure({ state: 'DEVELOPING' }, { eligible: true, state: 'DEVELOPING' }), false);
  assert.equal(shouldRecordPressure({ state: 'CONFIRMED_MOMENTUM' }, { eligible: true, state: 'EARLY_PRESSURE' }), false);
});

test('does not confirm a five-minute burst without sustained ten-minute direction', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({ ...quiet[0], observedAt: start + index * 60_000, price: index < 25 ? 100 : 100 + (index - 24) * 0.25 }));
  const current = { ...history.at(-1), observedAt: Date.now(), price: 101.5, openInterest: 10_500, intervalTurnoverUsd: 500_000, tradeCount: 400, aggressiveBuyRatio: 0.7, bookImbalance: 0.2 };
  const result = evaluateDirectionalPressure(history, current, { turnover24h: 20_000_000 });
  assert.notEqual(result.state, 'CONFIRMED_MOMENTUM');
  assert.notEqual(result.state, 'SUSTAINED');
});

test('uses elapsed time rather than sample count at a thirty-second polling cadence', () => {
  const observedStart = Date.now() - 20 * 60_000;
  const history = Array.from({ length: 40 }, (_, index) => ({ ...quiet[0], observedAt: observedStart + index * 30_000, price: index < 28 ? 100 : 100 + (index - 27) * 0.12, openInterest: 10_000 + index * 10, intervalTurnoverUsd: index < 28 ? 100_000 : 200_000 }));
  const current = { ...history.at(-1), observedAt: observedStart + 40 * 30_000, price: 101.56, openInterest: 10_500, intervalTurnoverUsd: 250_000, tradeCount: 250, aggressiveBuyRatio: 0.7, bookImbalance: 0.2 };
  const result = evaluateDirectionalPressure(history, current, { turnover24h: 20_000_000 });
  assert.notEqual(result.state, 'CONFIRMED_MOMENTUM');
  assert.notEqual(result.state, 'SUSTAINED');
});

test('confirms persistence and permits repeated loss and resumption follow-ups', () => {
  const observedStart = Date.now() - 70 * 60_000;
  const history = Array.from({ length: 70 }, (_, index) => ({ ...quiet[0], observedAt: observedStart + index * 60_000, price: index < 55 ? 100 : 100 + (index - 54) * 0.12, openInterest: 10_000 + index * 15, intervalTurnoverUsd: index < 55 ? 100_000 : 180_000 }));
  const current = { ...history.at(-1), observedAt: Date.now(), price: 101.95, openInterest: 11_200, intervalTurnoverUsd: 500_000, tradeCount: 400, aggressiveBuyRatio: 0.8, bookImbalance: 0.4 };
  const confirmed = evaluateDirectionalPressure(history, current, { turnover24h: 20_000_000 });
  assert.ok(['CONFIRMED_MOMENTUM', 'SUSTAINED'].includes(confirmed.state));

  let lifecycle = advancePressureLifecycle(null, confirmed, 1_000);
  assert.equal(lifecycle.event, true);
  const weak = { eligible: false, state: 'NONE', direction: 'BULLISH', weakening: true, momentumLost: true };
  lifecycle = advancePressureLifecycle(lifecycle, weak, 121_000);
  assert.equal(lifecycle.state, 'MOMENTUM_WEAKENING');
  assert.equal(lifecycle.event, true);
  lifecycle = advancePressureLifecycle(lifecycle, weak, 181_000);
  assert.equal(lifecycle.state, 'MOMENTUM_WEAKENING');
  assert.equal(lifecycle.event, false);
  lifecycle = advancePressureLifecycle(lifecycle, weak, 301_000);
  assert.equal(lifecycle.state, 'MOMENTUM_LOSS');
  assert.equal(lifecycle.event, true);
  lifecycle = advancePressureLifecycle(lifecycle, confirmed, 361_000);
  assert.equal(lifecycle.state, 'RESUMED_MOMENTUM');
  assert.equal(lifecycle.event, true);
  lifecycle = advancePressureLifecycle(lifecycle, weak, 481_000);
  lifecycle = advancePressureLifecycle(lifecycle, weak, 541_000);
  lifecycle = advancePressureLifecycle(lifecycle, weak, 661_000);
  assert.equal(lifecycle.state, 'MOMENTUM_LOSS');
  assert.equal(lifecycle.event, true);
});

test('requires loss confirmation before starting a newly confirmed opposite trend', () => {
  const bullish = { eligible: true, state: 'CONFIRMED_MOMENTUM', direction: 'BULLISH', weakening: false, momentumLost: false };
  const bearish = { eligible: true, state: 'CONFIRMED_MOMENTUM', direction: 'BEARISH', weakening: false, momentumLost: false };
  let lifecycle = advancePressureLifecycle(null, bullish, 1_000);
  lifecycle = advancePressureLifecycle(lifecycle, bearish, 2_000);
  assert.equal(lifecycle.state, 'MOMENTUM_WEAKENING');
  assert.equal(lifecycle.event, true);
  lifecycle = advancePressureLifecycle(lifecycle, bearish, 182_001);
  assert.equal(lifecycle.state, 'MOMENTUM_LOSS');
  assert.equal(lifecycle.direction, 'BULLISH');
  lifecycle = advancePressureLifecycle(lifecycle, bearish, 123_000);
  assert.equal(lifecycle.state, 'CONFIRMED_MOMENTUM');
  assert.equal(lifecycle.direction, 'BEARISH');
  assert.equal(lifecycle.event, true);
});

test('reports stabilization when preliminary weakening recovers', () => {
  const confirmed = { eligible: true, state: 'CONFIRMED_MOMENTUM', direction: 'BULLISH', weakening: false, momentumLost: false };
  let lifecycle = advancePressureLifecycle(null, confirmed, 1_000);
  lifecycle = advancePressureLifecycle(lifecycle, { eligible: true, state: 'DEVELOPING', direction: 'BULLISH', weakening: true, momentumLost: false }, 2_000);
  assert.equal(lifecycle.state, 'MOMENTUM_WEAKENING');
  lifecycle = advancePressureLifecycle(lifecycle, confirmed, 3_000);
  assert.equal(lifecycle.state, 'MOMENTUM_STABILIZED');
  assert.equal(lifecycle.event, true);
});

test('stabilizes after a warning without requiring a fresh entry-grade signal', () => {
  const confirmed = { eligible: true, state: 'CONFIRMED_MOMENTUM', direction: 'BULLISH', weakening: false, momentumLost: false };
  let lifecycle = advancePressureLifecycle(null, confirmed, 1_000);
  lifecycle = advancePressureLifecycle(lifecycle, { eligible: false, state: 'NONE', direction: 'BULLISH', weakening: true, momentumLost: false }, 61_000);
  lifecycle = advancePressureLifecycle(lifecycle, { eligible: false, state: 'NONE', direction: 'BULLISH', weakening: false, momentumLost: false }, 121_000);
  assert.equal(lifecycle.state, 'MOMENTUM_STABILIZED');
  assert.equal(lifecycle.event, true);
});

test('does not skip the public confirmation when detection first arrives sustained', () => {
  const lifecycle = advancePressureLifecycle(null, { eligible: true, state: 'SUSTAINED', direction: 'BULLISH', weakening: false, momentumLost: false }, 1_000);
  assert.equal(lifecycle.state, 'CONFIRMED_MOMENTUM');
  assert.equal(lifecycle.event, true);
});

test('keeps a healthy confirmed lifecycle without emitting a duplicate event', () => {
  const detection = { eligible: true, state: 'CONFIRMED_MOMENTUM', direction: 'BULLISH', weakening: false, momentumLost: false };
  const confirmed = advancePressureLifecycle(null, detection, 1_000);
  const steady = advancePressureLifecycle(confirmed, detection, 2_000);
  assert.equal(steady.state, 'CONFIRMED_MOMENTUM');
  assert.equal(steady.event, false);
  assert.equal(steady.weakCount, 0);
});

test('ends tracking after momentum loss unless confirmed momentum resumes', () => {
  const lost = { state: 'MOMENTUM_LOSS', direction: 'BULLISH', weakCount: 3, inactiveCount: 0, event: true, at: 1_000 };
  let lifecycle = lost;
  for (let count = 1; count <= 5; count += 1) {
    lifecycle = advancePressureLifecycle(lifecycle, { eligible: false, state: 'NONE' }, 1_000 + count * 30_000);
    assert.equal(lifecycle.state, 'MOMENTUM_LOSS');
    assert.equal(lifecycle.event, false);
  }
  lifecycle = advancePressureLifecycle(lifecycle, { eligible: false, state: 'NONE' }, 601_001);
  assert.equal(lifecycle.state, 'MOMENTUM_ENDED');
  assert.equal(lifecycle.event, true);
  lifecycle = advancePressureLifecycle(lifecycle, { eligible: false, state: 'NONE' }, 211_000);
  assert.equal(lifecycle.state, 'MOMENTUM_ENDED');
  assert.equal(lifecycle.event, false);
});

test('builds observations from interval market changes', () => {
  const observation = pressureObservation({ price: 2, openInterest: 20, turnover24h: 1_500 }, { turnover24h: 1_000 }, 123);
  assert.equal(observation.intervalTurnoverUsd, 500);
  assert.equal(observation.observedAt, 123);
});

test('does not treat missing flow evidence as a bearish vote', () => {
  const history = quiet.map(row => ({ ...row, aggressiveBuyRatio: null, bookImbalance: null }));
  const current = { ...history.at(-1), price: 100.2, openInterest: 10_300, intervalTurnoverUsd: 500_000, tradeCount: 350 };
  const result = evaluateDirectionalPressure(history, current, { turnover24h: 20_000_000 });
  assert.equal(result.direction, 'BULLISH');
  assert.equal(result.components.pressure.flow, null);
  assert.equal(result.components.pressure.book, null);
});

test('selects one dominant venue and retains the other as confirmation',()=>{
  const candidate=(venue,extra={})=>({current:{symbol:'SOL',venue,turnover24h:100_000_000,openInterest:10_000,...extra},detection:{pressureScore:70,expansionScore:60},lifecycle:{state:'CONFIRMED_MOMENTUM',direction:'BULLISH'}});
  const result=selectPressureEvents([candidate('Kraken'),candidate('Hyperliquid')]);
  const primary=result.find(item=>item.sourceSelection.selected);
  assert.equal(primary.current.venue,'Hyperliquid');
  assert.deepEqual(primary.sourceSelection.confirmingVenues,['Kraken']);
  assert.equal(primary.sourceSelection.publishEligible,true);
  assert.equal(result.find(item=>item.current.venue==='Kraken').sourceSelection.publishEligible,false);
});

test('suppresses publication when venues disagree on direction',()=>{
  const result=selectPressureEvents([
    {current:{symbol:'ETH',venue:'Hyperliquid'},detection:{},lifecycle:{state:'CONFIRMED_MOMENTUM',direction:'BULLISH'}},
    {current:{symbol:'ETH',venue:'Kraken'},detection:{},lifecycle:{state:'CONFIRMED_MOMENTUM',direction:'BEARISH'}},
  ]);
  assert.equal(result.some(item=>item.sourceSelection.publishEligible),false);
  assert.ok(result.every(item=>item.sourceSelection.reason==='cross_venue_direction_conflict'));
});

test('groups broad momentum-ended bursts into one delivery digest',()=>{
  const events=Array.from({length:5},(_,index)=>({current:{symbol:`T${index}`,venue:'Hyperliquid'},detection:{},lifecycle:{state:'MOMENTUM_ENDED',direction:'BEARISH',at:123}}));
  const result=selectPressureEvents(events,{terminalDigestThreshold:5});
  assert.ok(result.every(item=>item.sourceSelection.deliveryMode==='terminal_digest'));
  assert.equal(new Set(result.map(item=>item.sourceSelection.digestId)).size,1);
});
