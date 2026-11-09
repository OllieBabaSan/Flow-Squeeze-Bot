export function indexConfirmationDispositions(events = []) {
  const byId = new Map();
  for (const event of events) {
    if (event?.type !== 'confirmation_disposition' || !event.id || !event.status) continue;
    const { id, type, ...disposition } = event;
    byId.set(String(id), disposition);
  }
  return byId;
}

export function reconcileConfirmationDisposition(record, dispositionsById) {
  if (record?.confirmationDisposition || !record?.id) return record;
  const disposition = dispositionsById.get(String(record.id));
  return disposition ? { ...record, confirmationDisposition: disposition } : record;
}
