import test from 'node:test';
import assert from 'node:assert/strict';
import { preliminaryBreakout, relativeVolume, updateBreakoutSeries } from '../lib/breakout-observer.mjs';

const market = (price, openInterest = 1000) => ({ price, openInterest, turnover24h: 2_000_000_000, fundingRate: 0.0001 });

test('builds compact five-minute observation bars', () => {
  let series = updateBreakoutSeries({}, market(100), 0);
  series = updateBreakoutSeries(series, market(102), 60_000);
  series = updateBreakoutSeries(series, market(101), 300_000);
  assert.equal(series.bars.length, 2);
  assert.deepEqual(series.bars[0], { start: 0, open: 100, high: 102, low: 100, close: 102, openInterest: 1000, turnover24h: 2_000_000_000 });
});

test('detects size-neutral channel breakouts and records derivatives context', () => {
  let series = {};
  for (let index = 0; index < 21; index++) {
    const price = 100 + (index % 2) * 0.2;
    series = updateBreakoutSeries(series, market(price, 1000), index * 300_000);
  }
  const result = preliminaryBreakout(series, market(101, 1010), 21 * 300_000);
  assert.equal(result.eligible, true);
  assert.equal(result.direction, 'BULLISH');
  assert.equal(result.derivativesContext, 'EXPANDING_OPEN_INTEREST');
  assert.ok(result.clearanceAtr > 0.2);
});

test('does not require or cap absolute dollar turnover', () => {
  let series = {};
  for (let index = 0; index < 21; index++) series = updateBreakoutSeries(series, { ...market(100 + (index % 2) * 0.2), turnover24h: 50_000 }, index * 300_000);
  assert.equal(preliminaryBreakout(series, { ...market(101), turnover24h: 50_000 }, 21 * 300_000).eligible, true);
  assert.equal(preliminaryBreakout(series, { ...market(101), turnover24h: 5_000_000_000 }, 21 * 300_000).eligible, true);
});

test('calculates activity relative to the market own baseline', () => {
  assert.equal(relativeVolume(300, [100, 100, 100]), 3);
  assert.equal(relativeVolume(300, []), null);
});
