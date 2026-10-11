import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichXPostContent, hasReviewableXContent } from '../lib/x-post-content.mjs';

test('fetches the contents of an expanded X link before review', async () => {
  const item = {
    sourceKind: 'primary_x', description: 'Quarterly review https://t.co/a', embeddedContent: '',
    expandedUrls: ['https://project.example/review'], media: [],
  };
  const fetchImpl = async () => ({
    ok: true,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => `<article><h1>Token buyback</h1><p>All protocol revenue will purchase the token monthly.</p><p>${'This is a concrete governance implementation detail. '.repeat(5)}</p></article>`,
  });
  const enriched = await enrichXPostContent(item, { fetchImpl });
  assert.match(enriched.description, /All protocol revenue/);
  assert.match(enriched.contentSource, /linked_page/);
  assert.equal(enriched.linkedPages, 1);
});

test('retains attached images and alt text for multimodal editorial review', async () => {
  const item = {
    sourceKind: 'primary_x', description: 'Important update', expandedUrls: [], embeddedContent: '',
    media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/update.jpg', altText: 'Withdrawals paused after exploit' }],
  };
  assert.equal(hasReviewableXContent(item), true);
  const enriched = await enrichXPostContent(item);
  assert.deepEqual(enriched.imageUrls, ['https://pbs.twimg.com/media/update.jpg']);
  assert.match(enriched.description, /Withdrawals paused/);
  assert.match(enriched.contentSource, /attached_images/);
});

test('uses a video preview frame as visual evidence', async () => {
  const item = {
    sourceKind: 'primary_x', description: 'Watch our announcement', expandedUrls: [], embeddedContent: '',
    media: [{ type: 'video', previewImageUrl: 'https://pbs.twimg.com/media/video-preview.jpg', altText: '' }],
  };
  const enriched = await enrichXPostContent(item);
  assert.deepEqual(enriched.imageUrls, ['https://pbs.twimg.com/media/video-preview.jpg']);
});
