import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFlowIgnition, isFlowPriceCandidate, normalizeBinanceMarkets, normalizeBitgetMarkets, normalizeBybitMarkets, normalizeHyperliquidMarkets, normalizeKrakenMarkets, normalizeOkxMarkets } from '../lib/flow-detector.mjs';

const now = Date.now();
const prior = { price: 0.005, turnover24h: 10_000_000, openInterest: 20_000_000, fundingRate: 0, observedAt: now - 60_000 };

test('detects fast move with crowded shorts', () => {
  const result = detectFlowIgnition({ price: 0.0051, turnover24h: 10_300_000, openInterest: 20_100_000, fundingRate: -0.001 }, prior, now);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'crowded_shorts');
  assert.equal(result.direction, 'BULLISH');
});

test('detects fast move with rising open interest', () => {
  const result = detectFlowIgnition({ price: 0.0051, turnover24h: 10_300_000, openInterest: 20_120_000, fundingRate: 0 }, prior, now);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'rising_open_interest');
  assert.equal(result.direction, 'BULLISH');
});

test('price appreciation alone cannot masquerade as open-interest growth',()=>{
  const result=detectFlowIgnition({price:0.0051,turnover24h:10_300_000,openInterest:20_000_000,fundingRate:0,intervalTurnoverUsd:300_000},prior,now);
  assert.equal(result.eligible,false);assert.equal(result.reason,'no_derivatives_confirmation');assert.equal(result.oiGrowthPct,0);
});

test('uses actual interval turnover when supplied',()=>{
  const result=detectFlowIgnition({price:0.0051,turnover24h:10_300_000,openInterest:22_000_000,fundingRate:0,intervalTurnoverUsd:100_000},prior,now);
  assert.equal(result.eligible,false);assert.equal(result.reason,'insufficient_fresh_turnover');
});

test('prefilter identifies only liquid short-window price candidates',()=>{
  assert.equal(isFlowPriceCandidate({price:0.0051,turnover24h:20_000_000,openInterest:20_120_000,fundingRate:0},prior,now),true);
  assert.equal(isFlowPriceCandidate({price:0.00502,turnover24h:20_000_000,openInterest:22_000_000,fundingRate:0},prior,now),false);
});

test('detects bearish long squeeze with crowded longs', () => {
  const result = detectFlowIgnition({ price: 0.0049, turnover24h: 10_300_000, openInterest: 20_100_000, fundingRate: 0.001 }, prior, now);
  assert.equal(result.eligible, true);
  assert.equal(result.direction, 'BEARISH');
  assert.equal(result.reason, 'crowded_longs');
});

test('detects bearish ignition with rapidly rising open interest', () => {
  const result = detectFlowIgnition({ price: 0.0049, turnover24h: 10_300_000, openInterest: 20_120_000, fundingRate: 0 }, prior, now);
  assert.equal(result.eligible, true);
  assert.equal(result.direction, 'BEARISH');
  assert.equal(result.reason, 'rising_open_interest');
});

test('rejects price move without derivatives confirmation', () => {
  const result = detectFlowIgnition({ price: 0.0051, turnover24h: 10_300_000, openInterest: 20_020_000, fundingRate: 0 }, prior, now);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'no_derivatives_confirmation');
});

test('rejects illiquid noise', () => {
  const result = detectFlowIgnition({ price: 0.0051, turnover24h: 50_000, openInterest: 22_000_000, fundingRate: -0.001 }, prior, now);
  assert.equal(result.eligible, false);
});

test('rejects marginal moves and weak open-interest growth under noise-reduced rules', () => {
  const marginalMove = detectFlowIgnition({ price: 0.00503, turnover24h: 10_300_000, openInterest: 22_000_000, fundingRate: 0 }, prior, now);
  assert.equal(marginalMove.eligible, false);
  assert.equal(marginalMove.reason, 'insufficient_move');
  const weakOi = detectFlowIgnition({ price: 0.0051, turnover24h: 10_300_000, openInterest: 20_050_000, fundingRate: 0 }, prior, now);
  assert.equal(weakOi.eligible, false);
  assert.equal(weakOi.reason, 'no_derivatives_confirmation');
});

test('does not publish an already extended move as an early warning', () => {
  const result = detectFlowIgnition({ price: 0.0054, turnover24h: 10_500_000, openInterest: 22_000_000, fundingRate: -0.001 }, prior, now);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'extended_move');
});

