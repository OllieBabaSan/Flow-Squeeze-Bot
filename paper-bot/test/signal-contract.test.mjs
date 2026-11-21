import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFlowSignal } from '../src/signal-contract.mjs';

test('accepts the versioned Flow signal contract and measures each lag segment', () => {
  const row = {
    schemaVersion: 1, detectorVersion: 'flow-ignition-v2', signalId: 'flow:Bybit:BTC:1000',
    publicationStatus: 'PUBLISHED', createdAt: '2026-01-01T00:00:00.000Z',
    recordedAt: '2026-01-01T00:00:00.250Z', market: { venue: 'Bybit', symbol: 'BTC' },
    detection: { direction: 'BULLISH' },
  };
  const result = normalizeFlowSignal(row, Date.parse('2026-01-01T00:00:05.000Z'));
  assert.equal(result.valid, true);
  assert.equal(result.signalId, row.signalId);
  assert.equal(result.receiptLagMs, 5000);
  assert.equal(result.producerRecordingLagMs, 250);
  assert.equal(result.fileToConsumerLagMs, 4750);
});

test('keeps legacy records compatible with a deterministic fallback ID', () => {
  const row = { alertedAt: '2026-01-01T00:00:00.000Z', market: { venue: 'Bybit', symbol: 'ETH' }, detection: { direction: 'BEARISH' } };
  const result = normalizeFlowSignal(row, Date.parse('2026-01-01T00:00:01.000Z'));
  assert.equal(result.valid, true);
  assert.equal(result.schemaVersion, 0);
  assert.match(result.signalId, /Bybit:ETH:BEARISH/);
});

test('fails closed on a future unsupported schema version', () => {
  assert.deepEqual(normalizeFlowSignal({ schemaVersion: 99 }, Date.now()), { valid: false, reason: 'UNSUPPORTED_SIGNAL_SCHEMA', schemaVersion: 99 });
});
