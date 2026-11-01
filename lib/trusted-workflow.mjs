import { evaluate } from './bank-engine.mjs';
import { ensureTrustedApproval, trustedGate } from './trusted-approval.mjs';

export function confirmTrusted(state, id, entries, classification, now, actualNow) {
  const op = state.operations.find(item => item.id === id && item.guardianApproval);
  if (!op) throw new Error('Нет операции для подтверждения доверенными лицами');
  const response = (allowed, code = op.code, reason = op.reason) => ({ operation: op, decision: { allowed, code, reason, classification: op.classification } });
  if (op.status === 'completed') return { ...response(true), duplicate: true };
  if (op.status !== 'pending') return response(false);
  // An existing bank review must go through confirmReviewed, never through this route.
  if (op.review) return response(false, 'MODEL_REVIEW', 'Сначала требуется решение сотрудника банка по этому переводу.');
  const request = { kind: op.kind, amount: op.amount, recipientId: op.recipientId, recipientName: op.recipientName, trustedOperationId: op.id };
  if (op.kind === 'transfer') request.classification = classification;
  const bank = evaluate(state, request, entries, now, { skipTrusted: true });
  op.classification = bank.classification ?? classification ?? null;
  if (!bank.allowed) {
    op.reason = bank.reason;
    if (bank.code === 'MODEL_REVIEW') { op.code = bank.code; op.review = { status: 'pending' }; }
    else if (!['REGISTRY_UNAVAILABLE', 'MODEL_UNAVAILABLE'].includes(bank.code)) { op.code = bank.code; op.status = 'blocked'; }
    return response(false, bank.code, bank.reason);
  }
  ensureTrustedApproval(state, op, actualNow);
  const gate = trustedGate(state, request, actualNow);
  if (gate) return response(false, gate.code, gate.reason);
  state.balance -= op.amount;
  op.status = 'completed'; op.code = 'COMPLETED'; op.completedAt = now; op.actualCompletedAt = actualNow;
  op.reason = 'Операция выполнена в демо после разрешения доверенных лиц и подтверждения клиентом.';
  state.events.unshift({ id: `EVENT-${state.nextId++}`, at: now, type: 'trusted-completed', actor: 'Клиент', text: `${op.id}: клиент подтвердил операцию после разрешения доверенных лиц.` });
  return response(true);
}
