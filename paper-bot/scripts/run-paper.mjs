import { open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachBook, fetchMarkets } from '../src/hyperliquid.mjs';
import { closeAccounting, evaluateCandidate, evaluateExit, signalKind, simulatedFill, sizePosition } from '../src/strategy.mjs';
import { appendJsonl, readJson, readNewLines, writeJson } from '../src/storage.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(projectDir, 'config.json'), 'utf8'));
const signalPath = resolve(projectDir, config.signalFile);
const statePath = resolve(projectDir, 'data', 'state.json');
const eventPath = resolve(projectDir, 'data', 'events.jsonl');
const lockPath = resolve(projectDir, 'data', 'paper-bot.lock');
const once = process.argv.includes('--once');
const state = await readJson(statePath, {
  startedAt: new Date().toISOString(), equityUsd: config.initialEquityUsd, peakEquityUsd: config.initialEquityUsd,
  signalOffset: null, candidates: {}, positions: {}, seenSignals: {}, day: null, dayStartEquityUsd: config.initialEquityUsd,
  rejectedObservations: {},
  totals: { signals: 0, entries: 0, exits: 0, rejected: 0, wins: 0, losses: 0, feesUsd: 0 },
});

let lock;
await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(lockPath), { recursive: true }));
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    lock = await open(lockPath, 'wx');
    await lock.writeFile(String(process.pid));
    break;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let priorPid = 0;
    try { priorPid = Number((await readFile(lockPath, 'utf8')).trim()); } catch {}
    let alive = false;
    if (priorPid > 0) try { process.kill(priorPid, 0); alive = true; } catch {}
    if (alive) { console.log(`Paper bot is already running (pid ${priorPid}).`); process.exit(0); }
    await unlink(lockPath).catch(() => {});
  }
}
if (!lock) throw new Error('Unable to acquire paper-bot instance lock');
const cleanup = async () => { try { await lock?.close(); } catch {} try { await unlink(lockPath); } catch {} };
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

async function record(type, details = {}) {
  const event = { at: new Date().toISOString(), type, ...details };
  await appendJsonl(eventPath, event);
  console.log(JSON.stringify(event));
}

function signalId(row) {
  return `${row.alertedAt}:${row.market?.venue}:${row.market?.symbol}:${row.detection?.direction}`;
}

async function ingestSignals(now) {
  if (state.signalOffset == null) {
    try { state.signalOffset = (await stat(signalPath)).size; }
    catch { state.signalOffset = 0; }
    await record('SIGNAL_BASELINE', { signalPath, offset: state.signalOffset });
    return;
  }
  const update = await readNewLines(signalPath, state.signalOffset);
  state.signalOffset = update.offset;
  for (const line of update.lines) {
    let row;
    try { row = JSON.parse(line); } catch { await record('SIGNAL_REJECTED', { reason: 'MALFORMED_SIGNAL_RECORD' }); continue; }
    const id = signalId(row);
    if (state.seenSignals[id]) continue;
    state.seenSignals[id] = now;
    state.totals.signals += 1;
    const alertedAtMs = Date.parse(row.alertedAt);
    if (!row.detection?.eligible || !['BULLISH', 'BEARISH'].includes(row.detection.direction) || !(alertedAtMs > 0) || !(Number(row.market?.price) > 0)) {
      state.totals.rejected += 1;
      await record('SIGNAL_REJECTED', { signalId: id, symbol: row.market?.symbol, reason: 'INVALID_SIGNAL' });
      continue;
    }
    state.candidates[id] = {
      id, symbol: row.market.symbol, direction: row.detection.direction, kind: signalKind(row.detection.reason),
      reason: row.detection.reason, alertedAtMs, alertPrice: Number(row.market.price),
      alertOpenInterest: Number(row.market.openInterest), sourceVenue: row.market.venue, stage: 'NEW',
    };
    await record('SIGNAL_RECEIVED', { signalId: id, symbol: row.market.symbol, direction: row.detection.direction, kind: signalKind(row.detection.reason), sourceVenue: row.market.venue });
  }
}

