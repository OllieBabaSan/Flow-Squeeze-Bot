import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCacheErrorFingerprint, parseMarketSnapshot, serializeMarkets } from '../src/shared-market-cache.mjs';

test('shared market snapshot gives every consumer the same timestamped market', () => {
  const now = Date.parse('2026-10-25T16:00:00Z');
  const source = new Map([['BTC', { symbol: 'BTC', mid: 100, bid: 99.9, ask: 100.1, bookUpdatedAtMs: now }]]);
  const snapshot = serializeMarkets(source, now);
  assert.deepEqual(parseMarketSnapshot(snapshot, now + 1000).get('BTC'), source.get('BTC'));
  assert.equal(snapshot.generatedAtMs, now);
  assert.equal(snapshot.catalogUpdatedAtMs, now);
});

test('shared market snapshot fails closed when stale or malformed', () => {
  const now = Date.parse('2026-10-25T16:00:00Z');
  const snapshot = serializeMarkets(new Map(), now - 20_000);
  assert.throws(() => parseMarketSnapshot(snapshot, now, 15_000), /stale/);
  assert.throws(() => parseMarketSnapshot({}, now), /invalid/);
});

test('shared market snapshot strips a stale book without discarding a fresh catalog', () => {
  const now = Date.parse('2026-10-25T16:00:00Z');
  const source = new Map([['BTC', { symbol: 'BTC', mid: 100, bid: 99.9, ask: 100.1, bookUpdatedAtMs: now - 6000 }]]);
  const market = parseMarketSnapshot(serializeMarkets(source, now, now), now, 15_000, 5_000).get('BTC');
  assert.equal(market.mid, 100);
  assert.equal(market.bid, null);
  assert.equal(market.ask, null);
});

test('changing cache ages collapse into one incident fingerprint', () => {
  assert.equal(
    normalizeCacheErrorFingerprint('Shared Hyperliquid market cache is stale (24636ms)'),
    'Shared Hyperliquid market cache is stale (<age>ms)',
  );
  assert.equal(
    normalizeCacheErrorFingerprint('Shared Hyperliquid market cache is stale (25637ms)'),
    'Shared Hyperliquid market cache is stale (<age>ms)',
  );
  assert.equal(
    normalizeCacheErrorFingerprint('Shared Hyperliquid catalog is stale (-6001ms)'),
    'Shared Hyperliquid catalog is stale (<age>ms)',
  );
});
