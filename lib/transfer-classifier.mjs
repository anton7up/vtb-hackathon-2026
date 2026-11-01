// Server-only adapter. Replace this mock with an ML request without changing the bank policy.
import { demoRecipientClass } from './demo-class-recipients.mjs';
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
const decisionClasses = Object.freeze(['normal', 'review', 'block']);
export const TRANSFER_MODEL_FEATURES = Object.freeze(['hour', 'dow', 'night', 'amount', 'sender_balance', 'amount_ratio', 'is_new_payee', 'payee_tx_before', 'days_since_first_payee', 'sender_tx_before', 'amount_to_avg', 'receiver_tx_before', 'is_round']);
function transferModelUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/classify') throw new Error('Invalid transfer model URL');
  return url.href;
}
export function transferModelPayload(state, request, now, clientId = 'client-demo', sharedHistory = null) {
  const currentId = request.id || null, currentRequestId = request.requestId || null;
  const history = Array.isArray(sharedHistory) ? sharedHistory.slice(-10000) : state.operations.filter(op => op.kind === 'transfer' && op.id !== currentId && (!currentRequestId || op.requestId !== currentRequestId) && Number.isFinite(op.createdAt) && op.createdAt <= now && Number.isSafeInteger(op.amount) && op.amount > 0 && typeof op.recipientId === 'string')
    .sort((a, b) => a.createdAt - b.createdAt).slice(-10000)
    .map(op => ({ timestamp: new Date(op.createdAt).toISOString(), sender_id: clientId, sender_balance: state.balance / 100, amount: op.amount / 100, receiver_id: op.recipientId }));
  return { operation: { timestamp: new Date(now).toISOString(), sender_id: clientId, sender_balance: state.balance / 100, amount: request.amount / 100, receiver_id: request.recipientId }, history };
}
async function classifyWithModel(state, request, now, runtime, clientId, sharedHistory) {
  try {
    const response = await (runtime.transferModelFetch || fetch)(transferModelUrl(runtime.TRANSFER_MODEL_URL), {
      method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(transferModelPayload(state, request, now, clientId, sharedHistory)),
    });
    if (!response.ok) return null;
    const raw = await response.json();
    const features = raw?.features, thresholds = raw?.thresholds;
    if (!Number.isInteger(raw?.decision) || !decisionClasses[raw.decision] || !Number.isFinite(raw.p_fraud) || raw.p_fraud < 0 || raw.p_fraud > 1 || typeof raw.model_version !== 'string' || !raw.model_version || raw.model_version.length > 80
      || !features || Object.keys(features).sort().join(',') !== [...TRANSFER_MODEL_FEATURES].sort().join(',') || TRANSFER_MODEL_FEATURES.some(name => !Number.isFinite(features[name]))
      || !Number.isFinite(thresholds?.review) || !Number.isFinite(thresholds?.block) || thresholds.review < 0 || thresholds.block <= thresholds.review || thresholds.block > 1) return null;
    return { class: decisionClasses[raw.decision], model_version: raw.model_version, source: 'ml', evaluated_at: now, p_fraud: raw.p_fraud,
      thresholds: { review: thresholds.review, block: thresholds.block }, model_features: Object.fromEntries(TRANSFER_MODEL_FEATURES.map(name => [name, features[name]])) };
  } catch { return null; }
}
export async function classifyTransfer(state, request, now, runtime = {}, clientId = 'client-demo', sharedHistory = null) {
  if (typeof runtime.TRANSFER_MODEL_URL === 'string' && runtime.TRANSFER_MODEL_URL.trim()) return await classifyWithModel(state, request, now, runtime, clientId, sharedHistory);
  // The mock does not predict fraud. Its response is selected by staff for the demonstration.
  const config = mockConfig(state);
  const fixedClass = demoRecipientClass(request.recipientId);
  const raw = fixedClass ? { class: fixedClass, model_version: 'mock-recipient-v1' } : config.mode === 'unavailable' ? null : { class: config.mode, model_version: 'mock-v1' };
  const result = normalizeClassification(raw);
  return result ? { ...result, source: 'mock', evaluated_at: now, config_revision: config.revision } : null;
}
