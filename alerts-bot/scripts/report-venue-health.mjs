import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const argument = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const dataDir = resolve(argument('--data-dir') || process.env.FLOW_DATA_DIR || resolve(import.meta.dirname, '..', 'data'));
const sinceHours = Math.max(1, Number(argument('--since-hours') || 24));
const cutoff = Date.now() - sinceHours * 3600_000;
const readJson = async (name, fallback) => { try { return JSON.parse(await readFile(resolve(dataDir, name), 'utf8')); } catch { return fallback; } };
const readJsonl = async name => { try { return (await readFile(resolve(dataDir, name), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };

const state = await readJson('venue-health.json', { venues: {} });
const events = (await readJsonl('venue-health-history.jsonl')).filter(event => Date.parse(event.at) >= cutoff);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  sinceHours,
  updatedAt: state.updatedAt || null,
  venues: state.venues || {},
  eventCounts: Object.fromEntries([...Map.groupBy(events, event => `${event.venue}:${event.event}`)].map(([key, rows]) => [key, rows.length])),
  events,
}, null, 2));
