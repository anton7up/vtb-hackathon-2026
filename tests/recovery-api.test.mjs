import test from 'node:test';
import assert from 'node:assert/strict';
import { bankApi } from '../lib/bank-api.mjs';
import { openDatabase } from '../server/database.mjs';

const CLIENT = 'client-demo';
const OLD_PASSWORD = 'ClientDemo2026!';
const NEW_PASSWORD = 'RecoveredClient2026!';
const checks = { knownChannel: true, incidentReviewed: true, accessSecured: true };
async function fixture(t, { prepare = false } = {}) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  async function call(path, body, cookie = '', headers = {}) {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), db);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cookieHeader: response.headers.get('set-cookie') };
  }
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const login = (login = 'client', password = OLD_PASSWORD) => call('/api/auth/login', { login, password });
  const first = await login(); ok(first); const owner = first.cookie;
  const staff = (await login('employee', 'BankDemo2026!')).cookie;
  const action = (body, who = owner, headers) => call('/api/action', body, who, headers);
  const state = async (who = owner, client = '') => ok(await call(`/api/state${client ? `?clientId=${client}` : ''}`, undefined, who)).state;
  async function raw() { return JSON.parse((await db.prepare('SELECT data FROM bank_state WHERE id = ?').bind(CLIENT).first()).data); }
  async function mutate(fn) {
    const s = await raw(); fn(s);
    await db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ?').bind(JSON.stringify(s), CLIENT).run();
  }
  if (prepare) {
    ok(await action({ action: 'trusted-policy', enabled: true, limit: 100000, mode: 'any', guardianLogins: ['client2'], password: OLD_PASSWORD }));
    ok(await action({ action: 'confirm', kind: 'transfer', recipientId: 'DEMO-CLASS-REVIEW', amount: 300000, requestId: crypto.randomUUID() }));
    const report = ok(await action({ action: 'report-create', operationId: 'HISTORY-DEMO-CLASS-NORMAL' }));
    ok(await action({ action: 'report-submit', reportId: report.reportId, note: 'Учебная жалоба: оплаченный товар не доставлен.' }));
  }
  // Make continuity deterministic without sleeping or faking the real clock.
  await db.prepare("UPDATE sessions SET expires_at = expires_at - 10000 WHERE account_id = (SELECT id FROM accounts WHERE client_id = ?)").bind(CLIENT).run();
  const next = await login(); ok(next); const changedSession = next.cookie;
  ok(await action({ action: 'phone', phone: '+7 000 000-00-09' }, changedSession));
  const alertId = (await state()).securityAlerts.find(alert => alert.kind === 'phone').id;
  const lock = () => action({ action: 'report-security', alertId });
  const request = (extra = {}, who = owner) => action({ action: 'security-recovery-request', password: OLD_PASSWORD, ...extra }, who);
  const decide = (requestId, extra = {}, who = staff) => action({ action: 'security-recovery-decide', clientId: CLIENT,
    requestId, verdict: 'approve', checks, comment: 'Учебно проверены прежний канал и обстоятельства чужого входа.', ...extra }, who);
  const complete = (requestId, extra = {}, who = owner) => action({ action: 'security-recovery-complete', requestId,
    password: OLD_PASSWORD, newPassword: NEW_PASSWORD, ...extra }, who);
  return { db, call, ok, owner, changedSession, staff, login, action, state, raw, mutate, lock, alertId, request, decide, complete };
}

test('staff demo reset cannot bypass an active incident lock or erase incident history', async t => {
  const f = await fixture(t); f.ok(await f.lock());
  const before = await f.raw();
  assert.equal((await f.action({ action: 'reset', clientId: CLIENT }, f.staff)).status, 423);
  const after = await f.raw();
  assert.deepEqual(after.securityLock, before.securityLock);
  assert.deepEqual(after.operations, before.operations);
  assert.deepEqual(after.tickets, before.tickets);
});

