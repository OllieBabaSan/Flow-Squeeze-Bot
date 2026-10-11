import { fetchArticleContent } from './article-content.mjs';

const MAX_CONTENT_CHARS = 12_000;
const MAX_LINKS = 3;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const unique = (values = []) => [...new Set(values.map(clean).filter(Boolean))];

function externalHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !/(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)t\.co$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function hasReviewableXContent(item = {}) {
  return Boolean(
    clean(item.embeddedContent)
    || (item.expandedUrls || []).some(externalHttpUrl)
    || (item.media || []).some(entry => clean(entry.altText) || entry.url || entry.previewImageUrl),
  );
}

export async function enrichXPostContent(item, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  if (item?.sourceKind !== 'primary_x') return item;
  const sections = unique([item.description, item.embeddedContent]);
  const links = unique(item.expandedUrls).filter(externalHttpUrl).slice(0, MAX_LINKS);
  const results = await Promise.allSettled(links.map(url => fetchArticleContent(url, '', { fetchImpl, timeoutMs })));
  let linkedPages = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled' || result.value.source !== 'article' || !clean(result.value.text)) continue;
    linkedPages += 1;
    sections.push(result.value.text);
  }
  const mediaText = unique((item.media || []).map(entry => entry.altText));
  sections.push(...mediaText);
  const content = unique(sections).join('\n\n').slice(0, MAX_CONTENT_CHARS);
  const imageUrls = unique((item.media || [])
    .map(entry => entry.type === 'photo' ? entry.url || entry.previewImageUrl : entry.previewImageUrl)
    .filter(externalHttpUrl)).slice(0, 4);
  const sources = ['primary_x_post'];
  if (clean(item.embeddedContent)) sources.push('x_embedded');
  if (mediaText.length) sources.push('media_alt_text');
  if (linkedPages) sources.push('linked_page');
  if (imageUrls.length) sources.push('attached_images');
  return {
    ...item,
    description: content || item.description,
    extractedContent: content,
    contentSource: sources.join('+'),
    imageUrls,
    linkedPages,
    hasReviewableContent: hasReviewableXContent(item),
  };
}
