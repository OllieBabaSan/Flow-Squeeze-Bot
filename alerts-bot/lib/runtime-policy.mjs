const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

export function flowAlertCooldownMs(env = process.env) {
  const hours = Number(env.FLOW_ALERT_COOLDOWN_HOURS ?? 24);
  return Number.isFinite(hours) && hours >= 12 ? hours * HOUR : 24 * HOUR;
}

export function createRateLimitBackoff({ minimumMs = 40 * SECOND, maximumMs = 5 * 60 * SECOND } = {}) {
  let delayMs = 0;
  let until = 0;
  return {
    remainingMs(now = Date.now()) { return Math.max(0, until - now); },
    reject(status, retryAfter = '', now = Date.now()) {
      if (Number(status) !== 429) return 0;
      const retryAfterMs = Number(retryAfter) > 0 ? Number(retryAfter) * SECOND : 0;
      delayMs = Math.min(maximumMs, Math.max(minimumMs, retryAfterMs, delayMs ? delayMs * 2 : 0));
      until = now + delayMs;
      return delayMs;
    },
    success() { delayMs = 0; until = 0; },
  };
}
