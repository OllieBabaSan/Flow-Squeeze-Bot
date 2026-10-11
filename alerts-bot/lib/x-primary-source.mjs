const STREAM_PARAMS = new URLSearchParams({
  'tweet.fields': 'article,attachments,author_id,created_at,entities,lang,note_tweet,referenced_tweets',
  // Author identities are already hydrated in x-source-registry.json. Avoid an
  // unnecessary paid User read for every streamed post.
  expansions: 'article.cover_media,article.media_entities,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.attachments.media_keys',
  'media.fields': 'alt_text,media_key,preview_image_url,type,url',
});
const STREAM_URL = `https://api.x.com/2/tweets/search/stream?${STREAM_PARAMS}`;
export const MANAGED_RULE_PREFIX = 'alertsbot:';

export const CATALYST_QUERY = [
  'exploit', 'hacked', 'breach', 'compromised', 'incident', 'withdrawals', 'halted', 'outage',
  'partner', 'partnership', 'collaboration', 'integrates', 'integration', 'launches', 'launched',
  'mainnet', 'acquires', 'acquisition', 'listing', 'listed', 'delisting', 'buyback', 'burn',
  'governance', 'approved', 'approval', 'settlement', 'investigation', 'winds down', 'sunset',
].map(term => term.includes(' ') ? `"${term}"` : term).join(' OR ');

const cleanHandle = value => String(value || '').replace(/^@/, '').trim().replace(/[^A-Za-z0-9_]/g, '');

export function normalizeRegistry(entries = []) {
  const seen = new Set();
  return entries.map(entry => ({
    ...entry,
    handle: cleanHandle(entry.handle || entry.username),
    symbol: String(entry.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    tier: String(entry.tier || 'B').toUpperCase() === 'A' ? 'A' : 'B',
  })).filter(entry => entry.handle && !seen.has(entry.handle.toLowerCase()) && seen.add(entry.handle.toLowerCase()));
}

export function buildManagedRules(entries = [], { groupSize = 18 } = {}) {
  const accounts = normalizeRegistry(entries);
  const groups = tier => {
    const selected = accounts.filter(entry => entry.tier === tier);
    const result = [];
    for (let index = 0; index < selected.length; index += groupSize) result.push(selected.slice(index, index + groupSize));
    return result;
  };
  const rules = [];
  for (const tier of ['A', 'B']) {
    groups(tier).forEach((group, index) => {
      const authors = group.map(entry => `from:${entry.handle}`).join(' OR ');
      const catalystFilter = tier === 'B' ? ` ((${CATALYST_QUERY}) OR has:links OR has:media)` : '';
      rules.push({ value: `(${authors})${catalystFilter} -is:retweet -is:reply`, tag: `${MANAGED_RULE_PREFIX}${tier.toLowerCase()}:${index + 1}` });
    });
  }
  return rules;
}

export function normalizeStreamMessage(payload, registry = []) {
  const post = payload?.data;
  if (!post?.id || !post?.text || !post?.created_at) return null;
  const users = new Map((payload?.includes?.users || []).map(user => [String(user.id), user]));
  const registered = normalizeRegistry(registry).find(entry => String(entry.xUserId || '') === String(post.author_id));
  const user = users.get(String(post.author_id)) || {};
  const handle = cleanHandle(registered?.handle || user.username);
  if (!handle) return null;
  const account = registered || normalizeRegistry(registry).find(entry => entry.handle.toLowerCase() === handle.toLowerCase()) || {};
  const noteText = post.note_tweet?.text || '';
  const visibleText = String(noteText || post.text).replace(/\s+/g, ' ').trim();
  const referencedIds = new Set((post.referenced_tweets || []).map(entry => String(entry.id)));
  const referencedPosts = (payload?.includes?.tweets || []).filter(entry => referencedIds.has(String(entry.id)));
  const entitySets = [post.entities, post.note_tweet?.entities,
    ...referencedPosts.flatMap(entry => [entry.entities, entry.note_tweet?.entities])].filter(Boolean);
  const expandedUrls = [...new Set(entitySets.flatMap(entities => entities.urls || [])
    .flatMap(entity => [entity.unwound_url, entity.expanded_url]).filter(Boolean))];
  const articleText = [post.article?.title, post.article?.description, post.article?.plain_text,
    ...referencedPosts.flatMap(entry => [entry.note_tweet?.text || entry.text, entry.article?.title, entry.article?.description, entry.article?.plain_text])]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const mediaKeys = new Set([...(post.attachments?.media_keys || []),
    ...referencedPosts.flatMap(entry => entry.attachments?.media_keys || [])]);
  const media = (payload?.includes?.media || []).filter(entry => mediaKeys.has(entry.media_key)).map(entry => ({
    type: entry.type || '', altText: entry.alt_text || '', url: entry.url || '', previewImageUrl: entry.preview_image_url || '',
  }));
  const mediaAltText = media.map(entry => entry.altText).filter(Boolean).join(' ');
  return {
    title: visibleText,
    description: visibleText,
    url: `https://x.com/${handle}/status/${post.id}`,
    publishedAt: new Date(post.created_at),
    source: `X · @${handle}`,
    sourceClass: 'primary',
    sourceKind: 'primary_x',
    authority: account.tier === 'A' ? 30 : 25,
    authorHandle: handle,
    trackedSymbol: account.symbol || '',
    accountTier: account.tier || 'B',
    projectName: account.name || user.name || handle,
    postId: String(post.id),
    expandedUrls,
    embeddedContent: [articleText, mediaAltText].filter(Boolean).join(' ').trim(),
    media,
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(response) {
  const retryAfter = Number(response.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const resetAt = Number(response.headers?.get?.('x-rate-limit-reset'));
  if (Number.isFinite(resetAt) && resetAt > 0) return Math.max(1000, resetAt * 1000 - Date.now() + 1000);
  return 0;
}

export async function runXPrimaryStream({ bearerToken, registry, onPost, onStatus = () => {}, signal, fetchImpl = fetch }) {
  let backoffMs = 1000;
  let requestBackfill = true;
  while (!signal?.aborted) {
    try {
      const streamUrl = requestBackfill ? `${STREAM_URL}&backfill_minutes=5` : STREAM_URL;
      const response = await fetchImpl(streamUrl, {
        headers: { Authorization: `Bearer ${bearerToken}`, 'User-Agent': 'AlertsBot/3.0' },
        signal,
      });
      if (response.status === 400 && requestBackfill) {
        requestBackfill = false;
        backoffMs = 1000;
        onStatus('backfill_unavailable:continuing_live_only');
        continue;
      }
      if (!response.ok || !response.body) {
        const error = new Error(`X stream HTTP ${response.status}`);
        error.retryAfterMs = response.status === 429 ? retryDelay(response) : 0;
        throw error;
      }
      onStatus('connected');
      backoffMs = 1000;
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const item = normalizeStreamMessage(JSON.parse(line), registry);
          if (item) await onPost(item);
        }
      }
      throw new Error('X stream disconnected');
    } catch (error) {
      if (signal?.aborted) return;
      const delayMs = Math.min(15 * 60_000, Math.max(backoffMs, Number(error?.retryAfterMs) || 0));
      onStatus(`reconnecting:${error instanceof Error ? error.message : String(error)}:delayMs=${delayMs}`);
      await wait(delayMs);
      backoffMs = Math.min(30000, backoffMs * 2);
    }
  }
}
