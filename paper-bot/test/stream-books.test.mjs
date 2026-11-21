import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDydxDelta } from '../src/stream-books.mjs';

test('reconstructs dYdX snapshot and applies size and deletion deltas', () => {
  let book = applyDydxDelta(null, { bids: [{ price: '100', size: '2' }], asks: [{ price: '101', size: '3' }] }, true);
  assert.equal(book.bids.get('100'), 2);
  book = applyDydxDelta(book, { bids: [['100', '0'], ['99', '4']], asks: [['101', '2']] }, false);
  assert.equal(book.bids.has('100'), false);
  assert.equal(book.bids.get('99'), 4);
  assert.equal(book.asks.get('101'), 2);
});