test('recovery is authenticated/CSRF protected and requires the old reporting session plus fresh password', async t => {
  const f = await fixture(t);
  assert.equal((await f.action({ action: 'report-security', alertId: f.alertId }, f.changedSession)).status, 403);
  f.ok(await f.lock());
  assert.equal((await f.call('/api/state', undefined, f.changedSession)).status, 401);
  assert.equal((await f.call('/api/action', { action: 'security-recovery-request', password: OLD_PASSWORD })).status, 401);
  assert.equal((await f.request({ password: 'wrong' })).status, 403);
  assert.equal((await f.action({ action: 'security-recovery-request', password: OLD_PASSWORD }, f.owner, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request({}, f.staff)).status, 403);
  const fresh = await f.login(); f.ok(fresh);
  assert.equal((await f.request({}, fresh.cookie)).status, 403);
  const own = f.ok(await f.request()); assert.equal(own.state.securityRecovery.status, 'pending');
  assert.ok(own.state.securityLock); assert.equal(own.state.securityRecovery.canComplete, false);
});

test('only staff can decide and only after explicit educational checklist; staff permission keeps lock', async t => {
  const f = await fixture(t); f.ok(await f.lock());
  const requested = f.ok(await f.request()); const id = requested.state.securityRecovery.request.id;
  assert.equal((await f.decide(id, {}, f.owner)).status, 403);
  assert.equal((await f.decide(id, { checks: { ...checks, knownChannel: false } })).status, 400);
  assert.equal((await f.decide(id, { checks: { ...checks, knownChannel: 'true' } })).status, 400);
  assert.equal((await f.decide(id, { comment: 'да' })).status, 400);
  const before = await f.state(); f.ok(await f.decide(id)); const after = await f.state();
  assert.ok(after.securityLock); assert.equal(after.securityRecovery.status, 'approved'); assert.equal(after.balance, before.balance);
  assert.equal(after.securityRecovery.canComplete, true);
  const blocked = f.ok(await f.action({ action: 'confirm', kind: 'transfer', recipientId: 'DEMO-CLASS-NORMAL', amount: 10000, requestId: crypto.randomUUID() }));
  assert.equal(blocked.decision.code, 'ACCOUNT_SECURITY_LOCK'); assert.equal(blocked.state.balance, before.balance);
});

test('completion changes password, clears all owner sessions atomically, preserves history/complaints/policy/remaining hold, and never debits', async t => {
  const f = await fixture(t, { prepare: true }); f.ok(await f.lock());
  const before = await f.raw(); const initialAccount = await f.db.prepare('SELECT password_hash, password_salt FROM accounts WHERE client_id = ?').bind(CLIENT).first();
  const requested = f.ok(await f.request()); const id = requested.state.securityRecovery.request.id;
  assert.equal((await f.complete(id)).status, 409); f.ok(await f.decide(id));
  const afterLockLogin = await f.login(); f.ok(afterLockLogin);
  assert.equal((await f.complete(id, {}, afterLockLogin.cookie)).status, 403);
  const response = await f.complete(id); f.ok(response);
  assert.equal(response.body.recovery.forceLogin, true); assert.match(response.cookieHeader, /Max-Age=0/);
  const sessionCount = await f.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE client_id = ?)').bind(CLIENT).first();
  assert.equal(sessionCount.n, 0);
  for (const cookie of [f.owner, f.changedSession, afterLockLogin.cookie]) assert.equal((await f.call('/api/state', undefined, cookie)).status, 401);
  const after = await f.raw();
  for (const key of ['balance', 'phone', 'lastCriticalChange', 'changeKind', 'trustedPolicy', 'fraudReports', 'registryAdditions', 'tickets']) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.operations.filter(op => op.status === 'completed'), before.operations.filter(op => op.status === 'completed'));
  assert.equal(after.securityLock, null); assert.equal(after.securityRecovery.status, 'completed');
  const oldPending = before.operations.find(op => op.status === 'pending');
  assert.ok(oldPending); assert.equal(after.operations.find(op => op.id === oldPending.id).code, 'SECURITY_RECOVERY_CANCELLED');
  const nextAccount = await f.db.prepare('SELECT password_hash, password_salt FROM accounts WHERE client_id = ?').bind(CLIENT).first();
  assert.notEqual(nextAccount.password_hash, initialAccount.password_hash); assert.notEqual(nextAccount.password_salt, initialAccount.password_salt);
  const raw = JSON.stringify(after); assert.equal(raw.includes(OLD_PASSWORD), false); assert.equal(raw.includes(NEW_PASSWORD), false);
  assert.equal((await f.login()).status, 401);
  const fresh = await f.login('client', NEW_PASSWORD); f.ok(fresh);
  const freshState = await f.state(fresh.cookie); assert.equal(freshState.protection.active, true);
  assert.equal(freshState.lastCriticalChange, before.lastCriticalChange);
  const cash = f.ok(await f.action({ action: 'confirm', kind: 'cash', amount: 10000, requestId: crypto.randomUUID() }, fresh.cookie));
  assert.equal(cash.decision.code, 'CASH_HOLD');
  const newPayee = f.ok(await f.action({ action: 'confirm', kind: 'transfer', recipientId: 'DEMO-NEW-001', amount: 10000, requestId: crypto.randomUUID() }, fresh.cookie));
  assert.equal(newPayee.decision.code, 'NEW_RECIPIENT_HOLD');
  assert.equal((await f.state(fresh.cookie)).balance, before.balance);
});

