export const SUPPORTED_FLOW_SIGNAL_SCHEMA_VERSION = 1;

export function legacySignalId(row) {
  return `${row?.alertedAt}:${row?.market?.venue}:${row?.market?.symbol}:${row?.detection?.direction}`;
}

export function normalizeFlowSignal(row, receivedAtMs = Date.now()) {
  const schemaVersion = row?.schemaVersion == null ? 0 : Number(row.schemaVersion);
  if (![0, SUPPORTED_FLOW_SIGNAL_SCHEMA_VERSION].includes(schemaVersion)) {
    return { valid: false, reason: 'UNSUPPORTED_SIGNAL_SCHEMA', schemaVersion };
  }
  const createdAt = row?.createdAt || row?.alertedAt;
  const createdAtMs = Date.parse(createdAt);
  const recordedAtMs = Date.parse(row?.recordedAt);
  const signalId = String(row?.signalId || legacySignalId(row));
  if (!signalId || !(createdAtMs > 0)) return { valid: false, reason: 'INVALID_SIGNAL_ID_OR_TIME', schemaVersion };
  return {
    valid: true,
    signalId,
    schemaVersion,
    detectorVersion: row?.detectorVersion || 'legacy-unversioned',
    publicationStatus: row?.publicationStatus || (row?.market?.shadow ? 'SHADOW' : 'PUBLISHED'),
    createdAt,
    createdAtMs,
    recordedAt: Number.isFinite(recordedAtMs) ? row.recordedAt : null,
    receiptLagMs: Math.max(0, receivedAtMs - createdAtMs),
    fileToConsumerLagMs: Number.isFinite(recordedAtMs) ? Math.max(0, receivedAtMs - recordedAtMs) : null,
    producerRecordingLagMs: Number.isFinite(recordedAtMs) ? Math.max(0, recordedAtMs - createdAtMs) : null,
  };
}
