const DEFAULT_RATES = Object.freeze({
  QUALIFIED_SHADOW: 1,
  WATCH_SHADOW: 0.1,
  LOW_QUALITY_SHADOW: 0.05,
  ACTIVITY_MISSING_SHADOW: 0.05,
});

function stableUnitInterval(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export function evaluateBreakoutAdmission({
  episodeId,
  episodeKey,
  direction,
  qualityStatus,
  now,
  recentAdmissions = {},
  cooldownMs = 60 * 60_000,
  rates = DEFAULT_RATES,
}) {
  const cooldownKey = `${episodeKey}:${direction}`;
  const lastAdmittedAt = Number(recentAdmissions[cooldownKey] || 0);
  if (lastAdmittedAt && now - lastAdmittedAt < cooldownMs) {
    return { admitted: false, reason: 'SAME_DIRECTION_COOLDOWN', cooldownKey, lastAdmittedAt };
  }

  const rate = Number(rates[qualityStatus] ?? 0.05);
  const sampleValue = stableUnitInterval(`${episodeId}:${qualityStatus}`);
  if (sampleValue >= rate) {
    return { admitted: false, reason: 'QUALITY_CONTROL_SAMPLE', cooldownKey, rate, sampleValue };
  }
  return { admitted: true, reason: 'ADMITTED', cooldownKey, rate, sampleValue };
}

export const BREAKOUT_ADMISSION_VERSION = 'breakout-admission-v1';
