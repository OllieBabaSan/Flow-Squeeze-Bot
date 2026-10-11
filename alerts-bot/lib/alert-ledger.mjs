import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readJsonWithBackup, writeJsonAtomic } from './state-file.mjs';

const HORIZONS = [1, 3, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];

export function createAlertLedger({ ledgerPath, outcomeStatePath, outcomeArchivePath = '' }) {
  let queue = Promise.resolve();
  const serialized = task => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  const appendRaw = async event => {
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { flag: 'a' });
  };
  const appendRawMany = async events => {
    if (!events.length) return;
    await mkdir(dirname(ledgerPath), { recursive: true });
    const at = new Date().toISOString();
    await writeFile(ledgerPath, `${events.map(event => JSON.stringify({ at, ...event })).join('\n')}\n`, { flag: 'a' });
  };
  const archiveMany = async records => {
    if (!outcomeArchivePath || !records.length) return;
    await mkdir(dirname(outcomeArchivePath), { recursive: true });
    const archivedAt = new Date().toISOString();
    await writeFile(outcomeArchivePath, `${records.map(record => JSON.stringify({ archivedAt, ...record })).join('\n')}\n`, { flag: 'a' });
  };
  const readState = () => readJsonWithBackup(outcomeStatePath, { records: {} });

  const reserveMany = alerts => serialized(async () => {
    if (!alerts.length) return;
    const state = await readState();
    const reservedAt = new Date().toISOString();
    for (const alert of alerts) state.records[alert.id] = {
      ...alert, reservedAt: alert.reservedAt || reservedAt, horizons: {},
      maxFavorablePct: 0, maxAdversePct: 0, status: 'reserved',
    };
    await writeJsonAtomic(outcomeStatePath, state);
    await appendRawMany(alerts.map(alert => ({ type: 'alert_reserved', ...alert })));
  });

  const deliveryMany = (updates, details = {}) => serialized(async () => {
    if (!updates.length) return;
    const state = await readState();
    for (const update of updates) if (state.records[update.id]) state.records[update.id].status = update.status;
    await writeJsonAtomic(outcomeStatePath, state);
    await appendRawMany(updates.map(update => ({ type: 'delivery', ...update, ...details })));
  });

  const annotateMany = updates => serialized(async () => {
    if (!updates.length) return;
    const state = await readState();
    for (const update of updates) if (state.records[update.id]) Object.assign(state.records[update.id], update.details || {});
    await writeJsonAtomic(outcomeStatePath, state);
    await appendRawMany(updates.map(update => ({ type: 'annotation', id: update.id, ...(update.details || {}) })));
  });

  return {
    append: event => serialized(() => appendRaw(event)),
    reserve: alert => reserveMany([alert]),
    reserveMany,
    delivery: (id, status, details = {}) => deliveryMany([{ id, status }], details),
    deliveryMany,
    annotate: (id, details = {}) => annotateMany([{ id, details }]),
    annotateMany,
    pending: kind => serialized(async () => {
      const state = await readState();
      return Object.values(state.records).filter(record => record.kind === kind && !record.completedAt && Number(record.entryPrice) > 0);
    }),
    recent: ({ symbol, since, kinds = [] }) => serialized(async () => {
      const state = await readState();
      return Object.values(state.records).filter(record =>
        (!symbol || record.symbol === symbol)
        && (!kinds.length || kinds.includes(record.kind))
        && Date.parse(record.entryAt || record.reservedAt) >= since);
    }),
    observe: (kind, quotes, now = Date.now()) => serialized(async () => {
      const state = await readState();
      const outcomes = [];
      for (const record of Object.values(state.records)) {
        if (record.kind !== kind || record.completedAt || !(Number(record.entryPrice) > 0)) continue;
        const price = Number(quotes.get(record.quoteKey));
        if (!(price > 0)) continue;
        const entryTime = Date.parse(record.entryAt || record.reservedAt);
        const elapsedMinutes = (now - entryTime) / 60000;
        if (elapsedMinutes < 0) continue;
        const rawReturnPct = ((price / Number(record.entryPrice)) - 1) * 100;
        const directedReturnPct = rawReturnPct * (record.direction === 'BEARISH' ? -1 : 1);
        const benchmarkPrice = Number(record.benchmarkQuoteKey ? quotes.get(record.benchmarkQuoteKey) : 0);
        const benchmarkReturnPct = benchmarkPrice > 0 && Number(record.benchmarkEntryPrice) > 0
          ? ((benchmarkPrice / Number(record.benchmarkEntryPrice)) - 1) * 100 : null;
        const abnormalReturnPct = benchmarkReturnPct == null ? null : rawReturnPct - benchmarkReturnPct;
        const directedAbnormalReturnPct = abnormalReturnPct == null || !['BULLISH', 'BEARISH'].includes(record.direction)
          ? null : abnormalReturnPct * (record.direction === 'BEARISH' ? -1 : 1);
        record.maxFavorablePct = Math.max(Number(record.maxFavorablePct || 0), directedReturnPct);
        record.maxAdversePct = Math.min(Number(record.maxAdversePct || 0), directedReturnPct);
        record.lastPrice = price;
        record.lastObservedAt = new Date(now).toISOString();
        for (const horizon of HORIZONS) {
          if (elapsedMinutes < horizon || record.horizons[horizon]) continue;
          const result = {
            observedAt: new Date(now).toISOString(), price,
            rawReturnPct: Number(rawReturnPct.toFixed(4)),
            directedReturnPct: Number(directedReturnPct.toFixed(4)),
            maxFavorablePct: Number(record.maxFavorablePct.toFixed(4)),
            maxAdversePct: Number(record.maxAdversePct.toFixed(4)),
            ...(benchmarkReturnPct == null ? {} : {
              benchmarkPrice,
              benchmarkReturnPct: Number(benchmarkReturnPct.toFixed(4)),
              abnormalReturnPct: Number(abnormalReturnPct.toFixed(4)),
              directedAbnormalReturnPct: directedAbnormalReturnPct == null ? null : Number(directedAbnormalReturnPct.toFixed(4)),
            }),
          };
          const dailyVolatility = Number(record.preEventDailyVolatilityPct);
          if (dailyVolatility > 0) {
            result.expectedMovePct = Number((dailyVolatility * Math.sqrt(horizon / 1440)).toFixed(4));
            result.absoluteMovementToCatalystRatio = Number((Math.abs(abnormalReturnPct || 0) / result.expectedMovePct).toFixed(4));
            result.directionalMovementToCatalystRatio = directedAbnormalReturnPct == null ? null
              : Number((directedAbnormalReturnPct / result.expectedMovePct).toFixed(4));
          }
          record.horizons[horizon] = result;
          outcomes.push({ type: 'outcome', id: record.id, kind, symbol: record.symbol, direction: record.direction, horizonMinutes: horizon, ...result });
        }
        if (elapsedMinutes >= 1440 && record.horizons[1440]) record.completedAt = new Date(now).toISOString();
      }
      const retention = now - 30 * 86400_000;
      const archived = [];
      state.records = Object.fromEntries(Object.entries(state.records).filter(([, record]) => {
        if (record.completedAt) { archived.push(record); return false; }
        return Date.parse(record.reservedAt) >= retention;
      }));
      // Archive before removing records from active state. A crash between these
      // operations can duplicate an archive line, but can never lose the record;
      // consumers deduplicate by the stable record id.
      await archiveMany(archived);
      await writeJsonAtomic(outcomeStatePath, state);
      for (const outcome of outcomes) await appendRaw(outcome);
      return outcomes;
    }),
  };
}

export { HORIZONS };
