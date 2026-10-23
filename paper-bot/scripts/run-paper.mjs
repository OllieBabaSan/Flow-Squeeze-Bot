import { open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachBook, fetchMarkets } from '../src/hyperliquid.mjs';
import { closeAccounting, evaluateCandidate, evaluateExit, signalKind, simulatedFill, sizePosition } from '../src/strategy.mjs';
import { evaluateShadowExitRules } from '../src/shadow-exits.mjs';
import { evaluateStrengthShadowRules, partialExitAccounting } from '../src/strength-shadows.mjs';
import { appendJsonl, readJson, readNewLines, writeJson } from '../src/storage.mjs';
import { normalizeFlowSignal } from '../src/signal-contract.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argumentValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const config = JSON.parse(await readFile(resolve(projectDir, argumentValue('--config') || 'config.json'), 'utf8'));
// The automation intentionally consumes Flow/Squeeze Alerts, but it must not
// depend on a particular sibling-directory layout. Operators can point it at
// any installed parent signal stream with FLOW_SIGNAL_FILE or --signal-file.
const configuredSignalFile = argumentValue('--signal-file') || process.env.FLOW_SIGNAL_FILE || config.signalFile;
if (!configuredSignalFile) throw new Error('Flow signal input is required. Set FLOW_SIGNAL_FILE, pass --signal-file, or configure signalFile.');
const signalPath = resolve(projectDir, configuredSignalFile);
const dataDir = resolve(projectDir, argumentValue('--data-dir') || 'data');
const statePath = resolve(dataDir, 'state.json');
const eventPath = resolve(dataDir, 'events.jsonl');
const lockPath = resolve(dataDir, 'paper-bot.lock');
const once = process.argv.includes('--once');
const state = await readJson(statePath, {
  startedAt: new Date().toISOString(), equityUsd: config.initialEquityUsd, peakEquityUsd: config.initialEquityUsd,
  signalOffset: null, candidates: {}, positions: {}, seenSignals: {}, day: null, dayStartEquityUsd: config.initialEquityUsd,
  rejectedObservations: {},
  postExitObservations: {},
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
    if (Array.isArray(config.allowedSourceVenues) && !config.allowedSourceVenues.includes(row.market?.venue)) continue;
    const contract = normalizeFlowSignal(row, now);
    if (!contract.valid) {
      state.totals.rejected += 1;
      await record('SIGNAL_REJECTED', { reason: contract.reason, schemaVersion: contract.schemaVersion });
      continue;
    }
    const id = contract.signalId;
    if (state.seenSignals[id]) continue;
    state.seenSignals[id] = now;
    state.totals.signals += 1;
    const alertedAtMs = contract.createdAtMs;
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
    await record('SIGNAL_RECEIVED', {
      signalId: id, symbol: row.market.symbol, direction: row.detection.direction,
      kind: signalKind(row.detection.reason), sourceVenue: row.market.venue,
      schemaVersion: contract.schemaVersion, detectorVersion: contract.detectorVersion,
      publicationStatus: contract.publicationStatus, signalCreatedAt: contract.createdAt,
      signalRecordedAt: contract.recordedAt, receiptLagMs: contract.receiptLagMs,
      producerRecordingLagMs: contract.producerRecordingLagMs,
      fileToConsumerLagMs: contract.fileToConsumerLagMs,
    });
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
    lastPositionObservationAtMs: now,
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
  for (const shadow of Object.values(position.shadowExitTriggers || {})) {
    await record('COUNTERFACTUAL_EXIT_OUTCOME', {
      signalId: position.id, symbol: position.symbol, direction: position.direction, kind: position.kind,
      rule: shadow.rule, triggeredAt: shadow.triggeredAt, triggerHeldMinutes: shadow.heldMinutes,
      triggerProgressPct: shadow.progressPct, triggerPeakProgressPct: shadow.peakProgressPct,
      shadowExitPrice: shadow.exitPrice, shadowNetPnlUsd: shadow.netPnlUsd,
      actualExitReason: decision.reason, actualNetPnlUsd: accounting.netPnlUsd,
      savingsUsd: shadow.netPnlUsd - accounting.netPnlUsd,
      cutActualWinner: accounting.netPnlUsd > 0 && shadow.netPnlUsd < accounting.netPnlUsd,
    });
  }
  for (const shadow of Object.values(position.strengthShadowTriggers || {})) {
    const shadowAccounting = shadow.model === 'PARTIAL_EXIT'
      ? partialExitAccounting(position, shadow.exitPrice, decision.exitPrice, shadow.fraction, config)
      : shadow.accounting;
    await record('STRENGTH_SHADOW_OUTCOME', {
      signalId: position.id, symbol: position.symbol, direction: position.direction, kind: position.kind,
      rule: shadow.rule, model: shadow.model, triggeredAt: shadow.triggeredAt,
      triggerHeldMinutes: shadow.heldMinutes, triggerProgressPct: shadow.progressPct,
      triggerPeakProgressPct: shadow.peakProgressPct, shadowExitPrice: shadow.exitPrice,
      shadowNetPnlUsd: shadowAccounting.netPnlUsd, actualExitReason: decision.reason,
      actualNetPnlUsd: accounting.netPnlUsd, improvementUsd: shadowAccounting.netPnlUsd - accounting.netPnlUsd,
      improvedActualOutcome: shadowAccounting.netPnlUsd > accounting.netPnlUsd,
    });
  }
  if (accounting.netPnlUsd > 0 && ['TRAILING_STOP', 'TARGET_REACHED'].includes(decision.reason)) {
    state.postExitObservations ||= {};
    state.postExitObservations[position.id] = {
      id: position.id, symbol: position.symbol, direction: position.direction, kind: position.kind,
      entryPrice: position.entryPrice, entryFeeUsd: position.entryFeeUsd, quantity: position.quantity,
      exitedAtMs: now, actualExitPrice: decision.exitPrice, actualExitReason: decision.reason,
      actualNetPnlUsd: accounting.netPnlUsd, completedHorizons: [],
    };
  }
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
  state.postExitObservations ||= {};
  const requiredSymbols = new Set([...Object.values(state.candidates), ...Object.values(state.positions), ...Object.values(state.rejectedObservations), ...Object.values(state.postExitObservations)].map(item => item.symbol));
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
    position.shadowExitTriggers ||= {};
    for (const trigger of evaluateShadowExitRules(position, decision, now, config)) {
      if (position.shadowExitTriggers[trigger.rule]) continue;
      const shadowAccounting = closeAccounting(position, decision.exitPrice, config);
      position.shadowExitTriggers[trigger.rule] = {
        rule: trigger.rule, triggeredAt: new Date(now).toISOString(), exitPrice: decision.exitPrice,
        ...trigger.metrics, ...shadowAccounting,
      };
      await record('COUNTERFACTUAL_EXIT_TRIGGER', {
        signalId: position.id, symbol: position.symbol, direction: position.direction, kind: position.kind,
        rule: trigger.rule, exitPrice: decision.exitPrice, ...trigger.metrics, ...shadowAccounting,
      });
    }
    position.strengthShadowTriggers ||= {};
    for (const trigger of evaluateStrengthShadowRules(position, decision, config)) {
      if (position.strengthShadowTriggers[trigger.rule]) continue;
      const shadowAccounting = trigger.model === 'FULL_EXIT' ? closeAccounting(position, decision.exitPrice, config) : null;
      position.strengthShadowTriggers[trigger.rule] = {
        rule: trigger.rule, model: trigger.model, fraction: trigger.fraction || null,
        triggeredAt: new Date(now).toISOString(), exitPrice: decision.exitPrice,
        heldMinutes: (now - position.enteredAtMs) / 60000, progressPct: decision.progressPct,
        peakProgressPct: decision.peakProgressPct, accounting: shadowAccounting,
      };
      await record('STRENGTH_SHADOW_TRIGGER', {
        signalId: position.id, symbol: position.symbol, direction: position.direction, kind: position.kind,
        rule: trigger.rule, model: trigger.model, fraction: trigger.fraction || null,
        exitPrice: decision.exitPrice, heldMinutes: (now - position.enteredAtMs) / 60000,
        progressPct: decision.progressPct, peakProgressPct: decision.peakProgressPct,
        shadowNetPnlUsd: shadowAccounting?.netPnlUsd ?? null,
      });
    }
    if (decision.exit) await close(position, market, decision, now);
    else if (now - Number(position.lastPositionObservationAtMs || position.enteredAtMs) >= Number(config.positionObservationSeconds || 60) * 1000) {
      position.lastPositionObservationAtMs = now;
      await record('POSITION_OBSERVATION', {
        signalId: position.id, symbol: position.symbol, direction: position.direction, kind: position.kind,
        heldMinutes: (now - position.enteredAtMs) / 60000, progressPct: decision.progressPct,
        peakProgressPct: decision.peakProgressPct, maxAdverseProgressPct: decision.maxAdverseProgressPct,
        mid: market.mid, bid: market.bid, ask: market.ask, spreadBps: ((market.ask - market.bid) / market.mid) * 10000,
        openInterest: market.openInterest, volume24hUsd: market.volume24hUsd,
      });
    }
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
  for (const observation of Object.values({ ...state.postExitObservations })) {
    const market = books.get(observation.symbol) || catalog.get(observation.symbol);
    if (!market?.bid || !market?.ask) continue;
    const elapsedMinutes = (now - observation.exitedAtMs) / 60000;
    for (const horizon of config.strengthShadowRules?.postExitHorizonsMinutes || []) {
      if (elapsedMinutes < horizon || observation.completedHorizons.includes(horizon)) continue;
      const hypotheticalExitPrice = simulatedFill(market, observation.direction, 'EXIT', config);
      const hypothetical = closeAccounting(observation, hypotheticalExitPrice, config);
      observation.completedHorizons.push(horizon);
      await record('WINNER_POST_EXIT_OUTCOME', {
        signalId: observation.id, symbol: observation.symbol, direction: observation.direction,
        actualExitReason: observation.actualExitReason, horizonMinutes: horizon,
        actualExitPrice: observation.actualExitPrice, hypotheticalExitPrice,
        actualNetPnlUsd: observation.actualNetPnlUsd, hypotheticalNetPnlUsd: hypothetical.netPnlUsd,
        improvementUsd: hypothetical.netPnlUsd - observation.actualNetPnlUsd,
      });
    }
    const horizons = config.strengthShadowRules?.postExitHorizonsMinutes || [];
    if (horizons.length && observation.completedHorizons.length === horizons.length) delete state.postExitObservations[observation.id];
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
