// Educational recovery only. Authentication, roles and atomic session revocation
// are enforced by the API; this module never verifies a real person's identity.
export const RECOVERY_TTL = 15 * 60 * 1000;
export const RECOVERY_CHECKS = ['knownChannel', 'incidentReviewed', 'accessSecured'];
const proofValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const lockKey = state => JSON.stringify([state.securityLock?.alertId, state.securityLock?.at,
  state.securityLock?.reporterSessionHash, state.lastCriticalChange ?? null]);
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function audit(state, at, text, actor = 'Клиент') {
  state.events ??= [];
  state.events.unshift({ id: `EVENT-${state.nextId++}`, at, type: 'security-recovery', actor, text });
}
function continuity(state, sessionHash) {
  const proof = state.securityLock?.reporterSessionHash;
  return proofValid(proof) && proofValid(sessionHash) && proof === sessionHash;
}
function requireContinuity(state, sessionHash) {
  if (!state.securityLock) fail('Нет защитной блокировки для восстановления.');
  if (!continuity(state, sessionHash)) fail('Продолжить можно только из старой сессии, в которой вы сообщили «Это был не я». Если она утрачена, нужна проверка по независимому каналу банка; в прототипе она не реализована.', 403);
}
export function recoveryStatus(state, actualNow) {
  const request = state.securityRecovery;
  if (!request) return null;
  if (request.status === 'completed' && !state.securityLock) return 'completed';
  if (!state.securityLock || request.lockKey !== lockKey(state)) return 'stale';
  if (['pending', 'approved'].includes(request.status) && request.expiresAt <= actualNow) return 'expired';
  return request.status;
}
export function requestSecurityRecovery(state, sessionHash, actualNow, at) {
  requireContinuity(state, sessionHash);
  const status = recoveryStatus(state, actualNow);
  if (['pending', 'approved'].includes(status)) return { requestId: state.securityRecovery.id, status, duplicate: true };
  if (state.securityRecovery) {
    state.securityRecoveryHistory ??= [];
    state.securityRecoveryHistory.unshift({ ...structuredClone(state.securityRecovery), status: status || state.securityRecovery.status });
    state.securityRecoveryHistory = state.securityRecoveryHistory.slice(0, 50);
  }
  state.securityRecovery = { id: `REC-${crypto.randomUUID()}`, status: 'pending', createdAt: actualNow,
    expiresAt: actualNow + RECOVERY_TTL, lockKey: lockKey(state), reporterSessionHash: sessionHash,
    criticalChange: state.lastCriticalChange ?? null, demo: true, review: null };
  audit(state, at, 'Из старой сессии запрошено учебное восстановление после тревоги. Блокировка остаётся до проверки сотрудником и отдельного подтверждения клиента.');
  return { requestId: state.securityRecovery.id, status: 'pending' };
}
export function decideSecurityRecovery(state, body, actor, actualNow, at) {
  const request = state.securityRecovery;
  if (!request || request.id !== body.requestId) fail('Нет такого запроса восстановления.');
  const status = recoveryStatus(state, actualNow);
  if (status !== 'pending') fail('Запрос уже рассмотрен, изменился или истёк.');
  if (!actor || typeof actor.id !== 'string' || !actor.id || typeof actor.name !== 'string' || !actor.name) fail('Не указан сотрудник, проводящий учебную проверку.', 403);
  if (!['approve', 'reject'].includes(body.verdict)) fail('Выберите решение по восстановлению.', 400);
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) : '';
  if (comment.length < 10) fail('Опишите учебную проверку: не менее 10 символов.', 400);
  if (body.verdict === 'approve' && !RECOVERY_CHECKS.every(key => body.checks?.[key] === true)) fail('Подтвердите все пункты учебной проверки. Это не проверка личности реальным банком.', 400);
  request.status = body.verdict === 'approve' ? 'approved' : 'rejected';
  request.review = { verdict: body.verdict, comment, at: actualNow, actorId: actor.id, actorName: actor.name,
    checks: Object.fromEntries(RECOVERY_CHECKS.map(key => [key, body.checks?.[key] === true])), demo: true };
  audit(state, at, `Учебное восстановление ${request.id}: сотрудник ${body.verdict === 'approve' ? 'разрешил отдельное подтверждение клиента' : 'отклонил запрос'}. Автоматического снятия блокировки нет.`, 'Сотрудник');
  return { requestId: request.id, status: request.status };
}
export function completeSecurityRecovery(state, body, sessionHash, actualNow, at) {
  requireContinuity(state, sessionHash);
  const request = state.securityRecovery;
  if (!request || request.id !== body.requestId || request.reporterSessionHash !== sessionHash || recoveryStatus(state, actualNow) !== 'approved') fail('Нет действующего разрешения сотрудника для этого запроса.');
  // No old operation, assistant or guardian permission may execute after recovery.
  // Keep the ledger entries themselves for investigation; never reset the account.
  for (const op of state.operations || []) {
    if (op.status !== 'pending' || !['transfer', 'cash'].includes(op.kind)) continue;
    op.status = 'blocked'; op.code = 'SECURITY_RECOVERY_CANCELLED';
    op.reason = 'Незавершённая операция отменена при восстановлении доступа. Деньги не списаны; создайте новую операцию.';
    if (op.review) op.review.status = 'invalidated';
    if (op.guardianApproval) op.guardianApproval.status = 'cancelled';
    op.aiPendingUntil = null;
  }
  if (state.trustedPolicyChange && ['pending', 'approved'].includes(state.trustedPolicyChange.status)) state.trustedPolicyChange.status = 'cancelled';
  request.status = 'completed'; request.completedAt = actualNow;
  state.securityLock = null;
  audit(state, at, 'Учебное восстановление завершено клиентом из прежней сессии. Все сессии отозваны: требуется новый вход. История, жалобы, доверенные лица и оставшаяся защитная пауза сохранены.');
  return { requestId: request.id, status: 'completed', revokeAllSessions: true, forceLogin: true };
}
export function safeSecurityLock(lock) {
  return lock ? { at: lock.at, alertId: lock.alertId, eventText: lock.eventText } : null;
}
export function serializeSecurityRecovery(state, user, actualNow) {
  const raw = state.securityRecovery;
  const status = recoveryStatus(state, actualNow);
  const sameSession = user.role === 'client' && continuity(state, user.sessionHash);
  const active = ['pending', 'approved'].includes(status);
  return {
    demo: true, status,
    continuityAvailable: user.role === 'employee' ? proofValid(state.securityLock?.reporterSessionHash) : sameSession,
    canRequest: !!state.securityLock && sameSession && !active,
    canComplete: !!state.securityLock && sameSession && status === 'approved',
    canReview: user.role === 'employee' && status === 'pending',
    reason: state.securityLock && !sameSession && user.role === 'client' ? 'Нужна та же старая сессия, из которой отправлена тревога. Если она утрачена или истекла, обратитесь в банк по независимому каналу. В прототипе такая проверка не реализована.' : '',
    request: raw ? { id: raw.id, status, createdAt: raw.createdAt, expiresAt: raw.expiresAt,
      completedAt: raw.completedAt ?? null,
      review: raw.review ? { verdict: raw.review.verdict, comment: raw.review.comment,
        at: raw.review.at, actorName: raw.review.actorName, checks: structuredClone(raw.review.checks), demo: true } : null } : null,
  };
}
