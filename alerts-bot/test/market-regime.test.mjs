import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarketRegime, evaluateRegimePublication } from '../lib/market-regime.mjs';

const markets = (benchmark, negative = 0.7) => Array.from({ length: 100 }, (_, index) => ({
  symbol: index === 0 ? 'BTC' : index === 1 ? 'ETH' : `T${index}`,
  venue: 'Hyperliquid',
  change24hPct: index < 2 ? benchmark : index < 2 + Math.round(98 * negative) ? -2 : 2,
}));

test('classifies broad bearish and severe risk-off regimes', () => {
  assert.equal(classifyMarketRegime(markets(-2, 0.65)).state, 'BEARISH');
  assert.equal(classifyMarketRegime(markets(-5, 0.8)).state, 'SEVERE_RISK_OFF');
});

test('fails open when regime inputs are incomplete', () => {
  const regime = classifyMarketRegime([{ symbol: 'BTC', venue: 'Hyperliquid', change24hPct: -10 }]);
  assert.equal(regime.reliable, false);
  assert.equal(evaluateRegimePublication({ eligible: true, direction: 'BULLISH' }, regime).publish, true);
});

test('requires stronger bullish evidence in a bearish regime', () => {
  const regime = classifyMarketRegime(markets(-2, 0.65));
  const weak = evaluateRegimePublication({ eligible: true, direction: 'BULLISH', reason: 'rising_open_interest', movePct: 1, freshTurnover: 300_000, oiGrowthPct: 0.6 }, regime);
  assert.equal(weak.publish, false);
  const strong = evaluateRegimePublication({ eligible: true, direction: 'BULLISH', reason: 'rising_open_interest', movePct: 1.5, freshTurnover: 600_000, oiGrowthPct: 1.2 }, regime);
  assert.equal(strong.publish, true);
  assert.equal(strong.countertrend, true);
});

test('suppresses all bullish publications in severe risk-off but keeps bearish alerts', () => {
  const regime = classifyMarketRegime(markets(-5, 0.8));
  assert.equal(evaluateRegimePublication({ eligible: true, direction: 'BULLISH' }, regime).publish, false);
  assert.equal(evaluateRegimePublication({ eligible: true, direction: 'BEARISH' }, regime).publish, true);
});
