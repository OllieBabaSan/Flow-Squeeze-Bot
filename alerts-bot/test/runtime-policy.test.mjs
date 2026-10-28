import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimitBackoff, flowAlertCooldownMs } from '../lib/runtime-policy.mjs';

test('uses a 24-hour alert cooldown while refusing unsafe shorter overrides', () => {
  assert.equal(flowAlertCooldownMs({}), 24 * 60 * 60 * 1000);
  assert.equal(flowAlertCooldownMs({ FLOW_ALERT_COOLDOWN_HOURS: '36' }), 36 * 60 * 60 * 1000);
  assert.equal(flowAlertCooldownMs({ FLOW_ALERT_COOLDOWN_HOURS: '6' }), 24 * 60 * 60 * 1000);
});

test('backs off only after rate limiting and resets after success', () => {
  const policy = createRateLimitBackoff({ minimumMs: 40_000, maximumMs: 300_000 });
  assert.equal(policy.reject(500, '', 1_000), 0);
  assert.equal(policy.reject(429, '', 1_000), 40_000);
  assert.equal(policy.remainingMs(21_000), 20_000);
  assert.equal(policy.reject(429, '90', 41_000), 90_000);
  policy.success();
  assert.equal(policy.remainingMs(41_000), 0);
});
