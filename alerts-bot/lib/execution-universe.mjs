const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000;

function normalizedSymbols(values) {
  return [...new Set([...values].map(value => String(value || '').trim()).filter(Boolean))].sort();
}

export function resolveExecutionUniverse({ liveSymbols = [], cached = {}, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const live = normalizedSymbols(liveSymbols);
  if (live.length) {
    return { symbols: new Set(live), source: 'LIVE', updatedAtMs: now, ageMs: 0 };
  }

  const cachedSymbols = normalizedSymbols(cached.symbols || []);
  const updatedAtMs = Number(cached.updatedAtMs || 0);
  const ageMs = updatedAtMs ? Math.max(0, now - updatedAtMs) : Infinity;
  if (cachedSymbols.length && ageMs <= maxAgeMs) {
    return { symbols: new Set(cachedSymbols), source: 'CACHED', updatedAtMs, ageMs };
  }
  return { symbols: new Set(), source: 'UNAVAILABLE', updatedAtMs, ageMs };
}

export const EXECUTION_UNIVERSE_CACHE_VERSION = 1;
