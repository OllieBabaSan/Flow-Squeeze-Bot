import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveExecutionUniverse } from '../lib/execution-universe.mjs';

test('live Hyperliquid symbols replace the cached universe', () => {
  const result = resolveExecutionUniverse({ liveSymbols: ['BTC', 'ETH'], cached: { symbols: ['OLD'], updatedAtMs: 1 }, now: 10_000 });
  assert.equal(result.source, 'LIVE');
  assert.deepEqual([...result.symbols], ['BTC', 'ETH']);
});

test('fresh cached universe survives a temporary Hyperliquid failure', () => {
  const result = resolveExecutionUniverse({ liveSymbols: [], cached: { symbols: ['BTC', 'SOL'], updatedAtMs: 9_000 }, now: 10_000, maxAgeMs: 5_000 });
  assert.equal(result.source, 'CACHED');
  assert.deepEqual([...result.symbols], ['BTC', 'SOL']);
  assert.equal(result.ageMs, 1_000);
});

test('stale cached universe is rejected', () => {
  const result = resolveExecutionUniverse({ liveSymbols: [], cached: { symbols: ['BTC'], updatedAtMs: 1_000 }, now: 10_000, maxAgeMs: 5_000 });
  assert.equal(result.source, 'UNAVAILABLE');
  assert.equal(result.symbols.size, 0);
});
