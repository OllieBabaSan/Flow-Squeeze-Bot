import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { advancePressureLifecycle, evaluateDirectionalPressure } from '../lib/directional-pressure.mjs';

const hours = Math.max(6, Math.min(72, Number(process.env.PRESSURE_BACKTEST_HOURS || 24)));
const marketLimit = Math.max(5, Math.min(100, Number(process.env.PRESSURE_BACKTEST_MARKETS || 40)));
const horizons = [5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];
const now = Date.now(), start = now - hours * 3600_000;
const pressureOptions = {
  confirmedPressureScore: Number(process.env.PRESSURE_CONFIRMED_SCORE || 60),
  confirmedExpansionScore: Number(process.env.PRESSURE_EXPANSION_SCORE || 60),
};
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

const tickerPayload = await json('https://futures.kraken.com/derivatives/api/v3/tickers');
const aliases = { XBT: 'BTC' };
const markets = (tickerPayload.tickers || []).flatMap(row => {
  const [base, quote] = String(row.pair || '').split(':');
  if (row.tag !== 'perpetual' || row.suspended || quote !== 'USD' || Number(row.volumeQuote) < 5_000_000) return [];
  return [{ symbol: aliases[base] || base, venueSymbol: row.symbol, turnover24h: Number(row.volumeQuote) }];
}).sort((a, b) => b.turnover24h - a.turnover24h).slice(0, marketLimit);

async function historyFor(market) {
  const from = Math.floor(start / 1000), to = Math.ceil(now / 1000);
  const [candlePayload, oiPayload] = await Promise.all([
    json(`https://futures.kraken.com/api/charts/v1/trade/${encodeURIComponent(market.venueSymbol)}/1m?from=${from}&to=${to}`),
    json(`https://futures.kraken.com/api/charts/v1/analytics/${encodeURIComponent(market.venueSymbol)}/open-interest?since=${from}&to=${to}&interval=60`),
  ]);
  const oi = new Map((oiPayload?.result?.timestamp || []).map((timestamp, index) => [Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp), Number(oiPayload.result.data?.[index]?.[3])]));
  let lastOi = null;
  return (candlePayload.candles || []).map(candle => {
    if (oi.has(Number(candle.time))) lastOi = oi.get(Number(candle.time));
    return { observedAt: Number(candle.time), price: Number(candle.close), high: Number(candle.high), low: Number(candle.low), openInterest: lastOi, intervalTurnoverUsd: Number(candle.volume || 0) * Number(candle.close), tradeCount: null, aggressiveBuyRatio: null, bookImbalance: null };
  }).filter(row => row.openInterest > 0);
}

