import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJsonBounded } from '../lib/bounded-json-fetch.mjs';

test('bounds request concurrency and retries transient failures', async () => {
  let active = 0; let maximumActive = 0;
  const seen = new Map();
  const result = await fetchJsonBounded([1, 2, 3, 4], async item => {
    active++; maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    seen.set(item, (seen.get(item) || 0) + 1);
    if (item === 2 && seen.get(item) === 1) throw new Error('transient');
    return { item };
  }, { concurrency: 2, retries: 1, retryBaseMs: 0 });
  assert.ok(maximumActive <= 2);
  assert.equal(result.results.filter(row => row.status === 'fulfilled').length, 4);
  assert.equal(result.retriesUsed, 1);
  assert.deepEqual(result.attemptsByItem, [1, 2, 1, 1]);
});

test('does not retry explicitly non-retryable errors', async () => {
  const error = new Error('bad request'); error.retryable = false;
  const result = await fetchJsonBounded([1], async () => { throw error; }, { retries: 3, retryBaseMs: 0 });
  assert.equal(result.results[0].status, 'rejected');
  assert.equal(result.attempts, 1);
});
