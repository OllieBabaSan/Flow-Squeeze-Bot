import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarketStatus } from '../lib/market-classification.mjs';

test('classifies an upcoming listing without market data as untracked and pre-market', () => {
  const result = classifyMarketStatus({ eventType: 'Listing', token: 'INF8', title: 'Biconomy confirms upcoming listing for $INF8', market: null });
  assert.deepEqual(result.labels, ['UNTRACKED', 'PRE-MARKET']);
  assert.equal(result.chain, 'Solana (SPL)');
});

test('detects chain language without guessing when none is available', () => {
  assert.equal(classifyMarketStatus({ eventType: 'Listing', token: 'NEW', description: 'An ERC-20 token on Ethereum' }).chain, 'Ethereum (ERC-20)');
  assert.equal(classifyMarketStatus({ eventType: 'Listing', token: 'UNKNOWN' }).chain, 'Not identified — verify source');
});

test('classifies an established priced asset as live market', () => {
  const result = classifyMarketStatus({ eventType: 'Listing', title: 'Coinbase lists token today', market: { symbol: 'TEST' } });
  assert.equal(result.label, 'LIVE MARKET');
});

test('does not call an unpriced non-listing catalyst pre-market', () => {
  const result = classifyMarketStatus({ eventType: 'Product / upgrade', title: '$TEST launches mainnet', market: null });
  assert.deepEqual(result.labels, ['UNTRACKED']);
});

test('identifies MON as the native token of Monad', () => {
  const result = classifyMarketStatus({ eventType: 'Product / upgrade', token: 'MON', title: 'Monad network upgrade', market: { symbol: 'MON' } });
  assert.equal(result.chain, 'Monad');
});
