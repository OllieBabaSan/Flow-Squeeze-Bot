export const REGIME_DEFAULTS = {
  minimumBreadthMarkets: 30,
  bearishBenchmarkPct: -1.5,
  severeBenchmarkPct: -4,
  bearishBreadthRatio: 0.62,
  severeBreadthRatio: 0.72,
  bearishBullishMovePct: 1.25,
  bearishBullishFreshTurnoverUsd: 500_000,
  bearishBullishFlowOiGrowthPct: 1,
  bearishBullishSqueezeOiGrowthPct: 0.3,
};

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function classifyMarketRegime(markets = [], options = {}) {
  const rules = { ...REGIME_DEFAULTS, ...options };
  const canonical = new Map();
  for (const market of markets) {
    if (market?.shadow || !['Bybit', 'Hyperliquid'].includes(market?.venue)) continue;
    const change = Number(market.change24hPct);
    if (!market.symbol || !Number.isFinite(change)) continue;
    if (!canonical.has(market.symbol) || market.venue === 'Hyperliquid') canonical.set(market.symbol, { ...market, change24hPct: change });
  }
  const rows = [...canonical.values()];
  const benchmarkChanges = ['BTC', 'ETH'].map(symbol => Number(canonical.get(symbol)?.change24hPct)).filter(Number.isFinite);
  if (rows.length < rules.minimumBreadthMarkets || !benchmarkChanges.length) {
    return { state: 'UNKNOWN', reliable: false, marketCount: rows.length, benchmarkChangePct: median(benchmarkChanges), negativeBreadthRatio: null };
  }
  const benchmarkChangePct = median(benchmarkChanges);
  const negativeBreadthRatio = rows.filter(row => row.change24hPct < 0).length / rows.length;
  const positiveBreadthRatio = rows.filter(row => row.change24hPct > 0).length / rows.length;
  let state = 'NEUTRAL';
  if (benchmarkChangePct <= rules.severeBenchmarkPct
    || (benchmarkChangePct <= rules.bearishBenchmarkPct && negativeBreadthRatio >= rules.severeBreadthRatio)) state = 'SEVERE_RISK_OFF';
  else if (benchmarkChangePct <= rules.bearishBenchmarkPct || negativeBreadthRatio >= rules.bearishBreadthRatio) state = 'BEARISH';
  else if (benchmarkChangePct >= -rules.bearishBenchmarkPct && positiveBreadthRatio >= rules.bearishBreadthRatio) state = 'BULLISH';
  return { state, reliable: true, marketCount: rows.length, benchmarkChangePct, negativeBreadthRatio, positiveBreadthRatio };
}

export function evaluateRegimePublication(detection, regime, options = {}) {
  const rules = { ...REGIME_DEFAULTS, ...options };
  if (!detection?.eligible || detection.direction !== 'BULLISH' || !regime?.reliable || !['BEARISH', 'SEVERE_RISK_OFF'].includes(regime.state)) {
    return { publish: true, countertrend: false, reason: 'regime_allows' };
  }
  if (regime.state === 'SEVERE_RISK_OFF') {
    return { publish: false, countertrend: true, reason: 'severe_risk_off_bullish_suppressed' };
  }
  const squeeze = detection.reason === 'crowded_shorts';
  const requiredOiGrowthPct = squeeze ? rules.bearishBullishSqueezeOiGrowthPct : rules.bearishBullishFlowOiGrowthPct;
  const checks = {
    move: Math.abs(Number(detection.movePct)) >= rules.bearishBullishMovePct,
    turnover: Number(detection.freshTurnover) >= rules.bearishBullishFreshTurnoverUsd,
    openInterest: Number(detection.oiGrowthPct) >= requiredOiGrowthPct,
  };
  return {
    publish: Object.values(checks).every(Boolean),
    countertrend: true,
    reason: Object.values(checks).every(Boolean) ? 'bearish_regime_strong_countertrend' : 'bearish_regime_weak_bullish_confirmation',
    checks,
    required: { movePct: rules.bearishBullishMovePct, freshTurnoverUsd: rules.bearishBullishFreshTurnoverUsd, oiGrowthPct: requiredOiGrowthPct },
  };
}
