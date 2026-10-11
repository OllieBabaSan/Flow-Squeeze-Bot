import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = resolve('data/events.jsonl');
const config = JSON.parse(await readFile(resolve('config.json'), 'utf8'));
let rows = [];
try { rows = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch {}
const entries = rows.filter(row => row.type === 'PAPER_ENTRY');
const exits = rows.filter(row => row.type === 'PAPER_EXIT');
const rejected = rows.filter(row => row.type === 'TRADE_REJECTED');
const rejectedOutcomes = rows.filter(row => row.type === 'REJECTED_OUTCOME');
const net = exits.reduce((sum, row) => sum + Number(row.netPnlUsd || 0), 0);
const grossWins = exits.filter(row => row.netPnlUsd > 0).reduce((sum, row) => sum + row.netPnlUsd, 0);
const grossLosses = Math.abs(exits.filter(row => row.netPnlUsd <= 0).reduce((sum, row) => sum + row.netPnlUsd, 0));
const counts = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
const scenarioEquity = riskPct => exits.reduce((equity, row) => equity * (1 + Number(row.rMultiple || 0) * riskPct / 100), config.initialEquityUsd);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(), firstEventAt: rows[0]?.at || null, lastEventAt: rows.at(-1)?.at || null,
  signals: rows.filter(row => row.type === 'SIGNAL_RECEIVED').length, entries: entries.length, exits: exits.length,
  openPositions: entries.length - exits.length, rejected: rejected.length,
  wins: exits.filter(row => row.netPnlUsd > 0).length, losses: exits.filter(row => row.netPnlUsd <= 0).length,
  winRate: exits.length ? exits.filter(row => row.netPnlUsd > 0).length / exits.length : null,
  netPnlUsd: net, profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
  averageR: exits.length ? exits.reduce((sum, row) => sum + Number(row.rMultiple || 0), 0) / exits.length : null,
  averageMfePct: exits.length ? exits.reduce((sum, row) => sum + Number(row.peakProgressPct || 0), 0) / exits.length : null,
  averageMaePct: exits.length ? exits.reduce((sum, row) => sum + Number(row.maxAdverseProgressPct || 0), 0) / exits.length : null,
  sizingScenarios: Object.fromEntries(config.reportingRiskScenariosPct.map(riskPct => [riskPct, { endingEquityUsd: scenarioEquity(riskPct), returnPct: (scenarioEquity(riskPct) / config.initialEquityUsd - 1) * 100 }])),
  rejectionReasons: counts(rejected.map(row => row.reason)), exitReasons: counts(exits.map(row => row.reason)),
  rejectedOpportunityOutcomes: Object.fromEntries([5, 15, 30, 60, 240].map(horizon => {
    const cohort = rejectedOutcomes.filter(row => row.horizonMinutes === horizon);
    return [horizon, { samples: cohort.length, averageDirectedReturnPct: cohort.length ? cohort.reduce((sum, row) => sum + row.directedReturnPct, 0) / cohort.length : null, averageMaxFavorablePct: cohort.length ? cohort.reduce((sum, row) => sum + row.maxFavorablePct, 0) / cohort.length : null }];
  })),
}, null, 2));
