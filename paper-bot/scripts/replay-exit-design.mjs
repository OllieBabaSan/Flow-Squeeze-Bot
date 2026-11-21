import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchCandles } from '../src/hyperliquid.mjs';
import { replayFailure, replayPartial, replayTrail, summarizeReplay } from '../src/exit-design-replay.mjs';

const config = JSON.parse(await readFile(resolve('config.json'), 'utf8'));
const exclusions = config.analysisExclusionsFile ? JSON.parse(await readFile(resolve(config.analysisExclusionsFile), 'utf8')) : { signalIds: [] };
const excluded = new Set(exclusions.signalIds || []);
const events = (await readFile(resolve('data/events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const entries = new Map(events.filter(row => row.type === 'PAPER_ENTRY' && !excluded.has(row.signalId)).map(row => [row.signalId, row]));
const exits = events.filter(row => row.type === 'PAPER_EXIT' && !excluded.has(row.signalId));
const trades = [];
for (const exit of exits) {
  const entry = entries.get(exit.signalId); if (!entry) continue;
  const enteredAtMs = Date.parse(entry.at), exitedAtMs = Date.parse(exit.at);
  const candles = await fetchCandles(entry.symbol, enteredAtMs - 60_000, exitedAtMs + 60_000);
  const position = { ...entry, enteredAtMs };
  trades.push({ entry, exit, position, candles: candles.filter(row => row.timeMs <= exitedAtMs) });
}
const pathCoverage = trades.map(trade => ({
  signalId: trade.entry.signalId, symbol: trade.entry.symbol, heldMinutes: trade.exit.heldMinutes,
  candles: trade.candles.length, firstCandleAt: trade.candles[0]?.timeMs || null, lastCandleAt: trade.candles.at(-1)?.timeMs || null,
}));
const replayTrades = trades.filter(trade => trade.candles.length > 0);

const models = {};
for (const rule of config.exitDesignReplayRules || []) {
  const results = replayTrades.map(trade => ({ signalId: trade.entry.signalId, symbol: trade.entry.symbol, direction: trade.entry.direction, actualExitReason: trade.exit.reason, actualNetPnlUsd: trade.exit.netPnlUsd, shadow: replayFailure(trade.position, trade.candles, rule, trade.exit.netPnlUsd, config) }));
  models[rule.name] = { type: 'EARLY_FAILURE', rule, ...summarizeReplay(results), results };
}
const combinedRuleNames = ['FAIL_5M_NEG075_PEAK025', 'FAIL_10M_NEG050_PEAK050'];
const combinedRules = (config.exitDesignReplayRules || []).filter(rule => combinedRuleNames.includes(rule.name));
const combinedResults = replayTrades.map(trade => {
  const candidates = combinedRules.map(rule => ({ rule: rule.name, ...replayFailure(trade.position, trade.candles, rule, trade.exit.netPnlUsd, config) }))
    .filter(result => result.triggered).sort((a, b) => a.atMinutes - b.atMinutes);
  return {
    signalId: trade.entry.signalId, symbol: trade.entry.symbol, direction: trade.entry.direction,
    actualExitReason: trade.exit.reason, actualNetPnlUsd: trade.exit.netPnlUsd,
    shadow: candidates[0] || { triggered: false, netPnlUsd: trade.exit.netPnlUsd },
  };
});
models.COMBINED_CONSERVATIVE_FAILURE = { type: 'COMBINED_EARLY_FAILURE', rules: combinedRuleNames, ...summarizeReplay(combinedResults), results: combinedResults };
for (const givebackPct of [0.5, 0.625]) {
  const name = `TRAIL_GIVEBACK_${String(givebackPct).replace('.', '_')}`;
  const results = replayTrades.map(trade => ({ signalId: trade.entry.signalId, symbol: trade.entry.symbol, direction: trade.entry.direction, actualExitReason: trade.exit.reason, actualNetPnlUsd: trade.exit.netPnlUsd, shadow: replayTrail(trade.position, trade.candles, givebackPct, trade.exit.netPnlUsd, config) }));
  models[name] = { type: 'TRAILING_GIVEBACK', givebackPct, ...summarizeReplay(results), results };
}
for (const triggerPct of config.strengthShadowRules.partialProfit.triggerProgressVariantsPct) {
  for (const fraction of config.strengthShadowRules.partialProfit.fractionVariants) {
    const name = `PARTIAL_${Math.round(fraction * 100)}_AT_${String(triggerPct).replace('.', '_')}`;
    const results = replayTrades.map(trade => ({ signalId: trade.entry.signalId, symbol: trade.entry.symbol, direction: trade.entry.direction, actualExitReason: trade.exit.reason, actualNetPnlUsd: trade.exit.netPnlUsd, shadow: replayPartial(trade.position, trade.candles, triggerPct, fraction, trade.exit.exitPrice, trade.exit.netPnlUsd, config) }));
    models[name] = { type: 'PARTIAL_PROFIT', triggerPct, fraction, ...summarizeReplay(results), results };
  }
}
const ranked = Object.entries(models).map(([name, value]) => ({ name, type: value.type, triggers: value.triggers, improvementUsd: value.improvementUsd, shadowNetPnlUsd: value.shadowNetPnlUsd, actualWinnersCut: value.actualWinnersCut, losersImproved: value.losersImproved })).sort((a, b) => b.improvementUsd - a.improvementUsd);
const report = { generatedAt: new Date().toISOString(), analyticalTradeCount: trades.length, replayTradeCount: replayTrades.length, missingPathCount: trades.length - replayTrades.length, excludedSignalIds: [...excluded], pathCoverage, methodology: { path: 'Hyperliquid one-minute candle closes from entry through actual exit.', comparison: 'Each shadow substitutes its modeled exit only when triggered; otherwise it retains the actual paper exit.', costs: 'Modeled shadow exits include configured slippage and both taker fees.', limitations: ['Only trades with a retrievable candle path are included in replay metrics.', 'One-minute closes cannot establish intraminute event order.', 'Historical bid/ask depth and spread are unavailable.', 'This cohort generated the hypotheses and is not prospective validation.'] }, ranked, models };
await mkdir(resolve('reports'), { recursive: true });
await writeFile(resolve('reports/exit-design-replay.json'), `${JSON.stringify(report, null, 2)}\n`);
const lines = ['# Exit Design Replay', '', `Generated: ${report.generatedAt}`, '', `Analytical trades: ${report.analyticalTradeCount}`, `Trades with retrievable candle paths: ${report.replayTradeCount}`, `Missing historical paths: ${report.missingPathCount}`, '', 'This is a retrospective design screen, not validation.', '', '| Model | Type | Triggers | Improvement | Shadow net | Winners cut | Losers improved |', '|---|---:|---:|---:|---:|---:|---:|', ...ranked.map(row => `| ${row.name} | ${row.type} | ${row.triggers} | $${row.improvementUsd.toFixed(2)} | $${row.shadowNetPnlUsd.toFixed(2)} | ${row.actualWinnersCut} | ${row.losersImproved} |`), '', '## Limitations', '', ...report.methodology.limitations.map(value => `- ${value}`), ''];
await writeFile(resolve('reports/EXIT_DESIGN_REPLAY.md'), lines.join('\n'));
console.log(JSON.stringify({ analyticalTradeCount: report.analyticalTradeCount, replayTradeCount: report.replayTradeCount, missingPathCount: report.missingPathCount, topModels: ranked.slice(0, 10) }, null, 2));
