import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManagedRules, normalizeStreamMessage, runXPrimaryStream } from '../lib/x-primary-source.mjs';

const registry = [
  { handle: '@nearprotocol', symbol: 'NEAR', name: 'NEAR Protocol', tier: 'A' },
  { handle: 'OndoFinance', symbol: 'ONDO', name: 'Ondo Finance', tier: 'B' },
];

test('builds unfiltered Tier A and catalyst-filtered Tier B rules', () => {
  const rules = buildManagedRules(registry);
  assert.equal(rules.length, 2);
  assert.match(rules[0].value, /from:nearprotocol/);
  assert.doesNotMatch(rules[0].value, /exploit/);
  assert.match(rules[1].value, /from:OndoFinance/);
  assert.match(rules[1].value, /exploit/);
  assert.match(rules[1].value, /has:links OR has:media/);
  assert.ok(rules.every(rule => rule.value.includes('-is:retweet -is:reply')));
});

test('normalizes a streamed official post into a primary news item', () => {
  const item = normalizeStreamMessage({
    data: { id: '123', author_id: '9', created_at: '2026-10-01T12:00:00.000Z', text: 'We have paused the bridge after an incident.' },
    includes: { users: [{ id: '9', username: 'nearprotocol', name: 'NEAR Protocol' }] },
  }, registry);
  assert.equal(item.sourceKind, 'primary_x');
  assert.equal(item.trackedSymbol, 'NEAR');
  assert.equal(item.url, 'https://x.com/nearprotocol/status/123');
});

test('preserves expanded links, article text, long-form text, and media for content review', () => {
  const item = normalizeStreamMessage({
    data: {
      id: '124', author_id: '9', created_at: '2026-10-01T12:00:00.000Z', text: 'Read more https://t.co/a',
      note_tweet: { text: 'Full announcement text', entities: { urls: [{ expanded_url: 'https://near.org/blog/update' }] } },
      article: { title: 'Bridge security update', description: 'Withdrawals have been paused.' },
      attachments: { media_keys: ['3_1'] },
      referenced_tweets: [{ type: 'quoted', id: '125' }],
    },
    includes: {
      users: [{ id: '9', username: 'nearprotocol', name: 'NEAR Protocol' }],
      media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/example.jpg', alt_text: 'Incident remediation timeline' }],
      tweets: [{ id: '125', text: 'The bridge upgrade is now live.', entities: { urls: [{ expanded_url: 'https://near.org/blog/launch' }] } }],
    },
  }, registry);
  assert.equal(item.title, 'Full announcement text');
  assert.deepEqual(item.expandedUrls, ['https://near.org/blog/update', 'https://near.org/blog/launch']);
  assert.match(item.embeddedContent, /Bridge security update/);
  assert.match(item.embeddedContent, /Incident remediation timeline/);
  assert.match(item.embeddedContent, /bridge upgrade is now live/);
  assert.equal(item.media[0].type, 'photo');
});

test('falls back to live-only stream when backfill is unavailable', async () => {
  const controller = new AbortController();
  const urls = [];
  const statuses = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (urls.length === 1) return { ok: false, status: 400, headers: new Headers() };
    return { ok: true, status: 200, headers: new Headers(), body: (async function* () { controller.abort(); })() };
  };
  await runXPrimaryStream({ bearerToken: 'test', registry, onPost: async () => {}, onStatus: status => statuses.push(status), signal: controller.signal, fetchImpl });
  assert.match(urls[0], /backfill_minutes=5/);
  assert.doesNotMatch(urls[1], /backfill_minutes/);
  assert.ok(statuses.includes('backfill_unavailable:continuing_live_only'));
});
