import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const botRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(process.cwd(), '..', '..', '..');
const legacyData = resolve(workspaceRoot, 'crypto-news-radar', 'data');
const currentData = resolve(botRoot, 'data');
const paperRoot = resolve(workspaceRoot, 'flow-squeeze-paper');
const output = resolve(currentData, 'research-history');

const paths = {
  legacyHistory: resolve(legacyData, 'flow-alert-history.jsonl'),
  currentHistory: resolve(currentData, 'flow-alert-history.jsonl'),
  legacyLedger: resolve(legacyData, 'alert-ledger.jsonl'),
  currentLedger: resolve(currentData, 'flow-alert-ledger.jsonl'),
  legacyOutcomeArchive: resolve(legacyData, 'alert-outcomes-archive.jsonl'),
  legacyOutcomes: resolve(legacyData, 'alert-outcomes.json'),
  currentOutcomeArchive: resolve(currentData, 'flow-alert-outcomes-archive.jsonl'),
  currentOutcomes: resolve(currentData, 'flow-alert-outcomes.json'),
  legacyLog: resolve(legacyData, 'local-radar.log'),
  currentLog: resolve(currentData, 'flow-squeeze.log'),
  paperEvents: resolve(paperRoot, 'data', 'events.jsonl'),
};

async function jsonLines(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

async function textLines(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) rows.push(line);
  return rows;
}

const flowRecord = row => {
  const id = String(row.id || row.signalId || '');
  return id.startsWith('flow:') || id.startsWith('flow-shadow:') || row.kind === 'flow' || row.type === 'flow_follow_up';
};

const dateOf = row => String(row.at || row.archivedAt || row.createdAt || row.alertedAt || row.observedAt || '');
const sortRows = rows => rows.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
const writeJsonLines = (path, rows) => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

function dedupeEvents(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = [row.type || 'record', row.id || row.signalId || '', row.horizonMinutes ?? '', row.status || '', row.event || '', row.at || row.archivedAt || ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function range(rows) {
  const dates = rows.map(dateOf).filter(Boolean).sort();
  return { first: dates[0] || null, last: dates.at(-1) || null };
}

await mkdir(output, { recursive: true });

const legacyHistory = await jsonLines(paths.legacyHistory);
const currentHistory = await jsonLines(paths.currentHistory);
const historyByLine = new Map();
for (const row of [...legacyHistory, ...currentHistory]) historyByLine.set(JSON.stringify(row), row);
const alerts = sortRows([...historyByLine.values()]);

const legacyLedger = (await jsonLines(paths.legacyLedger)).filter(flowRecord);
const currentLedger = (await jsonLines(paths.currentLedger)).filter(flowRecord);
const ledger = sortRows(dedupeEvents([...legacyLedger, ...currentLedger]));

const legacyArchive = (await jsonLines(paths.legacyOutcomeArchive)).filter(flowRecord);
const currentArchive = (await jsonLines(paths.currentOutcomeArchive)).filter(flowRecord);
const legacyActive = Object.values(JSON.parse(await readFile(paths.legacyOutcomes, 'utf8')).records || {}).filter(flowRecord);
const currentActive = Object.values(JSON.parse(await readFile(paths.currentOutcomes, 'utf8')).records || {}).filter(flowRecord);
const outcomesById = new Map();
for (const row of [...legacyArchive, ...legacyActive, ...currentArchive, ...currentActive]) outcomesById.set(row.id, row);
const outcomes = sortRows([...outcomesById.values()]);

const legacyRuntime = (await textLines(paths.legacyLog)).filter(line => /\bflow\b|squeeze|liquidation_evidence/i.test(line));
const currentRuntime = await textLines(paths.currentLog);
const runtime = [...new Set([...legacyRuntime, ...currentRuntime])].sort((a, b) => a.slice(0, 24).localeCompare(b.slice(0, 24)));
const paperEvents = await jsonLines(paths.paperEvents);

await writeJsonLines(resolve(output, 'flow-alert-history.jsonl'), alerts);
await writeJsonLines(resolve(output, 'flow-alert-ledger.jsonl'), ledger);
await writeJsonLines(resolve(output, 'flow-alert-outcomes.jsonl'), outcomes);
await writeFile(resolve(output, 'flow-runtime.log'), runtime.join('\n') + '\n');
await writeJsonLines(resolve(output, 'paper-events.jsonl'), paperEvents);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  purpose: 'Read-only, deduplicated research history. Runtime bot state does not read these files.',
  datasets: {
    alerts: { rows: alerts.length, ...range(alerts), legacyRows: legacyHistory.length, currentRows: currentHistory.length },
    ledger: { rows: ledger.length, ...range(ledger), legacyFlowRows: legacyLedger.length, currentFlowRows: currentLedger.length },
    outcomes: { rows: outcomes.length, ...range(outcomes), legacyArchived: legacyArchive.length, legacyActive: legacyActive.length, currentArchived: currentArchive.length, currentActive: currentActive.length },
    runtime: { rows: runtime.length, first: runtime[0]?.slice(0, 24) || null, last: runtime.at(-1)?.slice(0, 24) || null, legacyFlowRows: legacyRuntime.length, currentRows: currentRuntime.length },
    paperEvents: { rows: paperEvents.length, ...range(paperEvents) },
  },
  sources: paths,
  notes: [
    'Legacy combined ledgers are filtered to Flow/Squeeze identifiers before joining.',
    'Migrated alert-history rows are deduplicated by their complete JSON representation.',
    'Outcome records are deduplicated by signal ID, preferring standalone records when both exist.',
    'Paper and upstream alert results remain separate datasets and must not be combined as one performance metric.',
  ],
};
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
