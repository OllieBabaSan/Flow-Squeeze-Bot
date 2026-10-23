import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('standalone launcher has no X, news, pressure, model, or sibling-product runtime dependency', async () => {
  const source = await readFile(new URL('../scripts/local-radar.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'analysis-engine', 'article-content', 'directional-pressure', 'editorial-gate',
    'x-primary-source', 'x-post-content', 'news-delivery', 'runtime-plan',
    'crypto-news-radar', '../Flow', '../Pressure', '../X-Alerts',
  ]) assert.equal(source.includes(forbidden), false, `unexpected dependency: ${forbidden}`);
  assert.match(source, /flow-state\.json/);
  assert.match(source, /flow-squeeze\.lock/);
  assert.match(source, /flow-alert-history\.jsonl/);
});
