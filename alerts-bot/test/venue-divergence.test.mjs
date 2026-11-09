import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeVenueDivergence } from '../lib/venue-divergence.mjs';

test('summarizes same-symbol prices without affecting venue decisions', () => {
  const result = summarizeVenueDivergence([
    { venue: 'Bybit', symbol: 'AVAX', price: 8.42, observedAt: 1000 },
    { venue: 'Hyperliquid', symbol: 'AVAX', price: 8.47, observedAt: 1001 },
    { venue: 'Bybit', symbol: 'BTC', price: 100 },
  ], 'AVAX', 'Hyperliquid');
  assert.equal(result.available, true);
  assert.equal(result.venueCount, 2);
  assert.equal(result.selectedPrice, 8.47);
  assert.ok(result.selectedVsMedianPct > 0);
  assert.ok(result.crossVenueRangePct > 0);
});

test('reports unavailable when only one venue has a usable price', () => {
  const result = summarizeVenueDivergence([{ venue: 'Bybit', symbol: 'SOL', price: 150 }], 'SOL', 'Bybit');
  assert.equal(result.available, false);
  assert.equal(result.venueCount, 1);
});
