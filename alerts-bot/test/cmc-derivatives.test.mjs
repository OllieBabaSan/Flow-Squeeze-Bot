import test from 'node:test';
import assert from 'node:assert/strict';
import { createCmcDerivativesClient, derivativesSummary, liquidationClassification } from '../lib/cmc-derivatives.mjs';

test('classifies liquidation dominance relative to signal direction', () => {
  const row = { total_liquidations_1h: 300_000, long_liquidations_1h: 50_000, short_liquidations_1h: 250_000 };
  assert.equal(liquidationClassification(row, 'BULLISH').alignment, 'ALIGNED');
  assert.equal(liquidationClassification(row, 'BEARISH').alignment, 'OPPOSED');
});

test('summarizes only trusted non-outlier perpetual venues', () => {
  const pair = (slug, extra = {}) => ({ category: 'perpetual', outlier_detected: false, exchange: { exchange_slug: slug, exchange_name: slug }, exchange_reported_quotes: [{ price: 100, open_interest: 10_000, funding_rate: 0.001, index_basis: 0.0002 }], ...extra });
  const result = derivativesSummary({ market_pairs: [pair('hyperliquid'), pair('binance'), pair('unknown'), pair('kraken', { outlier_detected: true }), pair('okx', { category: 'spot' })] });
  assert.equal(result.venueCount, 2);
  assert.equal(result.totalOpenInterestUsd, 20_000);
  assert.equal(result.fundingSkew, 'LONG_BIASED');
});

test('caches liquidation lists and per-symbol derivatives', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    const data = url.includes('/liquidations/')
      ? { cryptocurrencies: [{ symbol: 'BTC', quotes: [{ total_liquidations_1h: 100_000, long_liquidations_1h: 10_000, short_liquidations_1h: 90_000 }] }] }
      : { market_pairs: [] };
    return { ok: true, json: async () => ({ status: { error_code: 0 }, data }) };
  };
  const client = createCmcDerivativesClient({ apiKey: 'test', fetchImpl, now: () => 1_000 });
  assert.equal(client.peekLiquidationEvidence('BTC', 'BULLISH').available, false);
  await client.liquidationEvidence('BTC', 'BULLISH');
  assert.equal(client.peekLiquidationEvidence('BTC', 'BULLISH').alignment, 'ALIGNED');
  await client.liquidationEvidence('BTC', 'BULLISH');
  await client.derivativesEvidence('BTC');
  assert.equal(client.peekDerivativesEvidence('BTC').available, false);
  await client.derivativesEvidence('BTC');
  assert.equal(calls, 2);
});
