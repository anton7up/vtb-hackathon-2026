// Server-owned approval policy. Real clock only: the demo's +24h button cannot age approvals.
export const TRUSTED_TTL = 15 * 60 * 1000;
export const TRUSTED_WINDOW = 24 * 60 * 60 * 1000;
export function trustedPolicy(state) {
  return { enabled: false, limit: 1000000, dailyLimit: null, guardians: [], mode: 'any', revision: 0, ...state.trustedPolicy };
}
const fingerprint = op => JSON.stringify([op.id, op.kind, op.recipientId ?? null, op.recipientName, op.amount]);
const groupKey = guardians => JSON.stringify(guardians.map(g => g.id).sort());
function event(state, at, text, actor = 'Клиент') {
  state.events.unshift({ id: `EVENT-${state.nextId++}`, at, type: 'trusted-approval', actor, text });
}
// Only server-recorded real completion times enter this budget. Seeded history and
// legacy records without that timestamp are not evidence of a real recent debit.
export function rollingTrustedUsage(state, actualNow = Date.now()) {
  const policy = trustedPolicy(state);
  const seen = new Set();
  const completed = [...(state.operations || []), ...(state.trustedDebitHistory || [])].filter(op => !op.seeded && op.status === 'completed' && ['transfer', 'cash'].includes(op.kind)
    && Number.isSafeInteger(op.amount) && op.amount > 0 && Number.isFinite(op.actualCompletedAt)
    && op.actualCompletedAt > actualNow - TRUSTED_WINDOW && op.actualCompletedAt <= actualNow).filter(op => {
      const key = JSON.stringify([op.id, op.actualCompletedAt]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  const amount = completed.reduce((sum, op) => Math.min(Number.MAX_SAFE_INTEGER, sum + op.amount), 0);
  const limit = Number.isSafeInteger(policy.dailyLimit) && policy.dailyLimit > 0 ? policy.dailyLimit : null;
  return { enabled: policy.enabled === true && limit !== null, limit, amount, operationCount: completed.length,
    remaining: limit === null ? null : Math.max(0, limit - amount), windowMs: TRUSTED_WINDOW, asOf: actualNow };
}
function requirement(state, request, actualNow) {
  const policy = trustedPolicy(state);
  if (policy.enabled !== true || !['transfer', 'cash'].includes(request.kind) || !Number.isSafeInteger(request.amount) || request.amount <= 0) return [];
  const reasons = [];
  if (request.amount > policy.limit) reasons.push({ code: 'per_operation', limit: policy.limit });
  const usage = rollingTrustedUsage(state, actualNow);
  if (usage.enabled && request.amount > usage.limit - usage.amount) reasons.push({ code: 'rolling_24h', limit: usage.limit, spent: usage.amount, projected: usage.amount + request.amount, windowMs: TRUSTED_WINDOW });
  return reasons;
}
export function needsTrusted(state, request, actualNow = Date.now()) {
  return requirement(state, request, actualNow).length > 0;
}
function approval(state, actualNow) {
  const policy = trustedPolicy(state);
  return { id: `TRUST-${crypto.randomUUID()}`, status: 'pending', createdAt: actualNow, expiresAt: actualNow + TRUSTED_TTL,
    policyRevision: policy.revision, criticalChange: state.lastCriticalChange, mode: policy.mode,
    guardians: structuredClone(policy.guardians), votes: [] };
}
export function ensureTrustedApproval(state, op, actualNow) {
  if (!op.guardianApproval && op.status === 'pending' && needsTrusted(state, op, actualNow)) {
    if (state.operations.filter(item => item.id !== op.id && item.status === 'pending' && item.guardianApproval?.status === 'pending' && item.guardianApproval.expiresAt > actualNow).length >= 20) throw new Error('Нет возможности отправить ещё один запрос. Завершите или отмените предыдущие операции.');
    op.guardianApproval = { ...approval(state, actualNow), fingerprint: fingerprint(op), reasons: requirement(state, op, actualNow) };
  }
  return op.guardianApproval;
}
export function trustedChangeStatus(state, actualNow) {
  const a = state.trustedPolicyChange;
  if (!a || a.status !== 'pending') return a?.status ?? null;
  if (state.securityLock) return 'closed';
  if (a.policyRevision !== trustedPolicy(state).revision || a.criticalChange !== state.lastCriticalChange) return 'stale';
  return a.expiresAt <= actualNow ? 'expired' : 'pending';
}
export function trustedStatus(state, op, actualNow) {
  const a = op?.guardianApproval;
  if (!a) return needsTrusted(state, op || {}, actualNow) ? 'required' : 'not_required';
  if (op.status === 'completed') return 'completed';
  if (op.status !== 'pending') return a.status === 'rejected' ? 'rejected' : 'closed';
  if (a.fingerprint !== fingerprint(op) || a.policyRevision !== trustedPolicy(state).revision || a.criticalChange !== state.lastCriticalChange) return 'stale';
  if (a.expiresAt <= actualNow) return 'expired';
  return ['pending', 'approved', 'rejected'].includes(a.status) ? a.status : 'stale';
}
export function trustedGate(state, request, actualNow) {
  const op = typeof request.trustedOperationId === 'string' && state.operations.find(item => item.id === request.trustedOperationId);
  if (op && (op.kind !== request.kind || op.amount !== request.amount || op.recipientId !== (request.recipientId ?? null))) {
    return { code: 'TRUSTED_REQUIRED', reason: 'Подтверждение доверенного лица не относится к этой операции. Деньги не списаны.' };
  }
  const reasons = requirement(state, request, actualNow);
  if (!reasons.length && !op?.guardianApproval) return null;
  const status = op ? trustedStatus(state, op, actualNow) : 'required';
  if (status === 'approved') return null;
  const reason = status === 'expired' ? 'Срок подтверждения истёк. Создайте новую операцию для повторного запроса.'
    : status === 'stale' ? 'Настройки или данные доступа изменились. Создайте новую операцию для повторного запроса.'
    : status === 'rejected' ? 'Доверенное лицо отклонило операцию.'
    : reasons.some(item => item.code === 'rolling_24h') || op?.guardianApproval?.reasons?.some(item => item.code === 'rolling_24h')
      ? 'С учётом этой операции будет превышен ваш общий лимит за последние 24 часа. Нужно разрешение доверенных лиц. Разбиение на несколько переводов не обходит защиту. Деньги остаются на счёте.'
      : 'Сумма выше вашего лимита. Нужно разрешение доверенных лиц из выбранной группы. Деньги остаются на счёте.';
  return { code: 'TRUSTED_REQUIRED', reason };
}
export function configureTrusted(state, input, guardians, actualNow, at) {
  if (state.securityLock || (state.lastCriticalChange !== null && at < state.lastCriticalChange + 86400000)) throw new Error('Нет возможности менять доверенных лиц во время блокировки или защитной паузы');
  const old = trustedPolicy(state);
  const dailyLimit = input.dailyLimit === undefined ? old.dailyLimit : input.dailyLimit;
  if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.limit) || input.limit < 100 || input.limit > 100000000000 ||
      (dailyLimit !== null && (!Number.isSafeInteger(dailyLimit) || dailyLimit < 100 || dailyLimit > 100000000000)) ||
      !['any', 'all'].includes(input.mode) || (input.enabled && (!guardians.length || guardians.length > 5))) throw new Error('Укажите лимит от 1 ₽ и от одного до пяти доверенных лиц');
  const proposed = { enabled: input.enabled, limit: input.limit, dailyLimit, mode: input.mode, guardians: structuredClone(guardians) };
  const tighterDaily = old.dailyLimit === null || (proposed.dailyLimit !== null && proposed.dailyLimit <= old.dailyLimit);
  if (!old.enabled || (proposed.enabled && proposed.limit <= old.limit && tighterDaily && proposed.mode === old.mode && groupKey(proposed.guardians) === groupKey(old.guardians))) {
    state.trustedPolicy = { ...proposed, revision: old.revision + 1 };
    state.trustedPolicyChange = null;
    event(state, at, 'Настройка подтверждения операций и общего лимита за 24 часа сохранена.');
    return { pending: false };
  }
  const pending = state.trustedPolicyChange;
  if (pending?.status === 'pending' && pending.expiresAt > actualNow && pending.policyRevision === old.revision) throw new Error('Дождитесь решения по изменению настроек или отмените предыдущий запрос');
  state.trustedPolicyChange = { ...approval(state, actualNow), type: 'policy_change', proposed };
  event(state, at, 'Запрошено изменение защиты крупных операций. До решения доверенных лиц действуют прежние настройки.');
  return { pending: true };
}
export function cancelTrusted(state, body, at) {
  if (body.requestId && state.trustedPolicyChange?.id === body.requestId && state.trustedPolicyChange.status === 'pending') {
    state.trustedPolicyChange.status = 'cancelled';
  } else {
    const op = state.operations.find(item => item.id === body.operationId && item.status === 'pending' && item.guardianApproval);
    if (!op) throw new Error('Нет ожидающего запроса для отмены');
    op.status = 'blocked'; op.code = 'TRUSTED_CANCELLED'; op.reason = 'Клиент отменил операцию. Деньги не списаны.';
    op.guardianApproval.status = 'cancelled';
  }
  event(state, at, 'Клиент отменил ожидающий запрос доверенным лицам.');
}
export function decideTrusted(state, body, guardianId, actualNow, at) {
  const change = state.trustedPolicyChange;
  const op = state.operations.find(item => item.id === body.operationId && item.guardianApproval?.id === body.requestId);
  const a = body.operationId ? op?.guardianApproval : change?.id === body.requestId ? change : null;
  if (!a || !a.guardians.some(g => g.id === guardianId)) throw Object.assign(new Error('Запрос недоступен этому доверенному лицу'), { status: 403 });
  if (!['approve', 'reject'].includes(body.verdict)) throw new Error('Выберите подтверждение или отказ');
  const previous = a.votes.find(v => v.guardianId === guardianId);
  if (previous?.verdict === body.verdict) return { duplicate: true };
  if (previous) throw new Error('Нет возможности изменить уже сохранённое решение');
  const status = op ? trustedStatus(state, op, actualNow) : a.policyRevision !== trustedPolicy(state).revision || a.criticalChange !== state.lastCriticalChange ? 'stale' : a.expiresAt <= actualNow ? 'expired' : a.status;
  if (state.securityLock || status !== 'pending') throw new Error('Нет действующего запроса: он завершён, изменился или истёк');
  a.votes.push({ guardianId, verdict: body.verdict, at: actualNow });
  if (body.verdict === 'reject') {
    a.status = 'rejected';
    if (op) { op.status = 'blocked'; op.code = 'TRUSTED_REJECTED'; op.reason = 'Доверенное лицо отклонило операцию. Деньги не списаны.'; }
  } else if (a.mode === 'any' || a.guardians.every(g => a.votes.some(v => v.guardianId === g.id && v.verdict === 'approve'))) {
    a.status = 'approved'; a.approvedAt = actualNow;
    if (!op) state.trustedPolicy = { ...structuredClone(a.proposed), revision: trustedPolicy(state).revision + 1 };
  }
  event(state, at, `${op ? `Операция ${op.id}` : 'Изменение настроек защиты'}: сохранено решение доверенного лица. Автоматического списания нет.`, 'Доверенное лицо');
  return { status: a.status };
}
export function trustedRequests(state, owner, guardianId, actualNow) {
  const requests = [];
  const add = (a, op) => {
    if (!a?.guardians.some(g => g.id === guardianId)) return;
    let status = op ? trustedStatus(state, op, actualNow) : trustedChangeStatus(state, actualNow);
    if (state.securityLock && status === 'pending') status = 'closed';
    requests.push({ requestId: a.id, ownerClientId: owner.id, ownerName: owner.name,
      operationId: op?.id ?? null, type: op ? 'operation' : 'policy_change',
      kind: op?.kind, recipientName: op?.recipientName, amount: op?.amount,
      createdAt: a.createdAt, expiresAt: a.expiresAt, status, mode: a.mode,
      approvals: a.votes.filter(v => v.verdict === 'approve').length, required: a.mode === 'all' ? a.guardians.length : 1,
      myVerdict: a.votes.find(v => v.guardianId === guardianId)?.verdict ?? null,
      ...(op ? { reasons: structuredClone(a.reasons || []) } : { proposed: { enabled: a.proposed.enabled, limit: a.proposed.limit, dailyLimit: a.proposed.dailyLimit ?? null, mode: a.proposed.mode, names: a.proposed.guardians.map(g => g.name) } }),
    });
  };
  for (const op of state.operations) add(op.guardianApproval, op);
  add(state.trustedPolicyChange, null);
  return requests;
}
