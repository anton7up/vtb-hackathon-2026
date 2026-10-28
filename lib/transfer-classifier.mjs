// Server-only adapter. Replace this mock with an ML request without changing the bank policy.
export const TRANSFER_CLASSES = Object.freeze(['normal', 'review', 'block']);
export function mockConfig(state) { return state.modelMock || { mode: 'normal', revision: 0 }; }
export function normalizeClassification(raw) {
  if (!raw || !TRANSFER_CLASSES.includes(raw.class) || typeof raw.model_version !== 'string' || !raw.model_version.trim() || raw.model_version.length > 80) return null;
  return { class: raw.class, model_version: raw.model_version };
}
export function transferFeatures(state, request, now) {
  const recent = state.operations.filter(op => !op.seeded && op.kind === 'transfer' && op.createdAt > now - 3600000 && op.createdAt <= now);
  const recentChange = state.lastCriticalChange !== null && now - state.lastCriticalChange < 86400000;
  const cutoff = recentChange ? state.lastCriticalChange : now + 1;
  return {
    amount_kopecks: request.amount, recipient_id: request.recipientId,
    is_new_recipient: !state.operations.some(op => op.kind === 'transfer' && op.status === 'completed' && op.recipientId === request.recipientId && (op.completedAt ?? op.createdAt) < cutoff),
    recorded_transfers_last_hour: recent.length,
    completed_amount_last_hour_kopecks: state.operations.filter(op => !op.seeded && op.kind === 'transfer' && op.status === 'completed' && (op.completedAt ?? op.createdAt) > now - 3600000 && (op.completedAt ?? op.createdAt) <= now).reduce((n, op) => n + op.amount, 0),
    access_changed_last_24h: recentChange,
  };
}
export async function classifyTransfer(state, request, now) {
  // The mock does not predict fraud. Its response is selected by staff for the demonstration.
  const config = mockConfig(state);
  const raw = config.mode === 'unavailable' ? null : { class: config.mode, model_version: 'mock-v1' };
  const result = normalizeClassification(raw);
  return result ? { ...result, source: 'mock', evaluated_at: now, config_revision: config.revision } : null;
}
