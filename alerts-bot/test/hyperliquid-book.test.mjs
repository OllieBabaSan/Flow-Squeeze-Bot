import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHyperliquidTopOfBook } from '../lib/hyperliquid-book.mjs';

test('normalizes the best Hyperliquid bid and ask', () => {
  const result = normalizeHyperliquidTopOfBook({ levels: [
    [{ px: '99.9', sz: '10' }, { px: '99.8', sz: '20' }],
    [{ px: '100.1', sz: '12' }, { px: '100.2', sz: '30' }],
  ] }, 1234);
  assert.deepEqual(result, {
    bestBid: 99.9,
    bestAsk: 100.1,
    bookObservedAt: 1234,
    spreadSource: 'HYPERLIQUID_L2_BOOK',
  });
});

test('rejects crossed or incomplete books', () => {
  assert.equal(normalizeHyperliquidTopOfBook({ levels: [[{ px: '101' }], [{ px: '100' }]] }), null);
  assert.equal(normalizeHyperliquidTopOfBook({ levels: [[], []] }), null);
});
