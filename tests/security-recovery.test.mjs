import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOVERY_TTL, recoveryStatus, requestSecurityRecovery, decideSecurityRecovery,
  completeSecurityRecovery, safeSecurityLock, serializeSecurityRecovery } from '../lib/security-recovery.mjs';
import { renderRecoveryOwner, renderRecoveryStaff } from '../public/recovery-view.mjs';

const now = 1900000000000;
const oldSession = 'a'.repeat(64);
const otherSession = 'b'.repeat(64);
const actor = { id: 'staff-demo', name: 'Сотрудник' };
const checks = { knownChannel: true, incidentReviewed: true, accessSecured: true };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const helpers = { esc, date: at => new Date(at).toISOString() };
function state() {
  return {
    securityLock: { at: now - 1000, alertId: 'SEC-1', eventText: 'Изменён номер', reporterSessionHash: oldSession },
    lastCriticalChange: now - 10000, changeKind: 'phone', balance: 10000000, phone: '+7 000 000-00-01', offsetMs: 86400000,
    nextId: 1, events: [], operations: [
      { id: 'OP-done', kind: 'transfer', amount: 10000, status: 'completed', code: 'COMPLETED' },
      { id: 'OP-waiting', kind: 'transfer', amount: 20000, status: 'pending', review: { status: 'approved' }, guardianApproval: { status: 'approved' }, aiPendingUntil: now + 10000 },
      { id: 'OP-cash', kind: 'cash', amount: 10000, status: 'pending' },
      { id: 'OP-blocked', kind: 'transfer', amount: 40000, status: 'blocked', code: 'RISK_REGISTRY' },
    ],
    trustedPolicy: { enabled: true, limit: 100000, guardians: [{ id: 'client-b' }], revision: 1 },
    trustedPolicyChange: { id: 'TRUST-P', status: 'pending' },
    tickets: [{ id: 'REQ-1', kind: 'security', status: 'open' }],
    fraudReports: [{ id: 'REPORT-1', status: 'submitted', text: 'История клиента' }],
    registryAdditions: [{ recipient_id: 'DEMO-BLOCKED' }],
  };
}
function request(s, at = now) { return requestSecurityRecovery(s, oldSession, at, at + s.offsetMs); }
function approve(s, at = now + 1000, extra = {}) {
  return decideSecurityRecovery(s, { requestId: s.securityRecovery.id, verdict: 'approve', checks, comment: 'Учебно разобраны обстоятельства и защищён доступ.', ...extra }, actor, at, at + s.offsetMs);
}

test('only the exact original reporting session can request recovery; legacy or absent proof remains blocked', () => {
  for (const proof of [undefined, '', 'not-a-hash', otherSession]) {
    const s = state(); s.securityLock.reporterSessionHash = proof;
    assert.throws(() => request(s), error => error.status === 403);
    assert.ok(s.securityLock); assert.equal(s.securityRecovery, undefined);
  }
  const s = state(); s.securityLock = null;
  assert.throws(() => request(s), /Нет защитной блокировки/);
});

test('request binds real-clock lifetime, incident, critical change and original session; duplicate is idempotent', () => {
  const s = state(); const r = request(s);
  assert.equal(r.status, 'pending'); assert.equal(s.securityRecovery.expiresAt, now + RECOVERY_TTL);
  assert.equal(s.securityRecovery.reporterSessionHash, oldSession);
  const duplicate = request(s, now + 1000);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.requestId, r.requestId);
  assert.equal(s.securityRecovery.expiresAt, now + RECOVERY_TTL); assert.ok(s.securityLock);
});

test('employee must review current request with all explicit boolean checks and a meaningful comment', () => {
  const s = state(); request(s);
  for (const extra of [
    { requestId: 'another' }, { verdict: 'unblock' }, { comment: 'да' },
    { checks: {} }, { checks: { ...checks, knownChannel: 'true' } },
    { checks: { ...checks, incidentReviewed: false } },
    { checks: { ...checks, accessSecured: null } },
  ]) assert.throws(() => approve(s, now + 1000, extra));
  assert.equal(s.securityRecovery.status, 'pending'); assert.ok(s.securityLock);
  assert.throws(() => decideSecurityRecovery(s, { requestId: s.securityRecovery.id, verdict: 'approve', checks, comment: 'Учебно проверено.' }, {}, now, now), error => error.status === 403);
});

