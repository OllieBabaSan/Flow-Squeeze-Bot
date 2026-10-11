const decode = value => String(value || '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/\s+/g, ' ').trim();

function textFromHtml(html) {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || '';
  const jsonBodies = [...html.matchAll(/"articleBody"\s*:\s*"((?:\\.|[^"\\])*)"/gi)]
    .map(match => { try { return JSON.parse(`"${match[1]}"`); } catch { return ''; } });
  const meta = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1] || '';
  const body = (article || html).replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ').replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decode([meta, ...jsonBodies, body].filter(Boolean).join(' ')).slice(0, 12_000);
}

export async function fetchArticleContent(url, fallback = '', { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'CryptoAlerts/2.0 (+research alert reviewer)', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const type = response.headers?.get?.('content-type') || '';
    if (!response.ok || !type.toLowerCase().includes('text/html')) throw new Error(`HTTP ${response.status}`);
    const extracted = textFromHtml(await response.text());
    if (extracted.length < 200) throw new Error('insufficient article text');
    return { text: extracted, source: 'article' };
  } catch {
    return { text: String(fallback || '').slice(0, 6000), source: 'feed_summary' };
  }
}

export { textFromHtml };
