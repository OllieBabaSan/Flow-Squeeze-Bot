import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBreakoutFeed } from '../lib/breakout-feed.mjs';

test('ranks live breakout candidates by direction without exposing runtime state', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const candidate = (symbol, direction, clearanceAtr, directedReturn15mPct) => ({
    key: `Bybit:${symbol}`,
    market: { symbol, venue: 'Bybit', price: 100, turnover24h: 5_000_000, change24hPct: direction === 'BEARISH' ? -1 : 1 },
    breakout: { direction, clearanceAtr, directedReturn15mPct, directedReturn60mPct: directedReturn15mPct / 2, atrPct: 0.2, boundary: 99, derivativesContext: 'STABLE_OPEN_INTEREST', channelWidthAtr: 5, oiChangePct: 0.1 },
    series: { bars: [{ close: 99 }, { close: 100 }] },
    firstSeenAt: now - 60_000,
  });
  const coverage = { observerRawMarketCount: 900, sourceVenueCounts: { Bybit: 500 }, eligibleSourceVenueCounts: { Bybit: 400 } };
  const feed = buildBreakoutFeed({ active: [candidate('BTC', 'BEARISH', 1, 0.4), candidate('ETH', 'BULLISH', 2, 0.8)], now, marketCount: 833, coverage });
  assert.equal(feed.bullish[0].symbol, 'ETH');
  assert.equal(feed.bearish[0].symbol, 'BTC');
  assert.equal(feed.bearish[0].ageSeconds, 60);
  assert.deepEqual(feed.bullish[0].path, [99, 100]);
  assert.equal('series' in feed.bullish[0], false);
  assert.deepEqual(feed.coverage, coverage);
});

test('keeps active major markets available to the dashboard major filter', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const make = (symbol, clearanceAtr) => ({
    key: `Bybit:${symbol}`,
    market: { symbol, venue: 'Bybit', price: 100, turnover24h: 5_000_000, change24hPct: -1 },
    breakout: { direction: 'BEARISH', clearanceAtr, directedReturn15mPct: clearanceAtr, directedReturn60mPct: 0.1, atrPct: 0.2, boundary: 101, derivativesContext: 'STABLE_OPEN_INTEREST', channelWidthAtr: 5 },
    series: { bars: [{ close: 101 }, { close: 100 }] },
  });
  const feed = buildBreakoutFeed({ active: [make('ALT', 4), make('BTC', 0.2)], now, limitPerSide: 1 });
  assert.deepEqual(feed.bearish.map(candidate => candidate.symbol), ['ALT', 'BTC']);
});

test('labels a short bullish break against bearish 60-minute and 24-hour context as countertrend', () => {
  const feed = buildBreakoutFeed({ active: [{
    key: 'Hyperliquid:HYPE',
    market: { symbol: 'HYPE', venue: 'Hyperliquid', price: 88, turnover24h: 250_000_000, change24hPct: -1.2 },
    breakout: { direction: 'BULLISH', clearanceAtr: 1.2, directedReturn15mPct: 0.4, directedReturn60mPct: -0.5, atrPct: 0.2, boundary: 87.8, derivativesContext: 'STABLE_OPEN_INTEREST', channelWidthAtr: 5 },
    series: { bars: [{ close: 87.8 }, { close: 88 }] },
  }] });
  assert.equal(feed.bullish[0].trendAlignment, 'COUNTERTREND');
  assert.equal(feed.bullish[0].intermediateTrend, 'OPPOSED');
  assert.equal(feed.bullish[0].broadTrend, 'OPPOSED');
});

test('attaches verified destination listings and venue execution context', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const active = [{
    key: 'Bybit:RPL',
    market: { symbol: 'RPL', venue: 'Bybit', price: 4, turnover24h: 5_000_000, change24hPct: 1 },
    breakout: { direction: 'BULLISH', clearanceAtr: 1, directedReturn15mPct: 0.4, directedReturn60mPct: 0.2, atrPct: 0.2, boundary: 3.9, derivativesContext: 'STABLE_OPEN_INTEREST', channelWidthAtr: 5 },
    series: { bars: [{ close: 3.9 }, { close: 4 }] },
  }];
  const destinationCatalogs = {
    bybit: new Map([['RPL', { symbol: 'RPL', venueSymbol: 'RPLUSDT', price: 4, turnover24h: 12_000_000, bestBid: 3.99, bestAsk: 4.01 }]]),
    hyperliquid: new Map(),
    binance: new Map([['RPL', { symbol: 'RPL', venueSymbol: 'RPLUSDT', price: 4.02, turnover24h: 9_000_000, bestBid: 4.01, bestAsk: 4.03 }]]),
  };
  const feed = buildBreakoutFeed({ active, destinationCatalogs, now });
  assert.deepEqual(feed.bullish[0].tradableVenues, ['Bybit', 'Binance']);
  assert.equal(feed.bullish[0].destinations.bybit.symbol, 'RPLUSDT');
  assert.ok(feed.bullish[0].destinations.bybit.spreadBps > 0);
  assert.equal(feed.bullish[0].destinations.hyperliquid, undefined);
});
