import { readFile } from 'node:fs/promises';

const state = JSON.parse(await readFile(new URL('../data/alert-outcomes.json', import.meta.url), 'utf8'));
const records = Object.values(state.records || {}).filter(record => record.kind === 'flow' && ['sent', 'shadow'].includes(record.status));
const horizons = [5, 15, 30, 60, 240];
const median = values => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const metrics = cohort => Object.fromEntries(horizons.map(horizon => {
  const values = cohort.map(record => record.horizons?.[horizon]?.directedReturnPct).filter(Number.isFinite);
  return [`${horizon}m`, { n: values.length, directionalAccuracyPct: values.length ? values.filter(value => value > 0).length / values.length * 100 : null, meaningfulMovePct: values.length ? values.filter(value => value >= 1).length / values.length * 100 : null, medianDirectedReturnPct: values.length ? median(values) : null, meanDirectedReturnPct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null }];
}));
const venues = [...new Set(records.map(record => record.venue))];
const byVenue = Object.fromEntries(venues.map(venue => {
  const cohort = records.filter(record => record.venue === venue);
  return [venue, { alerts: cohort.length, mode: cohort.some(record => record.status === 'shadow') ? 'shadow' : 'published', horizons: metrics(cohort) }];
}));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), methodology: 'Direction-adjusted live outcomes; bearish returns are inverted so positive means the alert direction was correct. Kraken remains shadow-only until explicitly promoted.', alerts: records.length, overall: metrics(records), byVenue }, null, 2));
