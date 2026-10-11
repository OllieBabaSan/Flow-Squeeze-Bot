import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNewsDelivery, contextApproval } from '../lib/news-delivery.mjs';

const verdict = { useful: true, context_worthy: true, affected_asset: 'NEAR', relationship: 'direct', confidence: 0.94, canonical_event_id: 'near-bridge-incident' };

test('primary X approval produces a pinging primary alert', () => {
  const decision = classifyNewsDelivery({ sourceKind: 'primary_x', editorial: { approved: true, verdict }, canonicalEvents: {} });
  assert.deepEqual(decision, { deliver: true, kind: 'PRIMARY_ALERT', eventId: 'near-bridge-incident', ping: true });
});

test('one useful publisher follow-up becomes silent context', () => {
  const decision = classifyNewsDelivery({ sourceKind: 'publisher', editorial: { approved: false, contextApproved: true, verdict }, canonicalEvents: { 'near-bridge-incident': { primarySeenAt: '2026-10-01T12:00:00Z' } } });
  assert.equal(decision.kind, 'CONTEXT_UPDATE');
  assert.equal(decision.ping, false);
});

test('a second context update is suppressed', () => {
  const decision = classifyNewsDelivery({ sourceKind: 'publisher', editorial: { contextApproved: true, verdict }, canonicalEvents: { 'near-bridge-incident': { primarySeenAt: 'x', contextSentAt: 'y' } } });
  assert.equal(decision.deliver, false);
});

test('context still requires direct high-confidence token attribution', () => {
  assert.equal(contextApproval({ ...verdict, relationship: 'secondary' }, 'NEAR').approved, false);
});
