export const VENUE_HEALTH_VERSION = 1;

export function updateVenueHealth(existing = {}, reports = [], now = Date.now()) {
  const state = {
    schemaVersion: VENUE_HEALTH_VERSION,
    startedAt: existing.startedAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    venues: { ...(existing.venues || {}) },
  };
  const events = [];
  for (const report of reports) {
    const venue = String(report.venue || 'UNKNOWN');
    const previous = state.venues[venue] || {};
    const status = report.status || (report.ok ? 'HEALTHY' : 'FAILED');
    const healthy = status === 'HEALTHY';
    const failed = status === 'FAILED';
    const next = {
      attempts: Number(previous.attempts || 0) + 1,
      successes: Number(previous.successes || 0) + (healthy ? 1 : 0),
      partials: Number(previous.partials || 0) + (status === 'PARTIAL' ? 1 : 0),
      failures: Number(previous.failures || 0) + (failed ? 1 : 0),
      consecutiveFailures: failed ? Number(previous.consecutiveFailures || 0) + 1 : 0,
      status,
      marketCount: Number(report.marketCount || 0),
      durationMs: Number.isFinite(Number(report.durationMs)) ? Math.round(Number(report.durationMs)) : null,
      failedRequests: Number(report.failedRequests || 0),
      totalRequests: Number(report.totalRequests || 0),
      lastError: report.error ? String(report.error) : null,
      lastAttemptAt: new Date(now).toISOString(),
      lastSuccessAt: failed ? previous.lastSuccessAt || null : new Date(now).toISOString(),
      lastFailureAt: failed || status === 'PARTIAL' ? new Date(now).toISOString() : previous.lastFailureAt || null,
    };
    if (previous.status && previous.status !== status) {
      events.push({ at: new Date(now).toISOString(), venue, from: previous.status, to: status,
        event: healthy ? 'RECOVERED' : status === 'PARTIAL' ? 'DEGRADED' : 'FAILED', report });
    } else if (!previous.status && !healthy) {
      events.push({ at: new Date(now).toISOString(), venue, from: null, to: status,
        event: status === 'PARTIAL' ? 'DEGRADED' : 'FAILED', report });
    }
    state.venues[venue] = next;
  }
  return { state, events };
}

export function venueHealthSummary(state = {}) {
  return Object.entries(state.venues || {}).map(([venue, item]) =>
    `${venue}:${item.status || 'UNKNOWN'}:${item.marketCount || 0}:${item.durationMs ?? 'n/a'}ms`).join(',');
}
