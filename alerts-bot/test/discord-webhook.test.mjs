import test from 'node:test';
import assert from 'node:assert/strict';
import { discordWebhookReceiptUrl, sendDiscordWebhook } from '../lib/discord-webhook.mjs';

test('requests a Discord message acknowledgement without discarding existing query parameters', () => {
  const result = new URL(discordWebhookReceiptUrl('https://discord.com/api/webhooks/1/token?thread_id=2'));
  assert.equal(result.searchParams.get('wait'), 'true');
  assert.equal(result.searchParams.get('thread_id'), '2');
});

test('records Discord server identity, timestamp, and acceptance latency', async () => {
  const calls = [];
  const times = [1_000, 1_125];
  const receipt = await sendDiscordWebhook({
    webhookUrl: 'https://discord.com/api/webhooks/1/token',
    payload: { content: 'test' },
    now: () => times.shift(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ id: '123', channel_id: '456', timestamp: '2026-10-31T14:00:00.000Z' }) };
    },
  });
  assert.match(calls[0].url, /wait=true/);
  assert.equal(receipt.messageId, '123');
  assert.equal(receipt.messageTimestamp, '2026-10-31T14:00:00.000Z');
  assert.equal(receipt.acceptanceLatencyMs, 125);
});

test('fails closed when Discord does not return message identity', async () => {
  await assert.rejects(() => sendDiscordWebhook({
    webhookUrl: 'https://discord.com/api/webhooks/1/token', payload: {}, now: () => 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  }), /missing message identity/);
});
