export function discordWebhookReceiptUrl(webhookUrl) {
  const url = new URL(webhookUrl);
  url.searchParams.set('wait', 'true');
  return url.toString();
}

export async function sendDiscordWebhook({ webhookUrl, payload, fetchImpl = fetch, now = () => Date.now() }) {
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL is not configured');
  const requestedAtMs = now();
  const response = await fetchImpl(discordWebhookReceiptUrl(webhookUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
  const message = await response.json();
  const acceptedAtMs = now();
  if (!message?.id || !message?.timestamp) throw new Error('Discord acknowledgement missing message identity');
  return {
    messageId: String(message.id),
    messageTimestamp: String(message.timestamp),
    channelId: message.channel_id ? String(message.channel_id) : null,
    requestedAt: new Date(requestedAtMs).toISOString(),
    acceptedAt: new Date(acceptedAtMs).toISOString(),
    acceptanceLatencyMs: Math.max(0, acceptedAtMs - requestedAtMs),
  };
}
