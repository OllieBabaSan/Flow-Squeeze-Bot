import test from 'node:test';
import assert from 'node:assert/strict';
import { findPerpDexVenues, normalizeAsterCatalog, normalizeGmxCatalog, normalizeLighterCatalog, perpDexAlertField } from '../lib/perp-dex-discovery.mjs';

test('keeps only currently trading Aster perpetuals', () => {
  const markets = normalizeAsterCatalog({ symbols: [
    { symbol: 'RAREUSDT', baseAsset: 'RARE', status: 'TRADING', contractType: 'PERPETUAL' },
    { symbol: 'OLDUSDT', baseAsset: 'OLD', status: 'SETTLING', contractType: 'PERPETUAL' },
  ] });
  assert.deepEqual(markets, [{ symbol: 'RARE', contract: 'RAREUSDT' }]);
});

test('keeps listed GMX directional markets and ignores swap pools', () => {
  const markets = normalizeGmxCatalog({ markets: [
    { name: 'ARB/USD [ARB-USDC]', marketToken: '0xabc', isListed: true },
    { name: 'SWAP-ONLY [USDC-USDT]', marketToken: '0xdef', isListed: true },
  ] });
  assert.deepEqual(markets, [{ symbol: 'ARB', contract: '0xabc', chain: 'Arbitrum' }]);
});

test('keeps only active Lighter perpetuals with live identity prices', () => {
  const markets = normalizeLighterCatalog({ order_book_details: [
    { symbol: 'RAY', market_id: 77, market_type: 'perp', status: 'active', mark_price: '1.91', index_price: '1.90' },
    { symbol: 'ETH', market_id: 2048, market_type: 'spot', status: 'active', mark_price: '3000', index_price: '3000' },
    { symbol: 'OLD', market_id: 88, market_type: 'perp', status: 'inactive', mark_price: '1', index_price: '1' },
  ] });
  assert.deepEqual(markets, [{ symbol: 'RAY', contract: '77', markPrice: 1.91, indexPrice: 1.9 }]);
});

test('requires Lighter price agreement instead of trusting a ticker alone', () => {
  const catalogs = [{ name: 'Lighter', requirePriceMatch: true, markets: [{ symbol: 'Q', contract: '51', markPrice: 1, indexPrice: 1 }], tradeUrl: (_contract, market) => `https://lighter.test/${market.symbol}` }];
  assert.deepEqual(findPerpDexVenues('Q', [], catalogs, 0.0226), []);
  assert.equal(findPerpDexVenues('Q', [], catalogs, 1.01)[0].marketLabel, 'Q/USD perpetual');
});

test('finds the same symbol across live perp DEX catalogs', () => {
  const venues = findPerpDexVenues('RARE', [{ symbol: 'ETH', venue: 'Hyperliquid' }], [
    { name: 'Aster', markets: [{ symbol: 'RARE', contract: 'RAREUSDT' }], tradeUrl: contract => `https://aster.test/${contract}` },
  ]);
  assert.deepEqual(venues, [{ name: 'Aster', contract: 'RAREUSDT', marketLabel: 'RARE\/USDT perpetual', url: 'https://aster.test/RAREUSDT' }]);
  assert.match(perpDexAlertField(venues), /Aster · RARE\/USDT perpetual/);
});