test('crowded funding without new open-interest participation is not predictive enough', () => {
  const result = detectFlowIgnition({ price: 0.0051, turnover24h: 10_300_000, openInterest: 20_010_000, fundingRate: -0.001 }, prior, now);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'no_derivatives_confirmation');
});

test('normalizes Bybit USDT perpetual markets', () => {
  const markets = normalizeBybitMarkets({ retCode: 0, result: { list: [
    { symbol: 'HYPEUSDT', lastPrice: '50', turnover24h: '2000000', openInterest: '100000', fundingRate: '-0.0006' },
    { symbol: 'BTCUSDC', lastPrice: '100000', turnover24h: '1', openInterest: '1', fundingRate: '0' },
  ] } }, now);
  assert.equal(markets.length, 1);
  assert.equal(markets[0].symbol, 'HYPE');
  assert.equal(markets[0].venue, 'Bybit');
});

test('normalizes Binance USDT perpetual markets for shadow evaluation', () => {
  const markets = normalizeBinanceMarkets({
    symbols: [{ symbol: 'HYPEUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING' }],
    tickers: [{ symbol: 'HYPEUSDT', lastPrice: '50', quoteVolume: '20000000' }],
    premiums: [{ symbol: 'HYPEUSDT', markPrice: '50.1', lastFundingRate: '-0.0006' }],
    openInterests: [{ symbol: 'HYPEUSDT', openInterest: '100000' }],
  }, now);
  assert.equal(markets.length, 1);
  assert.equal(markets[0].symbol, 'HYPE');
  assert.equal(markets[0].venue, 'Binance');
  assert.equal(markets[0].shadow, true);
  assert.equal(markets[0].fundingRate, -0.0006);
});

test('normalizes OKX USDT swaps for shadow evaluation', () => {
  const markets = normalizeOkxMarkets({
    tickers: [{ instId: 'HYPE-USDT-SWAP', last: '50', volCcy24h: '400000' }],
    openInterests: [{ instId: 'HYPE-USDT-SWAP', oiCcy: '100000' }],
    fundingRates: [{ instId: 'HYPE-USDT-SWAP', fundingRate: '-0.0006' }],
  }, now);
  assert.equal(markets.length, 1);
  assert.equal(markets[0].symbol, 'HYPE');
  assert.equal(markets[0].venue, 'OKX');
  assert.equal(markets[0].turnover24h, 20_000_000);
  assert.equal(markets[0].shadow, true);
});

test('normalizes Bitget USDT futures for shadow evaluation', () => {
  const markets = normalizeBitgetMarkets({ code: '00000', data: [
    { symbol: 'HYPEUSDT', markPrice: '50', turnover24h: '20000000', openInterest: '100000', fundingRate: '-0.0006' },
  ] }, now);
  assert.equal(markets.length, 1);
  assert.equal(markets[0].symbol, 'HYPE');
  assert.equal(markets[0].venue, 'Bitget');
  assert.equal(markets[0].shadow, true);
});

test('normalizes Hyperliquid contexts and converts hourly funding to an 8h equivalent', () => {
  const markets = normalizeHyperliquidMarkets([
    { universe: [{ name: 'HYPE' }, { name: 'OLD', isDelisted: true }] },
    [
      { markPx: '50', dayNtlVlm: '2000000', openInterest: '100000', funding: '-0.0001' },
      { markPx: '1', dayNtlVlm: '1000000', openInterest: '10', funding: '0' },
    ],
  ], now);
  assert.equal(markets.length, 1);
  assert.equal(markets[0].symbol, 'HYPE');
  assert.equal(markets[0].venue, 'Hyperliquid');
  assert.equal(markets[0].fundingRate, -0.0008);
});

test('normalizes Kraken perpetuals for shadow evaluation', () => {
  const markets = normalizeKrakenMarkets({ tickers: [
    { symbol: 'PF_XBTUSD', tag: 'perpetual', pair: 'XBT:USD', markPrice: 80_000, volumeQuote: 20_000_000, openInterest: 2_000, fundingRate: 0.8, suspended: false },
    { symbol: 'FF_XBTUSD', tag: 'month', pair: 'XBT:USD', markPrice: 80_000, volumeQuote: 20_000_000, openInterest: 2_000, fundingRate: 0, suspended: false },
  ] }, now);
  assert.equal(markets.length, 1);
  assert.equal(markets[0].symbol, 'BTC');
  assert.equal(markets[0].venue, 'Kraken');
  assert.equal(markets[0].shadow, true);
  assert.equal(markets[0].fundingRate, 0.00008);
});