function rollDay(now) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.day !== day) { state.day = day; state.dayStartEquityUsd = state.equityUsd; }
}

function dailyLocked() {
  return state.equityUsd <= state.dayStartEquityUsd * (1 - config.maximumDailyLossPct / 100);
}

async function reject(candidate, reason, metrics = {}, market = null, now = Date.now()) {
  delete state.candidates[candidate.id];
  state.totals.rejected += 1;
  if (market?.mid > 0) state.rejectedObservations[candidate.id] = {
    id: candidate.id, symbol: candidate.symbol, direction: candidate.direction, kind: candidate.kind, reason,
    rejectedAtMs: now, rejectedPrice: market.mid, horizons: {}, maxFavorablePct: 0, maxAdversePct: 0,
  };
  await record('TRADE_REJECTED', { signalId: candidate.id, symbol: candidate.symbol, direction: candidate.direction, kind: candidate.kind, reason, metrics });
}

async function enter(candidate, market, decision, now) {
  if (dailyLocked()) return reject(candidate, 'DAILY_LOSS_LOCKOUT', {}, market, now);
  if (Object.keys(state.positions).length >= config.maximumConcurrentPositions) return reject(candidate, 'MAXIMUM_CONCURRENT_POSITIONS', {}, market, now);
  if (Object.values(state.positions).some(position => position.symbol === candidate.symbol)) return reject(candidate, 'SYMBOL_POSITION_ALREADY_OPEN', {}, market, now);
  const entryPrice = simulatedFill(market, candidate.direction, 'ENTRY', config);
  const sizing = sizePosition(state.equityUsd, entryPrice, candidate.direction, config);
  const grossExposureUsd = Object.values(state.positions).reduce((sum, position) => sum + Number(position.notional || 0), 0);
  if (grossExposureUsd + sizing.notional > config.maximumGrossExposureUsd) return reject(candidate, 'MAXIMUM_GROSS_EXPOSURE', { grossExposureUsd, proposedNotionalUsd: sizing.notional }, market, now);
  const entryFeeUsd = sizing.notional * config.takerFeeRate;
  state.equityUsd -= entryFeeUsd;
  state.totals.feesUsd += entryFeeUsd;
  state.positions[candidate.id] = {
    ...candidate, ...sizing, entryPrice, entryFeeUsd, enteredAtMs: now, peakProgressPct: 0, maxAdverseProgressPct: 0,
    confirmation: decision.metrics, marketSnapshot: { bid: market.bid, ask: market.ask, mid: market.mid, openInterest: market.openInterest, volume24hUsd: market.volume24hUsd },
  };
  delete state.candidates[candidate.id];
  state.totals.entries += 1;
  await record('PAPER_ENTRY', { signalId: candidate.id, symbol: candidate.symbol, direction: candidate.direction, kind: candidate.kind, entryPrice, ...sizing, entryFeeUsd, equityAfterEntryUsd: state.equityUsd, confirmation: decision.metrics });
}

async function close(position, market, decision, now) {
  const accounting = closeAccounting(position, decision.exitPrice, config);
  state.equityUsd += accounting.grossPnlUsd - accounting.exitFeeUsd;
  state.peakEquityUsd = Math.max(state.peakEquityUsd, state.equityUsd);
  state.totals.feesUsd += accounting.exitFeeUsd;
  state.totals.exits += 1;
  if (accounting.netPnlUsd > 0) state.totals.wins += 1; else state.totals.losses += 1;
  delete state.positions[position.id];
  await record('PAPER_EXIT', {
    signalId: position.id, symbol: position.symbol, direction: position.direction, kind: position.kind,
    entryPrice: position.entryPrice, exitPrice: decision.exitPrice, reason: decision.reason,
    heldMinutes: (now - position.enteredAtMs) / 60000, progressPct: decision.progressPct,
    peakProgressPct: decision.peakProgressPct, maxAdverseProgressPct: decision.maxAdverseProgressPct,
    rMultiple: position.plannedLossUsd > 0 ? accounting.netPnlUsd / position.plannedLossUsd : null,
    ...accounting, equityAfterExitUsd: state.equityUsd,
  });
}

