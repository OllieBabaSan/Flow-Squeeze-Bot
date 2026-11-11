function finitePositive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function summarizeVenueDivergence(rows, symbol, selectedVenue) {
  const observations = rows
    .filter(row => row?.symbol === symbol)
    .map(row => ({
      venue: String(row.venue || ''),
      price: finitePositive(row.price),
      observedAt: Number(row.observedAt) || null,
      shadow: Boolean(row.shadow),
    }))
    .filter(row => row.venue && row.price != null)
    .sort((left, right) => left.venue.localeCompare(right.venue));

  if (!observations.length) return { available: false, symbol, selectedVenue, venueCount: 0, observations: [] };

  const prices = observations.map(row => row.price);
  const medianPrice = median(prices);
  const selected = observations.find(row => row.venue === selectedVenue) || null;
  const minimumPrice = Math.min(...prices);
  const maximumPrice = Math.max(...prices);
  const selectedVsMedianPct = selected ? ((selected.price / medianPrice) - 1) * 100 : null;
  const crossVenueRangePct = medianPrice ? ((maximumPrice - minimumPrice) / medianPrice) * 100 : null;
  const comparable = observations.length >= 3 && selectedVsMedianPct != null;
  const divergent = comparable && (Math.abs(selectedVsMedianPct) >= 1.5 || crossVenueRangePct >= 3);
  return {
    available: observations.length >= 2,
    symbol,
    selectedVenue,
    venueCount: observations.length,
    medianPrice,
    selectedPrice: selected?.price ?? null,
    selectedVsMedianPct,
    crossVenueRangePct,
    classification: !comparable ? 'INSUFFICIENT_COMPARABLE_VENUES' : divergent ? 'DIVERGENT_SHADOW' : 'CONSISTENT_SHADOW',
    researchExcluded: divergent,
    observations,
  };
}
