export const DEFAULT_MAX_DISPATCH_AGE_MINUTES = 30;
export const ALERT_SCOPE_HOUR_MS = 60 * 60 * 1000;
export const ALERT_SCOPE_DAY_MS = 24 * ALERT_SCOPE_HOUR_MS;

export function dispatchDecision(signal, now = Date.now(), maxAgeMinutes = DEFAULT_MAX_DISPATCH_AGE_MINUTES) {
  if (!['HIGH', 'WATCH'].includes(signal.level) || signal.score < 65 || signal.actionability !== 'ACTIONABLE' || signal.tokens?.length !== 1) {
    return { eligible: false, reason: 'not_qualifying' };
  }
  const published = Date.parse(signal.publishedAt);
  if (!Number.isFinite(published)) return { eligible: false, reason: 'invalid_timestamp' };
  const ageMinutes = Math.floor((now - published) / 60000);
  if (ageMinutes < -5) return { eligible: false, reason: 'future_timestamp' };
  if (ageMinutes > maxAgeMinutes) return { eligible: false, reason: 'stale' };
  if (signal.opportunityStatus === 'LATE_CHASE_RISK') return { eligible: false, reason: 'late_chase' };
  return { eligible: true, reason: 'fresh', ageMinutes: Math.max(0, ageMinutes) };
}

export function eventKey(signal) {
  const stop = new Set(['a','an','and','as','at','by','for','from','in','is','of','on','the','to','with']);
  const words = String(signal.title || '').toLowerCase().replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter(x => x && !stop.has(x)).slice(0, 16);
  return `${signal.tokens?.[0] || 'UNKNOWN'}:${signal.eventType || 'UNKNOWN'}:${words.join('-')}`;
}

export function alertScopeKey(signal) {
  const token = String(signal.tokens?.[0] || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const chain = String(signal.marketClassification?.chain || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${token}:${chain}`;
}

export function alertFrequencyDecision(timestamps = [], now = Date.now()) {
  const recent = [...new Set(timestamps.map(value => typeof value === 'number' ? value : Date.parse(value)).filter(value => Number.isFinite(value) && value <= now && value > now - ALERT_SCOPE_DAY_MS))];
  const hourCount = recent.filter(value => value > now - ALERT_SCOPE_HOUR_MS).length;
  if (hourCount >= 1) return { eligible: false, reason: 'scope_hourly_limit', hourCount, dayCount: recent.length };
  if (recent.length >= 3) return { eligible: false, reason: 'scope_daily_limit', hourCount, dayCount: recent.length };
  return { eligible: true, reason: 'scope_available', hourCount, dayCount: recent.length };
}
