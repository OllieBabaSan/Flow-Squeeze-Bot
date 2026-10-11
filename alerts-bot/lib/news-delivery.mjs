export function contextApproval(verdict, candidateAsset, minimumConfidence = 0.82) {
  const asset = value => String(value || '').toUpperCase().replace(/^\$/, '').replace(/[^A-Z0-9]/g, '');
  if (!verdict?.context_worthy || !verdict.useful) return { approved: false, reason: 'not_context_worthy' };
  if (verdict.relationship !== 'direct') return { approved: false, reason: 'asset_not_directly_affected' };
  if (asset(verdict.affected_asset) !== asset(candidateAsset)) return { approved: false, reason: 'asset_mismatch' };
  if (!verdict.canonical_event_id) return { approved: false, reason: 'missing_canonical_event' };
  if (Number(verdict.confidence) < minimumConfidence) return { approved: false, reason: 'low_confidence' };
  return { approved: true, reason: 'context_approved' };
}

export function classifyNewsDelivery({ sourceKind, editorial, canonicalEvents = {} }) {
  const eventId = String(editorial?.verdict?.canonical_event_id || '').trim();
  const prior = eventId ? canonicalEvents[eventId] : null;
  if (sourceKind === 'primary_x' && editorial?.approved) return { deliver: true, kind: 'PRIMARY_ALERT', eventId, ping: true };
  if (sourceKind !== 'primary_x' && editorial?.contextApproved && prior?.primarySeenAt && !prior?.contextSentAt) {
    return { deliver: true, kind: 'CONTEXT_UPDATE', eventId, ping: false };
  }
  if (sourceKind !== 'primary_x' && editorial?.approved && !prior?.primarySeenAt) {
    return { deliver: true, kind: 'NEWS_FALLBACK_ALERT', eventId, ping: true };
  }
  return { deliver: false, kind: 'IGNORE', eventId, ping: false };
}
