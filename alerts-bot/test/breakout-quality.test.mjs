import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBreakoutQuality } from '../lib/breakout-quality.mjs';

const observation = overrides => ({
  direction: 'BULLISH', derivativesContext: 'EXPANDING_OPEN_INTEREST', relativeActivity: 1.8,
  clearanceAtr: 0.6, channelWidthAtr: 4, directedReturn15mPct: 0.4,
  directedReturn60mPct: 1.2, fundingRate: -0.0002, ...overrides,
});

test('qualifies an aligned, active breakout in shadow only', () => {
  const result = evaluateBreakoutQuality({ observation: observation(), market: { change24hPct: 2 }, regime: { state: 'BULLISH' } });
  assert.equal(result.status, 'QUALIFIED_SHADOW');
  assert.equal(result.shadowOnly, true);
  assert.ok(result.score >= 70);
});

test('treats severe risk-off as aligned for bearish breakouts', () => {
  const result = evaluateBreakoutQuality({
    observation: observation({ direction: 'BEARISH' }),
    market: { change24hPct: -2 },
    regime: { state: 'SEVERE_RISK_OFF' },
  });
  assert.equal(result.status, 'QUALIFIED_SHADOW');
  assert.ok(result.flags.includes('REGIME_ALIGNED'));
});

test('keeps neutral-regime breakouts in research watch even with a high component score', () => {
  const result = evaluateBreakoutQuality({ observation: observation(), market: { change24hPct: 2 }, regime: { state: 'NEUTRAL' } });
  assert.notEqual(result.status, 'QUALIFIED_SHADOW');
  assert.ok(result.flags.includes('REGIME_NEUTRAL'));
});

test('penalizes countertrend, low-activity, extended observations', () => {
  const result = evaluateBreakoutQuality({ observation: observation({ relativeActivity: 0.4, clearanceAtr: 1.5, directedReturn15mPct: 1, directedReturn60mPct: 1.1 }), market: { change24hPct: -4 }, regime: { state: 'BEARISH' } });
  assert.equal(result.status, 'LOW_QUALITY_SHADOW');
  assert.ok(result.flags.includes('REGIME_COUNTERTREND'));
  assert.ok(result.flags.includes('BROADER_TREND_OPPOSED'));
  assert.ok(result.flags.includes('FRONT_LOADED_MOMENTUM'));
});

test('separates missing activity from scored quality cohorts', () => {
  const result = evaluateBreakoutQuality({ observation: observation({ relativeActivity: null }), market: { change24hPct: 2 }, regime: { state: 'NEUTRAL' } });
  assert.equal(result.status, 'ACTIVITY_MISSING_SHADOW');
  assert.ok(result.flags.includes('ACTIVITY_UNAVAILABLE'));
});

test('does not reward extreme activity or severe risk-off conditions', () => {
  const normal = evaluateBreakoutQuality({ observation: observation({ relativeActivity: 1.4 }), market: { change24hPct: 2 }, regime: { state: 'NEUTRAL' } });
  const extreme = evaluateBreakoutQuality({ observation: observation({ relativeActivity: 5 }), market: { change24hPct: 2 }, regime: { state: 'SEVERE_RISK_OFF' } });
  assert.ok(normal.score > extreme.score);
});