async function cycle() {
  const now = Date.now();
  rollDay(now);
  await ingestSignals(now);
  const catalog = await fetchMarkets();
  state.rejectedObservations ||= {};
  const requiredSymbols = new Set([...Object.values(state.candidates), ...Object.values(state.positions), ...Object.values(state.rejectedObservations)].map(item => item.symbol));
  const books = new Map();
  await Promise.all([...requiredSymbols].map(async symbol => {
    const market = catalog.get(symbol);
    if (!market) return;
    try { books.set(symbol, await attachBook(market)); }
    catch (error) { await record('MARKET_DATA_WARNING', { symbol, error: error instanceof Error ? error.message : String(error) }); }
  }));
  for (const candidate of Object.values({ ...state.candidates })) {
    const market = books.get(candidate.symbol) || catalog.get(candidate.symbol) || null;
    if (market && !candidate.referencePrice) {
      candidate.referencePrice = market.mid;
      candidate.referenceOpenInterest = market.openInterest;
      candidate.referenceAtMs = now;
    }
    const decision = evaluateCandidate(candidate, market, now, config);
    candidate.stage = 'OBSERVING';
    candidate.lastDecision = decision;
    if (decision.action === 'REJECT') await reject(candidate, decision.reason, decision.metrics, market, now);
    else if (decision.action === 'ENTER') await enter(candidate, market, decision, now);
  }
  for (const position of Object.values({ ...state.positions })) {
    const market = books.get(position.symbol);
    if (!market?.bid || !market?.ask) continue;
    const decision = evaluateExit(position, market, now, config);
    position.peakProgressPct = decision.peakProgressPct;
    position.maxAdverseProgressPct = decision.maxAdverseProgressPct;
    position.lastPrice = market.mid;
    position.lastObservedAtMs = now;
    if (decision.exit) await close(position, market, decision, now);
  }
  const rejectionHorizons = [5, 15, 30, 60, 240];
  for (const observation of Object.values({ ...state.rejectedObservations })) {
    const market = books.get(observation.symbol) || catalog.get(observation.symbol);
    if (!market?.mid) continue;
    const progressPct = ((market.mid / observation.rejectedPrice - 1) * 100) * (observation.direction === 'BEARISH' ? -1 : 1);
    observation.maxFavorablePct = Math.max(observation.maxFavorablePct, progressPct);
    observation.maxAdversePct = Math.min(observation.maxAdversePct, progressPct);
    const elapsedMinutes = (now - observation.rejectedAtMs) / 60000;
    for (const horizon of rejectionHorizons) {
      if (elapsedMinutes < horizon || observation.horizons[horizon]) continue;
      observation.horizons[horizon] = true;
      await record('REJECTED_OUTCOME', { signalId: observation.id, symbol: observation.symbol, direction: observation.direction, kind: observation.kind, rejectionReason: observation.reason, horizonMinutes: horizon, directedReturnPct: progressPct, maxFavorablePct: observation.maxFavorablePct, maxAdversePct: observation.maxAdversePct });
    }
    if (observation.horizons[240]) delete state.rejectedObservations[observation.id];
  }
  const retention = now - 14 * 86400_000;
  state.seenSignals = Object.fromEntries(Object.entries(state.seenSignals).filter(([, at]) => at >= retention));
  await writeJson(statePath, state);
}

try {
  do {
    const started = Date.now();
    try { await cycle(); } catch (error) { await record('CYCLE_ERROR', { error: error instanceof Error ? error.stack || error.message : String(error) }); }
    if (once) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.max(0, config.pollSeconds * 1000 - (Date.now() - started))));
  } while (true);
} finally {
  await cleanup();
}