const results = [], episodes = [], failures = [];
for (let offset = 0; offset < markets.length; offset += 5) {
  const batch = markets.slice(offset, offset + 5);
  const fetched = await Promise.allSettled(batch.map(async market => ({ market, rows: await historyFor(market) })));
  for (const item of fetched) {
    if (item.status === 'rejected') { failures.push(String(item.reason)); continue; }
    const { market, rows } = item.value;
    const history = [];
    let lifecycle = null;
    let activeEpisode = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index], detection = evaluateDirectionalPressure(history, row, market, pressureOptions);
      lifecycle = advancePressureLifecycle(lifecycle, detection, row.observedAt);
      if (activeEpisode) {
        const favorable = ((activeEpisode.direction === 'BEARISH' ? activeEpisode.entryPrice / row.low : row.high / activeEpisode.entryPrice) - 1) * 100;
        const adverse = ((activeEpisode.direction === 'BEARISH' ? activeEpisode.entryPrice / row.high : row.low / activeEpisode.entryPrice) - 1) * 100;
        activeEpisode.maxFavorablePct = Math.max(activeEpisode.maxFavorablePct, favorable);
        activeEpisode.maxAdversePct = Math.min(activeEpisode.maxAdversePct, adverse);
      }
      if (lifecycle.event) {
        const event = { symbol: market.symbol, venue: 'Kraken', at: new Date(row.observedAt).toISOString(), entryPrice: row.price, ...detection, state: lifecycle.state, direction: lifecycle.direction, outcomes: {} };
        for (const horizon of horizons) {
          const future = rows[index + horizon];
          if (!future) continue;
          const raw = (future.price / row.price - 1) * 100;
          event.outcomes[horizon] = raw * (detection.direction === 'BEARISH' ? -1 : 1);
        }
        const futureRows = rows.slice(index + 1, index + 721);
        event.maxFavorablePct = futureRows.length ? Math.max(...futureRows.map(future => ((lifecycle.direction === 'BEARISH' ? row.price / future.low : future.high / row.price) - 1) * 100)) : null;
        event.maxAdversePct = futureRows.length ? Math.min(...futureRows.map(future => ((lifecycle.direction === 'BEARISH' ? row.price / future.high : future.low / row.price) - 1) * 100)) : null;
        const targetIndex = futureRows.findIndex(future => ((lifecycle.direction === 'BEARISH' ? row.price / future.low : future.high / row.price) - 1) * 100 >= 1);
        const stopIndex = futureRows.findIndex(future => ((lifecycle.direction === 'BEARISH' ? row.price / future.high : future.low / row.price) - 1) * 100 <= -0.5);
        event.targetBeforeStop = targetIndex >= 0 && (stopIndex < 0 || targetIndex < stopIndex);
        event.minutesToTarget = targetIndex >= 0 ? targetIndex + 1 : null;
        results.push(event);
        if (['CONFIRMED_MOMENTUM', 'RESUMED_MOMENTUM'].includes(lifecycle.state) && !activeEpisode) {
          activeEpisode = { symbol: market.symbol, venue: 'Kraken', entryState: lifecycle.state, direction: lifecycle.direction, entryAt: row.observedAt, entryPrice: row.price, weakeningAt: null, maxFavorablePct: 0, maxAdversePct: 0 };
        } else if (lifecycle.state === 'MOMENTUM_WEAKENING' && activeEpisode && !activeEpisode.weakeningAt) {
          activeEpisode.weakeningAt = row.observedAt;
        } else if (lifecycle.state === 'MOMENTUM_STABILIZED' && activeEpisode) {
          activeEpisode.falseWeakening = true;
          activeEpisode.weakeningAt = null;
        } else if (['MOMENTUM_LOSS', 'MOMENTUM_ENDED'].includes(lifecycle.state) && activeEpisode) {
          const raw = (row.price / activeEpisode.entryPrice - 1) * 100;
          const capturedReturnPct = raw * (activeEpisode.direction === 'BEARISH' ? -1 : 1);
          episodes.push({ ...activeEpisode, exitState: lifecycle.state, exitAt: row.observedAt, exitPrice: row.price, durationMinutes: (row.observedAt - activeEpisode.entryAt) / 60_000, warningLeadMinutes: activeEpisode.weakeningAt ? (row.observedAt - activeEpisode.weakeningAt) / 60_000 : null, capturedReturnPct, givebackPct: activeEpisode.maxFavorablePct - capturedReturnPct });
          activeEpisode = null;
        }
      }
      history.push(row);
      if (history.length > 120) history.shift();
    }
  }
  await sleep(250);
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const summarize = cohort => Object.fromEntries(horizons.map(horizon => {
  const values = cohort.map(event => event.outcomes[horizon]).filter(Number.isFinite);
  return [`${horizon}m`, { n: values.length, directionalAccuracyPct: values.length ? values.filter(value => value > 0).length / values.length * 100 : null, atLeastOnePctPct: values.length ? values.filter(value => value >= 1).length / values.length * 100 : null, medianReturnPct: values.length ? median(values) : null, meanReturnPct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null }];
}));
const excursions = cohort => {
  const favorable = cohort.map(event => event.maxFavorablePct).filter(Number.isFinite);
  const adverse = cohort.map(event => event.maxAdversePct).filter(Number.isFinite);
  const resolved = cohort.filter(event => event.maxFavorablePct != null);
  return { medianMaxFavorablePct: favorable.length ? median(favorable) : null, atLeastOnePctOpportunityPct: favorable.length ? favorable.filter(value => value >= 1).length / favorable.length * 100 : null, targetBeforeStopPct: resolved.length ? resolved.filter(event => event.targetBeforeStop).length / resolved.length * 100 : null, medianMinutesToTarget: cohort.some(event => event.minutesToTarget != null) ? median(cohort.map(event => event.minutesToTarget).filter(Number.isFinite)) : null, medianMaxAdversePct: adverse.length ? median(adverse) : null };
};
const states = [...new Set(results.map(event => event.state))];
const report = {
  generatedAt: new Date().toISOString(), source: 'Kraken Futures', periodHours: hours, marketsRequested: markets.length, failures: failures.length, pressureOptions,
  limitations: ['Historical aggressor flow, trade count, and order-book imbalance are not included', 'Results exclude fees, spread, slippage, and execution latency', 'Kraken is the historical test source; Hyperliquid remains the primary live venue', 'One market regime and a short lookback cannot establish durable predictive value', 'Long horizons have fewer completed samples near the end of the test', 'Live shadow results are authoritative'],
  eventCount: results.length, overall: summarize(results),
  episodes: {
    count: episodes.length,
    profitablePct: episodes.length ? episodes.filter(episode => episode.capturedReturnPct > 0).length / episodes.length * 100 : null,
    averageCapturedReturnPct: episodes.length ? episodes.reduce((sum, episode) => sum + episode.capturedReturnPct, 0) / episodes.length : null,
    medianCapturedReturnPct: episodes.length ? median(episodes.map(episode => episode.capturedReturnPct)) : null,
    medianDurationMinutes: episodes.length ? median(episodes.map(episode => episode.durationMinutes)) : null,
    medianGivebackPct: episodes.length ? median(episodes.map(episode => episode.givebackPct)) : null,
    medianWarningLeadMinutes: episodes.some(episode => episode.warningLeadMinutes != null) ? median(episodes.map(episode => episode.warningLeadMinutes).filter(Number.isFinite)) : null,
    records: episodes,
  },
  excursions: excursions(results),
  byState: Object.fromEntries(states.map(state => { const cohort = results.filter(event => event.state === state); return [state, { events: cohort.length, excursions: excursions(cohort), horizons: summarize(cohort) }]; })), events: results,
};
const outputDir = resolve('outputs', 'directional-pressure');
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'backtest.json'), JSON.stringify(report, null, 2));
const lines = ['# Directional Pressure Backtest', '', `Generated: ${report.generatedAt}`, `Source: Kraken Futures`, `Period: ${hours} hours across ${markets.length} liquid perpetual markets`, `Recorded lifecycle events: ${results.length}`, `Completed momentum episodes: ${report.episodes.count}`, `Profitable completed episodes: ${report.episodes.profitablePct?.toFixed(1) ?? '—'}%`, `Median captured return: ${report.episodes.medianCapturedReturnPct?.toFixed(2) ?? '—'}%`, `Median episode duration: ${report.episodes.medianDurationMinutes?.toFixed(1) ?? '—'} minutes`, `Median peak giveback at exit: ${report.episodes.medianGivebackPct?.toFixed(2) ?? '—'}%`, '', 'The 4–12 hour columns are evaluation horizons, not holding-period rules. Episode results measure the actual confirmed-momentum to momentum-loss lifecycle.', '', '| State | Events | 15m accuracy | 2h accuracy | 4h accuracy | 12h accuracy | +1% before -0.5% |', '|---|---:|---:|---:|---:|---:|---:|', ...states.map(state => { const item = report.byState[state]; return `| ${state} | ${item.events} | ${item.horizons['15m'].directionalAccuracyPct?.toFixed(1) ?? '—'}% | ${item.horizons['120m'].directionalAccuracyPct?.toFixed(1) ?? '—'}% | ${item.horizons['240m'].directionalAccuracyPct?.toFixed(1) ?? '—'}% | ${item.horizons['720m'].directionalAccuracyPct?.toFixed(1) ?? '—'}% | ${item.excursions.targetBeforeStopPct?.toFixed(1) ?? '—'}% |`; }), '', 'Full event- and episode-level results are in `backtest.json`.'];
await writeFile(resolve(outputDir, 'REPORT.md'), lines.join('\n'));
console.log(JSON.stringify({ generatedAt: report.generatedAt, source: report.source, periodHours: hours, markets: markets.length, events: results.length, failures: failures.length, byState: report.byState }, null, 2));