test('employee approval alone cannot clear lock, debit funds or complete pending operations', () => {
  const s = state(); request(s); approve(s);
  assert.equal(s.securityRecovery.status, 'approved'); assert.ok(s.securityLock);
  assert.equal(s.balance, 10000000); assert.equal(s.operations[1].status, 'pending');
  assert.throws(() => approve(s), /уже рассмотрен/);
});

test('final recovery requires a current staff approval and the exact old session', () => {
  const s = state(); request(s); const body = { requestId: s.securityRecovery.id };
  assert.throws(() => completeSecurityRecovery(s, body, oldSession, now + 1000, now), /Нет действующего разрешения/);
  approve(s);
  for (const session of [otherSession, '', undefined]) assert.throws(() => completeSecurityRecovery(s, body, session, now + 2000, now), error => error.status === 403);
  assert.throws(() => completeSecurityRecovery(s, { requestId: 'wrong' }, oldSession, now + 2000, now), /Нет действующего разрешения/);
  assert.ok(s.securityLock);
});

test('completion preserves ledger, complaints, policy and remaining pause, cancels pending permissions, and requires atomic full session revocation', () => {
  const s = state();
  const preserved = Object.fromEntries(['balance', 'phone', 'lastCriticalChange', 'changeKind', 'offsetMs', 'trustedPolicy', 'tickets', 'fraudReports', 'registryAdditions'].map(k => [k, structuredClone(s[k])]));
  const completed = structuredClone(s.operations[0]); const blocked = structuredClone(s.operations[3]);
  request(s); approve(s);
  const result = completeSecurityRecovery(s, { requestId: s.securityRecovery.id }, oldSession, now + 2000, now + s.offsetMs + 2000);
  assert.equal(result.forceLogin, true); assert.equal(result.revokeAllSessions, true); assert.equal(s.securityLock, null);
  assert.equal(s.securityRecovery.status, 'completed');
  for (const [key, value] of Object.entries(preserved)) assert.deepEqual(s[key], value, key);
  assert.deepEqual(s.operations[0], completed); assert.deepEqual(s.operations[3], blocked);
  for (const op of s.operations.slice(1, 3)) { assert.equal(op.status, 'blocked'); assert.equal(op.code, 'SECURITY_RECOVERY_CANCELLED'); }
  assert.equal(s.operations[1].review.status, 'invalidated'); assert.equal(s.operations[1].guardianApproval.status, 'cancelled');
  assert.equal(s.operations[1].aiPendingUntil, null); assert.equal(s.trustedPolicyChange.status, 'cancelled');
  assert.equal(recoveryStatus(s, now + 3000), 'completed'); assert.match(s.events[0].text, /Все сессии отозваны/);
  assert.throws(() => completeSecurityRecovery(s, { requestId: s.securityRecovery.id }, oldSession, now + 3000, now), /Нет защитной блокировки/);
});

test('real expiry at exact TTL blocks both employee approval and client completion', () => {
  const s = state(); request(s);
  assert.equal(recoveryStatus(s, now + RECOVERY_TTL), 'expired');
  assert.throws(() => approve(s, now + RECOVERY_TTL), /истёк/);
  const approved = state(); request(approved); approve(approved);
  assert.throws(() => completeSecurityRecovery(approved, { requestId: approved.securityRecovery.id }, oldSession, now + RECOVERY_TTL, now), /Нет действующего разрешения/);
  assert.ok(approved.securityLock);
});

test('demo clock advance does not expire a real-time recovery request', () => {
  const s = state(); request(s); s.offsetMs += 86400000 * 10;
  assert.equal(recoveryStatus(s, now + 1000), 'pending'); approve(s, now + 1000);
  assert.equal(recoveryStatus(s, now + 2000), 'approved');
});

test('new alarm, modified security-lock proof or critical access change invalidates request without clearing lock', () => {
  for (const change of [s => s.securityLock.alertId = 'SEC-new', s => s.securityLock.at++, s => s.securityLock.reporterSessionHash = otherSession, s => s.lastCriticalChange++]) {
    const s = state(); request(s); approve(s); change(s);
    assert.equal(recoveryStatus(s, now + 2000), 'stale');
    assert.throws(() => completeSecurityRecovery(s, { requestId: s.securityRecovery.id }, oldSession, now + 2000, now));
    assert.ok(s.securityLock);
  }
});

test('rejected request cannot complete; a replacement is a new audited request, not an automatic approval', () => {
  const s = state(); const first = request(s);
  decideSecurityRecovery(s, { requestId: first.requestId, verdict: 'reject', comment: 'Учебная проверка не завершена.' }, actor, now + 1000, now);
  assert.throws(() => completeSecurityRecovery(s, { requestId: first.requestId }, oldSession, now + 2000, now));
  const second = request(s, now + 2000);
  assert.notEqual(second.requestId, first.requestId); assert.equal(second.status, 'pending');
  assert.equal(s.securityRecoveryHistory[0].status, 'rejected'); assert.ok(s.securityLock);
});

