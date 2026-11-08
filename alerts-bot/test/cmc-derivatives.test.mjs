import test from 'node:test';
import assert from 'node:assert/strict';
import { createCmcDerivativesClient, derivativesSummary, exchangeDerivativesContext, liquidationClassification, liquidationDeltaEvidence, normalizeCmcCreditStatus } from '../lib/cmc-derivatives.mjs';

test('classifies liquidation dominance relative to signal direction', () => {
  const row = { total_liquidations_1h: 300_000, long_liquidations_1h: 50_000, short_liquidations_1h: 250_000 };
  assert.equal(liquidationClassification(row, 'BULLISH').alignment, 'ALIGNED');
  assert.equal(liquidationClassification(row, 'BEARISH').alignment, 'OPPOSED');
});

test('only classifies post-alert liquidation growth from a fresh snapshot', () => {
  const baseline = { ...liquidationClassification({ total_liquidations_1h: 300_000, long_liquidations_1h: 50_000, short_liquidations_1h: 250_000 }, 'BULLISH'), lastUpdated: '2026-01-01T00:00:00Z', capturedAt: '2026-01-01T00:00:10Z' };
  const current = { ...liquidationClassification({ total_liquidations_1h: 430_000, long_liquidations_1h: 60_000, short_liquidations_1h: 370_000 }, 'BULLISH'), lastUpdated: '2026-01-01T00:02:00Z', capturedAt: '2026-01-01T00:02:10Z' };
  const delta = liquidationDeltaEvidence(current, baseline, 'BULLISH');
  assert.equal(delta.source, 'POST_ALERT_DELTA');
  assert.equal(delta.freshSnapshot, true);
  assert.equal(delta.alignment, 'ALIGNED');
  assert.equal(delta.short1hUsd, 120_000);
});

test('summarizes aggregate exchange derivatives context', () => {
  const result = exchangeDerivativesContext({ exchanges: [
    { exchange_id: 1, exchange_name: 'One', exchange_slug: 'one', quotes: [{ open_interest_usd: 100, derivative_volume_usd: 500, last_updated: '2026-01-01T00:00:00Z' }] },
    { exchange_id: 2, exchange_name: 'Two', exchange_slug: 'two', quotes: [{ open_interest: 200, derivative_volume: 700, last_updated: '2026-01-01T00:01:00Z' }] },
  ] }, '2026-01-01T00:01:10Z');
  assert.equal(result.aggregateOpenInterestUsd, 300);
  assert.equal(result.aggregateDerivativeVolumeUsd, 1200);
  assert.equal(result.latestUpdated, '2026-01-01T00:01:00Z');
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
    const data = url.includes('/key/info')
      ? { usage: { current_month: { credits_left: 10_000 } } }
      : url.includes('/liquidations/')
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
  assert.equal(calls, 3);
});

test('stops credit-consuming requests at the configured monthly reserve', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    const data = url.includes('/key/info') ? { usage: { current_month: { credits_left: 1000 } } } : { cryptocurrencies: [] };
    return { ok: true, json: async () => ({ status: { error_code: 0 }, data }) };
  };
  const client = createCmcDerivativesClient({ apiKey: 'test', fetchImpl, monthlyCreditReserve: 1500 });
  await assert.rejects(() => client.primeLiquidations(), /CMC_CREDIT_RESERVE_REACHED/);
  assert.equal(calls, 1);
});

test('reports CMC usage when credits_left must be derived from plan limit', () => {
  assert.deepEqual(normalizeCmcCreditStatus({
    plan: { credit_limit_monthly: 15_000 }, usage: { current_month: { credits_used: 225 } },
  }, 1500), {
    available: true, creditsUsed: 225, creditsLeft: 14_775, monthlyCreditLimit: 15_000,
    reserve: 1500, reserveReached: false,
  });
});
