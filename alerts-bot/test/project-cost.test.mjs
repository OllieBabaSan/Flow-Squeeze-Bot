import test from 'node:test';
import assert from 'node:assert/strict';
import { editorialUsageCost } from '../lib/project-cost.mjs';

test('prices uncached, cached, cache-write, and output tokens independently', () => {
  const result = editorialUsageCost({
    input_tokens: 1_000_000,
    input_tokens_details: { cached_tokens: 200_000, cache_write_tokens: 300_000 },
    output_tokens: 100_000,
  }, { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 });
  assert.equal(result.uncachedTokens, 500_000);
  assert.equal(result.usd, 2.99);
});

test('uses the current Terra standard rates by default', () => {
  const result = editorialUsageCost({ input_tokens: 10_000, output_tokens: 1_000 });
  assert.equal(result.usd, 0.032);
});