test('safe serialization never exposes reporter-session hash, lock fingerprint or reviewer account ID', () => {
  const s = state(); request(s); approve(s);
  const client = serializeSecurityRecovery(s, { role: 'client', sessionHash: oldSession }, now + 2000);
  assert.equal(client.canComplete, true); assert.equal(client.canRequest, false);
  const other = serializeSecurityRecovery(s, { role: 'client', sessionHash: otherSession }, now + 2000);
  assert.equal(other.canComplete, false); assert.equal(other.canRequest, false); assert.match(other.reason, /старая сессия/);
  const staff = serializeSecurityRecovery(s, { role: 'employee' }, now + 2000);
  for (const view of [client, other, staff, safeSecurityLock(s.securityLock)]) {
    const json = JSON.stringify(view);
    for (const secret of [oldSession, 'reporterSessionHash', 'lockKey', 'actorId', actor.id]) assert.equal(json.includes(secret), false, secret);
  }
});

test('only staff sees review affordance; only original reporting session sees request/complete affordances', () => {
  const s = state();
  assert.equal(serializeSecurityRecovery(s, { role: 'client', sessionHash: oldSession }, now).canRequest, true);
  assert.equal(serializeSecurityRecovery(s, { role: 'employee' }, now).canRequest, false);
  request(s);
  assert.equal(serializeSecurityRecovery(s, { role: 'employee' }, now).canReview, true);
  assert.equal(serializeSecurityRecovery(s, { role: 'client', sessionHash: oldSession }, now).canReview, false);
});

test('owner view explains educational boundary, manual employee stage, password and forced fresh login', () => {
  const s = state();
  let view = { securityLock: safeSecurityLock(s.securityLock), securityRecovery: serializeSecurityRecovery(s, { role: 'client', sessionHash: oldSession }, now) };
  const first = renderRecoveryOwner({}, view, helpers);
  assert.match(first, /data-recovery-step="request"/); assert.match(first, /type="password"/); assert.match(first, /не реальная проверка личности/);
  assert.equal(first.includes('data-recovery-step="complete"'), false);
  assert.equal(first.includes('security-recovery-new-password'), false);
  request(s); approve(s);
  view.securityRecovery = serializeSecurityRecovery(s, { role: 'client', sessionHash: oldSession }, now + 2000);
  const approved = renderRecoveryOwner({}, view, helpers);
  assert.match(approved, /data-recovery-step="complete"/); assert.match(approved, /Все сессии, включая эту/); assert.match(approved, /24-часовая пауза сохранится/);
  assert.match(approved, /id="security-recovery-new-password"[^>]*minlength="12"[^>]*maxlength="200" required/);
  assert.match(approved, /id="security-recovery-repeat-password"[^>]*minlength="12"[^>]*maxlength="200" required/);
  assert.match(approved, /новым паролем/);
  assert.equal(/value=".*2026!/.test(approved), false);
});

test('staff UI requires explicit demo checklist and explains that permission is not unblocking', () => {
  const s = state(); request(s);
  const view = { securityLock: safeSecurityLock(s.securityLock), securityRecovery: serializeSecurityRecovery(s, { role: 'employee' }, now) };
  const html = renderRecoveryStaff({}, view, helpers);
  assert.match(html, /security-recovery-review-form/);
  for (const name of Object.keys(checks)) assert.match(html, new RegExp(`name="${name}"`));
  assert.match(html, /Смоделируйте независимую проверку/); assert.match(html, /Разрешение не снимает блокировку/);
  assert.equal(/>Разблокировать</.test(html), false);
});

test('recovery markup escapes comments, errors and identifiers; proofless owner cannot submit', () => {
  const danger = '<img src=x onerror=alert(1)>';
  const view = { securityLock: {}, securityRecovery: { status: 'rejected', reason: danger, canRequest: false,
    request: { id: danger, status: 'rejected', expiresAt: now, review: { comment: danger } } } };
  const html = renderRecoveryOwner({ recoveryError: danger }, view, helpers) + renderRecoveryStaff({ recoveryError: danger }, view, helpers);
  assert.match(html, /&lt;img/); assert.equal(html.includes('<img'), false); assert.equal(html.includes('type="password"'), false);
});
