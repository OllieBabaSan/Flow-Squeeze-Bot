import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchMarkets } from '../src/hyperliquid.mjs';

const root = resolve('..');
const archivePath = resolve(root, 'crypto-news-radar/data/alert-outcomes-archive.jsonl');
const activePath = resolve(root, 'crypto-news-radar/data/alert-outcomes.json');
const config = JSON.parse(await readFile(resolve('config.json'), 'utf8'));
const archive = (await readFile(archivePath, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const active = Object.values(JSON.parse(await readFile(activePath, 'utf8')).records || {});
const records = [...new Map([...archive, ...active].filter(row => row.kind === 'flow').map(row => [row.id, row])).values()]
  .filter(row => row.trigger && ['BULLISH', 'BEARISH'].includes(row.direction));
const liveUniverse = new Set((await fetchMarkets()).keys());
const horizons = [1, 3, 5, 10, 15, 30, 60, 120, 240];
const costPct = (config.takerFeeRate * 2 + config.slippageBpsPerSide * 2 / 10_000) * 100;
const finite = value => Number.isFinite(Number(value));
const median = values => { const sorted = values.filter(finite).map(Number).sort((a, b) => a - b); if (!sorted.length) return null; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const kindOf = record => ['crowded_shorts', 'crowded_longs'].includes(record.trigger.reason) ? 'SQUEEZE_PRESSURE' : 'FLOW';
const returnAt = (record, horizon) => record.horizons?.[horizon]?.directedReturnPct;
const relativeReturn = (fromPct, toPct) => ((1 + toPct / 100) / (1 + fromPct / 100) - 1) * 100;

function simulate(record) {
  const kind = kindOf(record);
  const timeStopMinutes = kind === 'SQUEEZE_PRESSURE'
    ? config.timeStopMinutesSqueezePressure
    : record.direction === 'BULLISH' ? config.timeStopMinutesBullishFlow : config.timeStopMinutesBearishFlow;
  const required = kind === 'SQUEEZE_PRESSURE' ? config.minimumSqueezeConfirmationMovePct : config.minimumConfirmationMovePct;
  let entryHorizon = null, entryAlertReturnPct = null, rejectionReason = 'INSUFFICIENT_CONFIRMATION';
  for (const horizon of [1, 3, 5]) {
    const value = returnAt(record, horizon);
    if (!finite(value)) continue;
    if (value > config.maximumAdditionalMoveBeforeEntryPct) { rejectionReason = 'MOVE_ALREADY_EXTENDED'; break; }
    if (value < -config.maximumAdverseMoveBeforeEntryPct) { rejectionReason = 'MOVED_AGAINST_ALERT'; break; }
    if (value >= required) { entryHorizon = horizon; entryAlertReturnPct = value; break; }
  }
  if (entryHorizon == null) return { entered: false, rejectionReason, kind };
  let peakPct = 0, maxAdversePct = 0, exitHorizon = null, exitReason = 'MAXIMUM_HOLD_TIME', grossPct = null;
  for (const horizon of horizons.filter(value => value > entryHorizon)) {
    const alertReturn = returnAt(record, horizon);
    if (!finite(alertReturn)) continue;
    const progress = relativeReturn(entryAlertReturnPct, alertReturn);
    peakPct = Math.max(peakPct, progress);
    maxAdversePct = Math.min(maxAdversePct, progress);
    if (progress <= -config.stopLossPct) { exitHorizon = horizon; exitReason = 'HARD_STOP'; grossPct = progress; break; }
    if (progress >= config.takeProfitPct) { exitHorizon = horizon; exitReason = 'TARGET_REACHED'; grossPct = progress; break; }
    if (peakPct >= config.trailingActivationPct && peakPct - progress >= config.trailingGivebackPct) { exitHorizon = horizon; exitReason = 'TRAILING_STOP'; grossPct = progress; break; }
    if (horizon >= timeStopMinutes && peakPct < config.minimumTimeStopProgressPct) { exitHorizon = horizon; exitReason = 'TIME_STOP_NO_MOVEMENT'; grossPct = progress; break; }
    if (horizon >= config.maximumHoldMinutes) { exitHorizon = horizon; grossPct = progress; break; }
  }
  if (grossPct == null) {
    const last = [...horizons].reverse().find(horizon => horizon > entryHorizon && finite(returnAt(record, horizon)));
    if (last == null) return { entered: false, rejectionReason: 'INCOMPLETE_OUTCOME_DATA', kind };
    exitHorizon = last;
    grossPct = relativeReturn(entryAlertReturnPct, returnAt(record, last));
    exitReason = 'LAST_AVAILABLE_CHECKPOINT';
  }
  const netPct = grossPct - costPct;
  return { entered: true, kind, entryHorizon, entryAlertReturnPct, exitHorizon, exitReason, grossPct, netPct, rMultiple: netPct / config.stopLossPct, peakPct, maxAdversePct };
}

const rows = records.map(record => ({
  id: record.id, symbol: record.symbol, venue: record.venue, direction: record.direction,
  reason: record.trigger.reason, currentlyOnHyperliquid: liveUniverse.has(record.symbol),
  triggerMovePct: record.trigger.movePct, ...simulate(record),
  savedReturns: Object.fromEntries(horizons.filter(horizon => finite(returnAt(record, horizon))).map(horizon => [horizon, returnAt(record, horizon)])),
}));

function metrics(cohort) {
  const entries = cohort.filter(row => row.entered), rejected = cohort.filter(row => !row.entered);
  const values = entries.map(row => row.netPct);
  const wins = values.filter(value => value > 0), losses = values.filter(value => value <= 0);
  const grossWins = wins.reduce((sum, value) => sum + value, 0), grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const rejectionCounterfactuals = Object.fromEntries([15, 60, 240].map(horizon => {
    const valuesAtHorizon = rejected.map(row => row.savedReturns?.[horizon]).filter(finite).map(Number);
    return [horizon, { n: valuesAtHorizon.length, directionCorrectPct: valuesAtHorizon.length ? valuesAtHorizon.filter(value => value > 0).length / valuesAtHorizon.length * 100 : null, meanDirectedReturnPct: valuesAtHorizon.length ? valuesAtHorizon.reduce((sum, value) => sum + value, 0) / valuesAtHorizon.length : null, medianDirectedReturnPct: median(valuesAtHorizon) }];
  }));
  let equity = config.initialEquityUsd, peak = equity, maximumDrawdownPct = 0;
  for (const row of entries.sort((a, b) => records.find(r => r.id === a.id).entryAt.localeCompare(records.find(r => r.id === b.id).entryAt))) {
    equity *= 1 + row.rMultiple * config.riskPerTradePct / 100;
    peak = Math.max(peak, equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (equity / peak - 1) * 100);
  }
  return {
    alerts: cohort.length, entries: entries.length, rejected: rejected.length,
    winRatePct: entries.length ? wins.length / entries.length * 100 : null,
    meanNetPct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    medianNetPct: median(values), averageR: entries.length ? entries.reduce((sum, row) => sum + row.rMultiple, 0) / entries.length : null,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    projectedEndingEquityAt1PctRisk: equity, projectedReturnPctAt1PctRisk: (equity / config.initialEquityUsd - 1) * 100,
    maximumDrawdownPctAt1PctRisk: maximumDrawdownPct,
    rejectionReasons: Object.fromEntries([...new Set(rejected.map(row => row.rejectionReason))].sort().map(reason => [reason, rejected.filter(row => row.rejectionReason === reason).length])),
    exitReasons: Object.fromEntries([...new Set(entries.map(row => row.exitReason))].sort().map(reason => [reason, entries.filter(row => row.exitReason === reason).length])),
    rejectionCounterfactuals,
  };
}

const strict = rows.filter(row => row.venue === 'Hyperliquid');
const broad = rows.filter(row => row.currentlyOnHyperliquid);
const report = {
  generatedAt: new Date().toISOString(), alertPeriod: { first: records.map(row => row.entryAt).sort()[0], last: records.map(row => row.entryAt).sort().at(-1) },
  methodology: {
    universe: 'Strict cohort uses Hyperliquid-origin alerts. Broad cohort uses assets in the current Hyperliquid catalog, which introduces survivorship/listing-timing uncertainty.',
    entry: 'First saved 1m/3m/5m checkpoint satisfying confirmation, adverse-move, and extension rules.',
    exit: 'First saved checkpoint satisfying hard stop, target, trailing, time stop, or 240m maximum.',
    costs: `${costPct.toFixed(3)}% round trip for base taker fees and modeled slippage; historical spread unavailable and therefore omitted.`,
    squeezeCaveat: 'Saved post-alert open interest is unavailable. Squeeze Pressure results are a price-confirmation upper bound and do not enforce the live bot covering requirement.',
    pathCaveat: 'Checkpoint data cannot establish the ordering of stop, target, and trailing events between observations.',
  },
  allSavedAlerts: metrics(rows), strictHyperliquidOrigin: metrics(strict), currentlyHyperliquidListedApproximation: metrics(broad),
  breakdown: {
    strictFlow: metrics(strict.filter(row => row.kind === 'FLOW')),
    strictSqueezePressureUpperBound: metrics(strict.filter(row => row.kind === 'SQUEEZE_PRESSURE')),
    strictBullish: metrics(strict.filter(row => row.direction === 'BULLISH')),
    strictBearish: metrics(strict.filter(row => row.direction === 'BEARISH')),
  }, rows,
};
await mkdir(resolve('reports'), { recursive: true });
await writeFile(resolve('reports/historical-screen.json'), `${JSON.stringify(report, null, 2)}\n`);
const m = report.strictHyperliquidOrigin;
const md = `# Flow/Squeeze Paper Strategy — Historical Issue Screen\n\nGenerated: ${report.generatedAt}\n\nThis is a coarse falsification screen, not an execution-grade backtest.\n\n## Strict Hyperliquid-origin cohort\n\n- Alerts: ${m.alerts}\n- Approximate entries: ${m.entries}\n- Rejected: ${m.rejected}\n- Win rate: ${m.winRatePct?.toFixed(2) ?? 'n/a'}%\n- Mean net move: ${m.meanNetPct?.toFixed(3) ?? 'n/a'}%\n- Median net move: ${m.medianNetPct?.toFixed(3) ?? 'n/a'}%\n- Average R: ${m.averageR?.toFixed(3) ?? 'n/a'}\n- Profit factor: ${m.profitFactor?.toFixed(3) ?? 'n/a'}\n- Projected return at 1% risk: ${m.projectedReturnPctAt1PctRisk?.toFixed(2) ?? 'n/a'}%\n- Projected maximum drawdown: ${m.maximumDrawdownPctAt1PctRisk?.toFixed(2) ?? 'n/a'}%\n\n## Critical limitations\n\n- Historical spread is unavailable.\n- Intracheckpoint event order is unknown.\n- Post-alert OI contraction is unavailable, so squeeze results are an upper bound.\n- Current-listing filters cannot prove historical Hyperliquid availability.\n\nSee historical-screen.json for cohorts and event-level results.\n`;
await writeFile(resolve('reports/HISTORICAL_SCREEN.md'), md);
console.log(JSON.stringify({ strictHyperliquidOrigin: report.strictHyperliquidOrigin, currentlyHyperliquidListedApproximation: report.currentlyHyperliquidListedApproximation, breakdown: report.breakdown }, null, 2));
