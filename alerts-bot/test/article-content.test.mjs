import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchArticleContent, textFromHtml } from '../lib/article-content.mjs';

test('extracts article text while dropping scripts and navigation',()=>{
  const text=textFromHtml('<nav>menu</nav><article><h1>Balancer update</h1><p>The protocol will wind down after a vote.</p></article><script>bad()</script>');
  assert.match(text,/Balancer update/);assert.doesNotMatch(text,/menu|bad\(\)/);
});
test('falls back to feed summary when article retrieval fails',async()=>{
  const result=await fetchArticleContent('https://example.invalid','Feed summary',{fetchImpl:async()=>{throw new Error('offline')}});
  assert.deepEqual(result,{text:'Feed summary',source:'feed_summary'});
});

