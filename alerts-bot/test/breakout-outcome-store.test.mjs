import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBreakoutOutcomeStore } from '../lib/breakout-outcome-store.mjs';

test('stores one bounded breakout episode and completes it after two hours', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'breakout-store-'));
  const store = createBreakoutOutcomeStore({ databasePath: join(dir, 'outcomes.sqlite3'), maximumActiveRecords: 1 });
  const now = Date.now();
  try {
    assert.deepEqual(await store.reserve({ id: 'one', episodeKey: 'Bybit:TEST:BULLISH:1', symbol: 'TEST', venue: 'Bybit', direction: 'BULLISH', quoteKey: 'Bybit:TEST', entryPrice: 100, entryAt: new Date(now).toISOString() }), { admitted: true });
    assert.deepEqual(await store.reserve({ id: 'two', episodeKey: 'Bybit:NEXT:BULLISH:1', symbol: 'NEXT', venue: 'Bybit', direction: 'BULLISH', quoteKey: 'Bybit:NEXT', entryPrice: 1, entryAt: new Date(now).toISOString() }), { admitted: false, reason: 'ACTIVE_RECORD_CAP' });
    const outcomes = await store.observe(new Map([['Bybit:TEST', 102]]), now + 121 * 60_000);
    assert.deepEqual(outcomes.map(row => row.horizonMinutes), [1, 5, 15, 30, 60, 120]);
    const telemetry = await store.telemetry(now + 121 * 60_000);
    assert.equal(telemetry.activeRecords, 0);
    assert.equal(telemetry.totalRecords, 1);
    assert.deepEqual(await store.maintain({ completedBeforeMs: now + 120 * 60_000 }), { prunedRecords: 0, prunedOutcomes: 0 });
    assert.deepEqual(await store.maintain({ completedBeforeMs: now + 122 * 60_000 }), { prunedRecords: 1, prunedOutcomes: 6 });
    assert.equal((await store.telemetry(now + 122 * 60_000)).totalRecords, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