test('completion validates current and replacement passwords before any mutation', async t => {
  const f = await fixture(t); f.ok(await f.lock()); const requested = f.ok(await f.request());
  const id = requested.state.securityRecovery.request.id; f.ok(await f.decide(id)); const before = await f.raw();
  assert.equal((await f.complete(id, { password: 'wrong' })).status, 403);
  for (const newPassword of ['', 'too-short', OLD_PASSWORD, 'x'.repeat(201)]) assert.equal((await f.complete(id, { newPassword })).status, 400);
  const after = await f.raw(); assert.deepEqual(after, before); assert.ok(after.securityLock);
});

test('expired or changed incident requests cannot be approved or completed, even with correct passwords', async t => {
  const f = await fixture(t); f.ok(await f.lock()); const requested = f.ok(await f.request()); const id = requested.state.securityRecovery.request.id;
  await f.mutate(s => { s.securityRecovery.expiresAt = Date.now() - 1; });
  assert.equal((await f.decide(id)).status, 409); assert.equal((await f.complete(id)).status, 409);
  const next = f.ok(await f.request()); const nextId = next.state.securityRecovery.request.id; f.ok(await f.decide(nextId));
  await f.mutate(s => { s.securityLock.alertId = 'SEC-OTHER'; });
  assert.equal((await f.complete(nextId)).status, 409); assert.ok((await f.raw()).securityLock);
});

test('proofless legacy locks stay blocked and serialized owner/staff views never expose session proof', async t => {
  const f = await fixture(t); f.ok(await f.lock()); f.ok(await f.request());
  const raw = await f.raw(); const secret = raw.securityLock.reporterSessionHash;
  assert.equal(secret.length, 64);
  for (const who of [f.owner, f.staff]) {
    const view = await f.state(who, who === f.staff ? CLIENT : '');
    const text = JSON.stringify(view);
    assert.equal(text.includes(secret), false); assert.equal(text.includes('reporterSessionHash'), false); assert.equal(text.includes('lockKey'), false);
  }
  await f.mutate(s => { delete s.securityLock.reporterSessionHash; s.securityRecovery = null; });
  assert.equal((await f.request()).status, 403);
  assert.equal((await f.state()).securityRecovery.canRequest, false);
});

test('a different client cannot select victim account or approve its recovery', async t => {
  const f = await fixture(t); f.ok(await f.lock()); const requested = f.ok(await f.request()); const id = requested.state.securityRecovery.request.id;
  const stranger = await f.login('client2', 'ClientTwo2026!'); f.ok(stranger);
  assert.equal((await f.action({ action: 'security-recovery-request', clientId: CLIENT, password: 'ClientTwo2026!' }, stranger.cookie)).status, 403);
  assert.equal((await f.decide(id, {}, stranger.cookie)).status, 403);
  assert.equal((await f.action({ action: 'security-recovery-complete', clientId: CLIENT, requestId: id, password: 'ClientTwo2026!', newPassword: NEW_PASSWORD }, stranger.cookie)).status, 403);
  assert.ok((await f.raw()).securityLock);
});
