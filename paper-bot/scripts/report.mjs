import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const argumentValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const path = resolve(argumentValue('--data-dir') || 'data', 'events.jsonl');
const statePath = resolve(argumentValue('--data-dir') || 'data', 'state.json');
async function loadConfig(path, seen = new Set()) {
  if (seen.has(path)) throw new Error(`Circular config inheritance: ${path}`);
  seen.add(path);
  const configured = JSON.parse(await readFile(path, 'utf8'));
  const inherited = configured.extends ? await loadConfig(resolve(dirname(path), configured.extends), seen) : {};
  return { ...inherited, ...configured };
}
const config = await loadConfig(resolve(argumentValue('--config') || 'config.json'));
let rows = [];
try { rows = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch {}
let state = null;
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch {}
let exclusions = { signalIds: [], notes: {} };
if (config.analysisExclusionsFile) {
  try { exclusions = JSON.parse(await readFile(resolve(config.analysisExclusionsFile), 'utf8')); } catch {}
}
const excludedSignalIds = new Set(exclusions.signalIds || []);
const analyticalRows = rows.filter(row => !row.signalId || !excludedSignalIds.has(row.signalId));
const excludedExits = rows.filter(row => row.type === 'PAPER_EXIT' && excludedSignalIds.has(row.signalId));
const entries = analyticalRows.filter(row => row.type === 'PAPER_ENTRY');
const exits = analyticalRows.filter(row => row.type === 'PAPER_EXIT');
const rejected = rows.filter(row => row.type === 'TRADE_REJECTED');
const rejectedOutcomes = rows.filter(row => row.type === 'REJECTED_OUTCOME');
const counterfactualTriggers = analyticalRows.filter(row => row.type === 'COUNTERFACTUAL_EXIT_TRIGGER');
const counterfactualOutcomes = analyticalRows.filter(row => row.type === 'COUNTERFACTUAL_EXIT_OUTCOME');
const strengthTriggers = analyticalRows.filter(row => row.type === 'STRENGTH_SHADOW_TRIGGER');
const strengthOutcomes = analyticalRows.filter(row => row.type === 'STRENGTH_SHADOW_OUTCOME');
const postExitOutcomes = analyticalRows.filter(row => row.type === 'WINNER_POST_EXIT_OUTCOME');
const missedShadowEntries = analyticalRows.filter(row => row.type === 'MISSED_OPPORTUNITY_SHADOW_ENTRY');
const missedShadowExits = analyticalRows.filter(row => row.type === 'MISSED_OPPORTUNITY_SHADOW_EXIT');
const missedShadowSkips = analyticalRows.filter(row => row.type === 'MISSED_OPPORTUNITY_SHADOW_SKIPPED');
const missedShadowExitDeferrals = analyticalRows.filter(row => row.type === 'MISSED_OPPORTUNITY_SHADOW_EXIT_DEFERRED');
const receivedSignals = rows.filter(row => row.type === 'SIGNAL_RECEIVED');
const cycleErrors = rows.filter(row => row.type === 'CYCLE_ERROR');
const cycleRecoveries = rows.filter(row => row.type === 'CYCLE_RECOVERED');
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};
const lagSummary = field => {
  const values = receivedSignals.map(row => Number(row[field])).filter(Number.isFinite);
  return {
    samples: values.length,
    medianMs: percentile(values, 0.5), p90Ms: percentile(values, 0.9),
    p95Ms: percentile(values, 0.95), maximumMs: values.length ? Math.max(...values) : null,
    over15Seconds: values.filter(value => value > 15_000).length,
    over30Seconds: values.filter(value => value > 30_000).length,
    over60Seconds: values.filter(value => value > 60_000).length,
  };
};
const net = exits.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0);
const grossWins = exits.filter(row => row.netPnlUsd > 0).reduce((sum, row) => sum + row.netPnlUsd, 0);
const grossLosses = Math.abs(exits.filter(row => row.netPnlUsd <= 0).reduce((sum, row) => sum + row.netPnlUsd, 0));
const counts = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const numeric = (rows, field) => rows.map(row => Number(row[field])).filter(Number.isFinite);
const receivedBySignal = new Map(receivedSignals.map(row => [row.signalId, row]));
const summarizeTradeCohort = cohortEntries => {
  const signalIds = new Set(cohortEntries.map(row => row.signalId));
  const cohortExits = exits.filter(row => signalIds.has(row.signalId));
  const wins = cohortExits.filter(row => Number(row.netPnlUsd) > 0);
  const losses = cohortExits.filter(row => Number(row.netPnlUsd) <= 0);
  const grossWins = wins.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0);
  const grossLosses = Math.abs(losses.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0));
  return {
    entries: cohortEntries.length,
    exits: cohortExits.length,
    open: cohortEntries.length - cohortExits.length,
    wins: wins.length,
    losses: losses.length,
    winRate: cohortExits.length ? wins.length / cohortExits.length : null,
    netPnlUsd: cohortExits.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0),
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    averageMfePct: mean(numeric(cohortExits, 'peakProgressPct')),
    averageMaePct: mean(numeric(cohortExits, 'maxAdverseProgressPct')),
    averageHeldMinutes: mean(numeric(cohortExits, 'heldMinutes')),
    exitReasons: counts(cohortExits.map(row => row.reason)),
  };
};
const entryDelaySeconds = entries.map(entry => {
  const received = receivedBySignal.get(entry.signalId);
  const createdAt = received?.signalCreatedAt;
  return createdAt ? (Date.parse(entry.at) - Date.parse(createdAt)) / 1000 : NaN;
}).filter(Number.isFinite);
const entryConfirmationMoves = entries.map(row => Number(row.confirmation?.movePct)).filter(Number.isFinite);
const entrySpreads = entries.map(row => Number(row.confirmation?.spreadBps)).filter(Number.isFinite);
const scenarioEquity = riskPct => exits.reduce((equity, row) => equity * (1 + Number(row.rMultiple || 0) * riskPct / 100), config.initialEquityUsd);
const combinedFailureRules = new Set(['FIVE_MINUTE_FAILURE', 'TEN_MINUTE_FAILURE']);
const combinedFailureBySignal = new Map();
for (const outcome of counterfactualOutcomes.filter(row => combinedFailureRules.has(row.rule))) {
  const current = combinedFailureBySignal.get(outcome.signalId);
  if (!current || Date.parse(outcome.triggeredAt) < Date.parse(current.triggeredAt)) combinedFailureBySignal.set(outcome.signalId, outcome);
}
const combinedFailureOutcomes = [...combinedFailureBySignal.values()];
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(), firstEventAt: rows[0]?.at || null, lastEventAt: rows.at(-1)?.at || null,
  analyticalExclusions: {
    trades: excludedExits.length,
    signalIds: [...excludedSignalIds],
    excludedNetPnlUsd: excludedExits.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0),
    notes: exclusions.notes || {},
  },
  signals: receivedSignals.length,
  signalContract: {
    schemaVersions: counts(receivedSignals.map(row => String(row.schemaVersion ?? 'legacy'))),
    detectorVersions: counts(receivedSignals.map(row => row.detectorVersion || 'legacy-unversioned')),
    publicationStatus: counts(receivedSignals.map(row => row.publicationStatus || 'legacy-unspecified')),
  },
  consumerLag: {
    alertCreationToReceipt: lagSummary('receiptLagMs'),
    producerRecording: lagSummary('producerRecordingLagMs'),
    fileRecordToReceipt: lagSummary('fileToConsumerLagMs'),
  },
  entries: entries.length, exits: exits.length,
  openPositions: entries.length - exits.length, rejected: rejected.length,
  wins: exits.filter(row => row.netPnlUsd > 0).length, losses: exits.filter(row => row.netPnlUsd <= 0).length,
  winRate: exits.length ? exits.filter(row => row.netPnlUsd > 0).length / exits.length : null,
  netPnlUsd: net, profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
  operationalAccount: {
    initialEquityUsd: config.initialEquityUsd,
    equityUsd: Number.isFinite(Number(state?.equityUsd)) ? Number(state.equityUsd) : null,
    peakEquityUsd: Number.isFinite(Number(state?.peakEquityUsd)) ? Number(state.peakEquityUsd) : null,
    feesUsd: Number.isFinite(Number(state?.totals?.feesUsd)) ? Number(state.totals.feesUsd) : null,
    drawdownUsd: Number.isFinite(Number(state?.peakEquityUsd)) && Number.isFinite(Number(state?.equityUsd)) ? Number(state.peakEquityUsd) - Number(state.equityUsd) : null,
    drawdownPct: Number(state?.peakEquityUsd) > 0 ? (Number(state.peakEquityUsd) - Number(state.equityUsd)) / Number(state.peakEquityUsd) * 100 : null,
  },
  confirmationEntry: {
    samples: entries.length,
    averageSignalToEntrySeconds: mean(entryDelaySeconds),
    medianSignalToEntrySeconds: percentile(entryDelaySeconds, 0.5),
    averageDirectedMovePct: mean(entryConfirmationMoves),
    averageSpreadBps: mean(entrySpreads),
  },
  holdingTime: {
    samples: exits.length,
    averageMinutes: mean(numeric(exits, 'heldMinutes')),
    medianMinutes: percentile(numeric(exits, 'heldMinutes'), 0.5),
  },
  cohorts: {
    byDirection: Object.fromEntries([...new Set(entries.map(row => row.direction))].sort().map(value => [value, summarizeTradeCohort(entries.filter(row => row.direction === value))])),
    bySignalType: Object.fromEntries([...new Set(entries.map(row => row.kind))].sort().map(value => [value, summarizeTradeCohort(entries.filter(row => row.kind === value))])),
  },
  instrumentation: {
    cycleErrors: cycleErrors.length,
    cycleRecoveries: cycleRecoveries.length,
    unresolvedCycleError: state?.lastCycleError || null,
    lastCycleErrorAt: cycleErrors.at(-1)?.at || null,
    lastCycleRecoveryAt: cycleRecoveries.at(-1)?.at || null,
  },
  averageR: exits.length ? exits.reduce((sum, row) => sum + Number(row.rMultiple || 0), 0) / exits.length : null,
  averageMfePct: exits.length ? exits.reduce((sum, row) => sum + Number(row.peakProgressPct || 0), 0) / exits.length : null,
  averageMaePct: exits.length ? exits.reduce((sum, row) => sum + Number(row.maxAdverseProgressPct || 0), 0) / exits.length : null,
  sizingScenarios: Object.fromEntries(config.reportingRiskScenariosPct.map(riskPct => [riskPct, { endingEquityUsd: scenarioEquity(riskPct), returnPct: (scenarioEquity(riskPct) / config.initialEquityUsd - 1) * 100 }])),
  rejectionReasons: counts(rejected.map(row => row.reason)), exitReasons: counts(exits.map(row => row.reason)),
  rejectedOpportunityOutcomes: Object.fromEntries([5, 15, 30, 60, 240].map(horizon => {
    const cohort = rejectedOutcomes.filter(row => row.horizonMinutes === horizon);
    return [horizon, { samples: cohort.length, averageDirectedReturnPct: cohort.length ? cohort.reduce((sum, row) => sum + row.directedReturnPct, 0) / cohort.length : null, averageMaxFavorablePct: cohort.length ? cohort.reduce((sum, row) => sum + row.maxFavorablePct, 0) / cohort.length : null }];
  })),
  missedOpportunityShadows: Object.fromEntries([...new Set([...missedShadowEntries, ...missedShadowExits, ...missedShadowSkips].map(row => row.model))].sort().map(model => {
    const modelEntries = missedShadowEntries.filter(row => row.model === model);
    const modelExits = missedShadowExits.filter(row => row.model === model);
    const modelSkips = missedShadowSkips.filter(row => row.model === model);
    const wins = modelExits.filter(row => Number(row.netPnlUsd) > 0);
    const losses = modelExits.filter(row => Number(row.netPnlUsd) <= 0);
    const grossWins = wins.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0);
    const grossLosses = Math.abs(losses.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0));
    return [model, {
      entries: modelEntries.length, exits: modelExits.length, open: modelEntries.length - modelExits.length,
      skipped: modelSkips.length, wins: wins.length, losses: losses.length,
      netPnlUsd: modelExits.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0),
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
      averageHeldMinutes: modelExits.length ? modelExits.reduce((sum, row) => sum + Number(row.heldMinutes || 0), 0) / modelExits.length : null,
      averageMfePct: modelExits.length ? modelExits.reduce((sum, row) => sum + Number(row.peakProgressPct || 0), 0) / modelExits.length : null,
      averageMaePct: modelExits.length ? modelExits.reduce((sum, row) => sum + Number(row.maxAdverseProgressPct || 0), 0) / modelExits.length : null,
      averageEntryFillRatio: modelEntries.length ? modelEntries.reduce((sum, row) => sum + Number(row.fillRatio || 0), 0) / modelEntries.length : null,
      averageExitFillRatio: modelExits.length ? modelExits.reduce((sum, row) => sum + Number(row.exitFillRatio || 0), 0) / modelExits.length : null,
      exitDepthDeferrals: missedShadowExitDeferrals.filter(row => row.model === model).length,
      exitReasons: counts(modelExits.map(row => row.exitReason)), skipReasons: counts(modelSkips.map(row => row.reason)),
    }];
  })),
  counterfactualExits: Object.fromEntries([...new Set([...counterfactualTriggers, ...counterfactualOutcomes].map(row => row.rule))].sort().map(rule => {
    const triggers = counterfactualTriggers.filter(row => row.rule === rule);
    const outcomes = counterfactualOutcomes.filter(row => row.rule === rule);
    return [rule, {
      triggers: triggers.length, completedComparisons: outcomes.length,
      shadowNetPnlUsd: outcomes.reduce((sum, row) => sum + Number(row.shadowNetPnlUsd || 0), 0),
      actualNetPnlUsd: outcomes.reduce((sum, row) => sum + Number(row.actualNetPnlUsd || 0), 0),
      savingsUsd: outcomes.reduce((sum, row) => sum + Number(row.savingsUsd || 0), 0),
      actualWinnersCut: outcomes.filter(row => row.cutActualWinner).length,
    }];
  })),
  combinedConservativeFailureShadow: {
    completedComparisons: combinedFailureOutcomes.length,
    shadowNetPnlUsd: combinedFailureOutcomes.reduce((sum, row) => sum + Number(row.shadowNetPnlUsd || 0), 0),
    actualNetPnlUsd: combinedFailureOutcomes.reduce((sum, row) => sum + Number(row.actualNetPnlUsd || 0), 0),
    savingsUsd: combinedFailureOutcomes.reduce((sum, row) => sum + Number(row.savingsUsd || 0), 0),
    actualWinnersCut: combinedFailureOutcomes.filter(row => row.cutActualWinner).length,
  },
  strengthShadowExits: Object.fromEntries([...new Set([...strengthTriggers, ...strengthOutcomes].map(row => row.rule))].sort().map(rule => {
    const triggers = strengthTriggers.filter(row => row.rule === rule);
    const outcomes = strengthOutcomes.filter(row => row.rule === rule);
    return [rule, {
      triggers: triggers.length, completedComparisons: outcomes.length,
      shadowNetPnlUsd: outcomes.reduce((sum, row) => sum + Number(row.shadowNetPnlUsd || 0), 0),
      actualNetPnlUsd: outcomes.reduce((sum, row) => sum + Number(row.actualNetPnlUsd || 0), 0),
      improvementUsd: outcomes.reduce((sum, row) => sum + Number(row.improvementUsd || 0), 0),
      outcomesImproved: outcomes.filter(row => row.improvedActualOutcome).length,
    }];
  })),
  winnerPostExitContinuation: Object.fromEntries((config.strengthShadowRules?.postExitHorizonsMinutes || []).map(horizon => {
    const cohort = postExitOutcomes.filter(row => row.horizonMinutes === horizon);
    return [horizon, {
      samples: cohort.length,
      averageImprovementUsd: cohort.length ? cohort.reduce((sum, row) => sum + Number(row.improvementUsd || 0), 0) / cohort.length : null,
      holdsThatImproved: cohort.filter(row => row.improvementUsd > 0).length,
    }];
  })),
}, null, 2));
