import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarkets, normalizeOrderbook } from '../src/dydx.mjs';
import { quoteForNotional, summarizeBook } from '../src/executable-quote.mjs';

test('normalizes dYdX markets keyed by base asset', () => {
  const markets = normalizeMarkets({ markets: { 'BTC-USD': { ticker: 'BTC-USD', oraclePrice: '100', openInterest: '20' } } });
  assert.equal(markets.get('BTC').ticker, 'BTC-USD');
  assert.equal(markets.get('BTC').oraclePrice, 100);
});

test('normalizes and sorts an order book', () => {
  const book = normalizeOrderbook({ bids: [{ price: '99', size: '2' }, { price: '100', size: '1' }], asks: [{ price: '102', size: '2' }, { price: '101', size: '1' }] });
  assert.equal(book.bids[0].price, 100);
  assert.equal(book.asks[0].price, 101);
});

test('computes size-aware executable VWAP and partial fill', () => {
  const book = { bids: [{ price: 99, size: 10 }], asks: [{ price: 100, size: 1 }, { price: 101, size: 1 }] };
  const quote = quoteForNotional(book, 'BUY', 150);
  assert.equal(quote.fillRatio, 1);
  assert.ok(quote.vwap > 100 && quote.vwap < 101);
  const summary = summarizeBook(book, 5000);
  assert.ok(summary.buy.fillRatio < 1);
  assert.equal(summary.spreadBps, (1 / 99.5) * 10000);
});
