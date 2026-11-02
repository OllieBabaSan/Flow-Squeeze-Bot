import test from 'node:test';
import assert from 'node:assert/strict';
import { updateVenueHealth, venueHealthSummary } from '../lib/venue-health.mjs';

test('tracks degradation, recovery and cumulative counters', () => {
  const first = updateVenueHealth({}, [{ venue: 'Binance', status: 'PARTIAL', marketCount: 40, failedRequests: 5, totalRequests: 45, durationMs: 900 }], 1_000);
  assert.equal(first.state.venues.Binance.partials, 1);
  assert.equal(first.events[0].event, 'DEGRADED');
  const second = updateVenueHealth(first.state, [{ venue: 'Binance', status: 'HEALTHY', marketCount: 45, durationMs: 600 }], 2_000);
  assert.equal(second.state.venues.Binance.successes, 1);
  assert.equal(second.events[0].event, 'RECOVERED');
  assert.match(venueHealthSummary(second.state), /Binance:HEALTHY:45:600ms/);
});
