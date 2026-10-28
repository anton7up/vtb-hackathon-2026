import { evaluate } from './bank-engine.mjs';
import { mockConfig } from './transfer-classifier.mjs';

const APPROVAL_MS = 15 * 60 * 1000;
function audit(state, now, text, actor) {
  state.events.unshift({ id: `EVENT-${state.nextId++}`, at: now, type: 'transfer-review', actor, text });
}
function find(state, id) {
  const op = state.operations.find(op => op.id === id && op.kind === 'transfer');
  if (!op) throw new Error('Нет перевода для проверки');
  return op;
}
function baseRequest(op) { return { kind: op.kind, amount: op.amount, recipientId: op.recipientId, recipientName: op.recipientName }; }
function invalidate(op, reason) { op.review = { status: 'pending' }; op.code = 'MODEL_REVIEW'; op.reason = reason; }
export function decideReview(state, id, verdict, comment, entries, classification, now, actualNow, actor) {
  const op = find(state, id);
  if (!['approve', 'reject'].includes(verdict) || typeof comment !== 'string' || comment.trim().length < 5) throw new Error('Укажите решение и комментарий не короче 5 символов');
  if (op.status !== 'pending' || op.code !== 'MODEL_REVIEW' || !op.review) throw new Error('Нет перевода, ожидающего решения сотрудника');
  if (op.review.status === 'approved' && op.review.expiresAt <= actualNow) invalidate(op, 'Срок проверки истёк. Требуется новое решение сотрудника.');
  if (op.review.status !== 'pending') throw new Error('Нет перевода, ожидающего нового решения сотрудника');
  if (verdict === 'approve') {
    if (op.aiPendingUntil > actualNow) throw new Error('Дождитесь завершения ИИ-проверки перед решением сотрудника');
    const hard = evaluate(state, baseRequest(op), entries, now);
    if (!hard.allowed) throw new Error(`Нет возможности разрешить перевод: ${hard.reason}`);
    if (!classification || classification.class === 'block') throw new Error('Нет разрешения: классификатор недоступен или вернул блокировку');
  }
  op.review = { status: verdict === 'approve' ? 'approved' : 'rejected', comment: comment.trim().slice(0, 1000), decidedAt: now, decidedBy: actor, expiresAt: actualNow + APPROVAL_MS, configRevision: mockConfig(state).revision, criticalChange: state.lastCriticalChange };
  if (verdict === 'reject') { op.status = 'blocked'; op.code = 'MODEL_REVIEW_REJECTED'; op.reason = 'Сотрудник отклонил перевод после проверки. Деньги не списаны.'; }
  else op.reason = 'Сотрудник разрешил продолжить. Для списания требуется отдельное подтверждение клиента в течение 15 минут.';
  audit(state, now, `${op.id}: ${verdict === 'approve' ? 'разрешено подтверждение клиентом' : 'перевод отклонён'}. ${op.review.comment}`, 'Сотрудник');
  return op;
}
export function confirmReviewed(state, id, entries, classification, now, actualNow) {
  const op = find(state, id);
  const response = (allowed, code = op.code, reason = op.reason) => ({ operation: op, decision: { allowed, code, reason, classification: op.classification } });
  if (op.status === 'completed') return { ...response(true), duplicate: true };
  if (op.status !== 'pending' || op.code !== 'MODEL_REVIEW' || op.review?.status !== 'approved') return response(false);
  if (op.aiPendingUntil > actualNow) return response(false, 'AI_CHECK_PENDING', 'Дождитесь завершения ИИ-проверки. Деньги не списаны.');
  // Approval is bound to this saved operation. Client-supplied amount/recipient are never used.
  const hard = evaluate(state, baseRequest(op), entries, now);
  if (!hard.allowed) {
    op.code = hard.code; op.reason = hard.reason;
    op.status = hard.code === 'REGISTRY_UNAVAILABLE' ? 'pending' : 'blocked';
    op.review.status = 'invalidated';
    return response(false);
  }
  if (!classification || classification.class === 'block') {
    op.code = classification ? 'MODEL_BLOCK' : 'MODEL_UNAVAILABLE';
    op.reason = classification ? 'Повторная проверка вернула «Блокировка». Перевод остановлен.' : 'Повторная проверка недоступна. Деньги не списаны; требуется новая проверка.';
    op.status = classification ? 'blocked' : 'pending'; op.review.status = 'invalidated';
    op.classification = classification;
    return response(false);
  }
  if (op.review.expiresAt <= actualNow || op.review.configRevision !== mockConfig(state).revision || op.review.criticalChange !== state.lastCriticalChange) {
    invalidate(op, 'Условия или срок проверки изменились. Требуется новое решение сотрудника. Деньги не списаны.');
    return response(false);
  }
  state.balance -= op.amount;
  op.status = 'completed'; op.code = 'COMPLETED'; op.reason = 'Перевод выполнен в демо после проверки сотрудником и подтверждения клиентом.';
  op.completedAt = now;
  audit(state, now, `${op.id}: клиент подтвердил проверенный перевод. Списано только с демонстрационного баланса.`, 'Клиент');
  return response(true);
}
