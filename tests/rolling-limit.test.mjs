import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, evaluate, confirmOperation } from '../lib/bank-engine.mjs';
import { confirmTrusted } from '../lib/trusted-workflow.mjs';
import { TRUSTED_WINDOW, rollingTrustedUsage, needsTrusted, trustedGate, configureTrusted, ensureTrustedApproval, decideTrusted, trustedRequests } from '../lib/trusted-approval.mjs';
import { renderTrustedSettings, renderTrustedInbox } from '../public/trusted-view.mjs';
import { bankApi } from '../lib/bank-api.mjs';
import { openDatabase } from '../server/database.mjs';
import { QR_DEMOS } from '../public/qr-view.mjs';

const NOW = 1900000000000;
const guardians = [{ id: 'guardian-b', login: 'client2', name: 'Борис' }];
const normal = { class: 'normal' };
const request = (amount = 300000, more = {}) => ({ kind: 'transfer', recipientId: 'DEMO-CLASS-NORMAL', recipientName: 'Учебный получатель', amount, classification: normal, ...more });
function state() {
  const s = initialState(NOW);
  configureTrusted(s, { enabled: true, limit: 1000000, dailyLimit: 500000, mode: 'any' }, guardians, NOW, NOW);
  return s;
}
function completed(s, amount, actualCompletedAt = NOW, extra = {}) {
  const op = { id: `PAID-${s.operations.length}`, kind: 'transfer', amount, status: 'completed', actualCompletedAt, ...extra };
  s.operations.unshift(op); return op;
}

test('rolling limit stops split payments even when each is below the single-operation limit', () => {
  const s = state();
  assert.equal(needsTrusted(s, request(300000), NOW), false);
  completed(s, 300000);
  assert.equal(needsTrusted(s, request(200000), NOW), false, 'exact boundary is permitted');
  assert.equal(needsTrusted(s, request(200001), NOW), true);
  const gate = trustedGate(s, request(300000), NOW);
  assert.equal(gate.code, 'TRUSTED_REQUIRED'); assert.match(gate.reason, /общий лимит/);
  assert.deepEqual(rollingTrustedUsage(s, NOW), { enabled: true, limit: 500000, amount: 300000, operationCount: 1, remaining: 200000, windowMs: TRUSTED_WINDOW, asOf: NOW });
});

test('rolling budget includes cash and QR-backed payments but excludes failed, pending, seeded and legacy records', () => {
  const s = state();
  completed(s, 100000, NOW, { kind: 'cash' });
  completed(s, 200000, NOW, { paymentContext: { source: 'demo_qr_adapter' } });
  completed(s, 400000, NOW, { status: 'pending' });
  completed(s, 400000, NOW, { status: 'blocked' });
  completed(s, 400000, NOW, { seeded: true });
  completed(s, 400000, undefined, { actualCompletedAt: undefined, completedAt: NOW });
  completed(s, 400000, NOW, { kind: 'deposit' });
  assert.equal(rollingTrustedUsage(s, NOW).amount, 300000);
  assert.equal(needsTrusted(s, request(200001, { kind: 'cash' }), NOW), true);
});

test('window uses real 24 hours, not a calendar day or simulated bank clock', () => {
  const s = state(); completed(s, 300000, NOW - TRUSTED_WINDOW + 1);
  completed(s, 200000, NOW - TRUSTED_WINDOW);
  completed(s, 200000, NOW + 1);
  s.offsetMs = TRUSTED_WINDOW * 3;
  assert.equal(rollingTrustedUsage(s, NOW).amount, 300000);
  assert.equal(needsTrusted(s, request(), NOW), true);
  assert.equal(evaluate(s, request(), [], NOW + s.offsetMs).code, 'TRUSTED_REQUIRED');
  assert.equal(rollingTrustedUsage(s, NOW + 1).amount, 200000, 'oldest debit expires exactly at the boundary; future debit is now current');
  assert.equal(needsTrusted(s, request(), NOW + 1), false);
});

test('minimal reset ledger preserves budget and deduplicates records by id plus real completion time', () => {
  const s = state();
  const first = completed(s, 300000, NOW - 1);
  s.trustedDebitHistory = [{ ...first }, { ...first }, { ...first, actualCompletedAt: NOW - TRUSTED_WINDOW }];
  assert.equal(rollingTrustedUsage(s, NOW).amount, 300000, 'operation plus ledger is counted once');
  s.operations = [];
  assert.equal(rollingTrustedUsage(s, NOW).amount, 300000, 'reset does not erase recent debit budget');
  completed(s, 100000, NOW, { id: first.id });
  assert.equal(rollingTrustedUsage(s, NOW).amount, 400000, 'reused demo id with another completion time is a different debit');
  assert.equal(rollingTrustedUsage(s, NOW).operationCount, 2);
  assert.equal(needsTrusted(s, request(100001), NOW), true);
});

test('omitting a daily limit preserves old configuration and an empty optional setting has no aggregate gate', () => {
  const s = state();
  configureTrusted(s, { enabled: true, limit: 1000000, mode: 'any' }, guardians, NOW, NOW);
  assert.equal(s.trustedPolicy.dailyLimit, 500000);
  const legacy = initialState(NOW); legacy.trustedPolicy = { enabled: true, limit: 1000000, mode: 'any', guardians, revision: 1 };
  completed(legacy, 9000000);
  assert.equal(needsTrusted(legacy, request(), NOW), false);
  assert.equal(rollingTrustedUsage(legacy, NOW).enabled, false);
  assert.equal(needsTrusted(legacy, request(1000001), NOW), true, 'per-operation protection stays intact');
});

test('enabling or lowering aggregate limit tightens immediately; increasing or removing it needs old group', () => {
  for (const next of [600000, null]) {
    const s = state();
    const result = configureTrusted(s, { enabled: true, limit: 1000000, dailyLimit: next, mode: 'any' }, guardians, NOW, NOW);
    assert.equal(result.pending, true); assert.equal(s.trustedPolicy.dailyLimit, 500000);
    const change = s.trustedPolicyChange;
    assert.equal(change.guardians[0].id, guardians[0].id);
    decideTrusted(s, { requestId: change.id, verdict: 'approve' }, guardians[0].id, NOW, NOW);
    assert.equal(s.trustedPolicy.dailyLimit, next);
  }
  const s = state();
  assert.equal(configureTrusted(s, { enabled: true, limit: 1000000, dailyLimit: 400000, mode: 'any' }, guardians, NOW, NOW).pending, false);
  assert.equal(s.trustedPolicy.dailyLimit, 400000);
  s.trustedPolicy.dailyLimit = null;
  assert.equal(configureTrusted(s, { enabled: true, limit: 1000000, dailyLimit: 400000, mode: 'any' }, guardians, NOW, NOW).pending, false);
});

test('aggregate settings validate kopecks and changing the group is never silently treated as tightening', () => {
  for (const dailyLimit of [0, -100, 99, 100.5, '500000', Infinity, 100000000001]) {
    const s = state();
    assert.throws(() => configureTrusted(s, { enabled: true, limit: 1000000, dailyLimit, mode: 'any' }, guardians, NOW, NOW));
  }
  const s = state();
  configureTrusted(s, { enabled: true, limit: 1000000, dailyLimit: 100000, mode: 'any' }, [{ id: 'new-person', name: 'Вера' }], NOW, NOW);
  assert.equal(s.trustedPolicy.guardians[0].id, guardians[0].id);
  assert.equal(s.trustedPolicyChange.status, 'pending');
});

test('request explains aggregate reason, guardians never debit, each excess payment needs its own consent', () => {
  const s = state(); completed(s, 300000); const balance = s.balance;
  const op = { id: 'OP-ROLLING', ...request(), status: 'pending', code: 'TRUSTED_REQUIRED' }; s.operations.unshift(op);
  ensureTrustedApproval(s, op, NOW);
  assert.deepEqual(op.guardianApproval.reasons, [{ code: 'rolling_24h', limit: 500000, spent: 300000, projected: 600000, windowMs: TRUSTED_WINDOW }]);
  const inbox = trustedRequests(s, { id: 'owner', name: 'Анна' }, guardians[0].id, NOW);
  assert.equal(inbox[0].reasons[0].spent, 300000);
  for (const key of ['balance', 'operations', 'phone', 'fraudReports']) assert.equal(key in inbox[0], false);
  decideTrusted(s, { operationId: op.id, requestId: op.guardianApproval.id, verdict: 'approve' }, guardians[0].id, NOW, NOW);
  assert.equal(s.balance, balance); assert.equal(op.status, 'pending');
  assert.equal(confirmTrusted(s, op.id, [], normal, NOW, NOW).decision.allowed, true);
  assert.equal(s.balance, balance - op.amount); assert.equal(op.actualCompletedAt, NOW);
  assert.equal(rollingTrustedUsage(s, NOW).amount, 600000);
  assert.equal(trustedGate(s, request(100), NOW).code, 'TRUSTED_REQUIRED');
  assert.equal(confirmTrusted(s, op.id, [], normal, NOW, NOW).duplicate, true);
  assert.equal(s.balance, balance - op.amount);
});

test('guardian permission does not bypass a stop-list and is invalid after policy revision', () => {
  const s = state(); completed(s, 300000);
  const op = { id: 'OP-ROLLING', ...request(), status: 'pending', code: 'TRUSTED_REQUIRED' }; s.operations.unshift(op);
  ensureTrustedApproval(s, op, NOW);
  decideTrusted(s, { operationId: op.id, requestId: op.guardianApproval.id, verdict: 'approve' }, guardians[0].id, NOW, NOW);
  const balance = s.balance;
  const stopped = confirmTrusted(s, op.id, [{ recipient_id: op.recipientId, status: 'active' }], normal, NOW, NOW);
  assert.equal(stopped.decision.code, 'RISK_REGISTRY'); assert.equal(s.balance, balance);
  const second = { id: 'OP-ROLLING-2', ...request(), status: 'pending', code: 'TRUSTED_REQUIRED' }; s.operations.unshift(second);
  ensureTrustedApproval(s, second, NOW);
  decideTrusted(s, { operationId: second.id, requestId: second.guardianApproval.id, verdict: 'approve' }, guardians[0].id, NOW, NOW);
  configureTrusted(s, { enabled: true, limit: 1000000, dailyLimit: 400000, mode: 'any' }, guardians, NOW, NOW);
  assert.equal(trustedGate(s, { ...second, trustedOperationId: second.id }, NOW).code, 'TRUSTED_REQUIRED');
});

test('final ordinary confirmation reevaluates total after an earlier preview', () => {
  const s = state();
  assert.equal(evaluate(s, request(), [], NOW).allowed, true);
  completed(s, 300000);
  const before = s.balance, result = confirmOperation(s, request(300000, { requestId: 'after-preview' }), [], NOW);
  assert.equal(result.decision.code, 'TRUSTED_REQUIRED'); assert.equal(result.operation.status, 'pending');
  assert.equal(result.operation.guardianApproval.reasons[0].code, 'rolling_24h'); assert.equal(s.balance, before);
});

test('profile and guardian inbox display aggregate limit without exposing history or auto-executing payment', () => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const helpers = { esc, money: v => `${v / 100} ₽`, date: v => new Date(v).toISOString() };
  const s = state(); completed(s, 300000); s.trustedUsage = rollingTrustedUsage(s, NOW);
  const ui = { trustedDailyLimit: '<img>', trustedLogins: 'client2', trustedMode: 'any', trustedLimit: '10000', trustedEnabled: true };
  const html = renderTrustedSettings(ui, s, helpers);
  assert.match(html, /id="trusted-daily-limit"/); assert.match(html, /value="&lt;img&gt;"/);
  assert.match(html, /До общего лимита осталось 2000 ₽/); assert.match(html, /скользящие 24 часа/);
  const r = { requestId: 'T', ownerName: 'Анна', type: 'operation', amount: 300000, recipientName: 'Учебный продавец', kind: 'transfer', status: 'pending', expiresAt: NOW, approvals: 0, required: 1,
    reasons: [{ code: 'rolling_24h', limit: 500000, spent: 300000, projected: 600000 }] };
  const inbox = renderTrustedInbox({}, { trustedInbox: [r] }, helpers);
  assert.match(inbox, /Уже выполнено 3000 ₽/); assert.match(inbox, /не выполняете операцию за клиента/);
});

async function apiFixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  async function call(path, body, cookie = '') {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }), db);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const a = (await call('/api/auth/login', { login: 'client', password: 'ClientDemo2026!' })).cookie;
  const b = (await call('/api/auth/login', { login: 'client2', password: 'ClientTwo2026!' })).cookie;
  const staff = (await call('/api/auth/login', { login: 'employee', password: 'BankDemo2026!' })).cookie;
  const action = (body, cookie = a) => call('/api/action', body, cookie);
  const configure = extra => action({ action: 'trusted-policy', enabled: true, limit: 1000000, dailyLimit: 500000, mode: 'any', guardianLogins: ['client2'], password: 'ClientDemo2026!', ...extra });
  const pay = extra => action({ action: 'confirm', ...request(), requestId: crypto.randomUUID(), ...extra });
  const state = async () => ok(await call('/api/state', undefined, a)).state;
  return { db, call, ok, action, configure, pay, state, a, b, staff };
}

test('API applies split limit at every debit and owner explicitly resumes after guardian permission', async t => {
  const f = await apiFixture(t); f.ok(await f.configure());
  const first = f.ok(await f.pay()).operation;
  assert.equal(first.status, 'completed');
  const saved = JSON.parse((await f.db.prepare('SELECT data FROM bank_state WHERE id = ?').bind('client-demo').first()).data);
  assert.ok(Number.isFinite(saved.operations.find(op => op.id === first.id).actualCompletedAt), 'real completion is server-owned');
  const second = f.ok(await f.pay()).operation;
  assert.equal(second.status, 'pending'); assert.equal(second.guardianApproval.reasons[0].code, 'rolling_24h');
  const before = (await f.state()).balance;
  f.ok(await f.call('/api/trusted/decision', { ownerClientId: 'client-demo', operationId: second.id, requestId: second.guardianApproval.id, verdict: 'approve' }, f.b));
  assert.equal((await f.state()).balance, before);
  assert.equal(f.ok(await f.action({ action: 'confirm-trusted', operationId: second.id })).operation.status, 'completed');
  const final = await f.state(); assert.equal(final.balance, before - second.amount);
  assert.equal(final.trustedUsage.amount, 600000); assert.equal(final.trustedUsage.remaining, 0);
});

test('API cash and canonical QR share the same real rolling budget', async t => {
  const f = await apiFixture(t); f.ok(await f.configure({ dailyLimit: 300000 }));
  assert.equal(f.ok(await f.pay({ kind: 'cash', amount: 200000 })).operation.status, 'completed');
  const qr = f.ok(await f.pay({ qrPayload: QR_DEMOS.normal.text, qrFixtureId: 'demo-qr-normal', amount: 1 })).operation;
  assert.equal(qr.status, 'completed'); assert.equal(qr.amount, 100000);
  const next = f.ok(await f.pay({ kind: 'cash', amount: 100 })).operation;
  assert.equal(next.status, 'pending'); assert.equal(next.guardianApproval.reasons[0].spent, 300000);
});

test('concurrent confirmations cannot both spend below an out-of-date rolling total', async t => {
  const f = await apiFixture(t); f.ok(await f.configure());
  const responses = await Promise.all([f.pay(), f.pay()]); const results = responses.map(f.ok);
  assert.equal(results.filter(r => r.operation.status === 'completed').length, 1);
  assert.equal(results.filter(r => r.operation.code === 'TRUSTED_REQUIRED').length, 1);
  assert.equal((await f.state()).trustedUsage.amount, 300000);
});

test('bank-reviewed final confirmation rechecks rolling usage and requires independent guardian consent', async t => {
  const f = await apiFixture(t); f.ok(await f.configure());
  const op = f.ok(await f.pay({ recipientId: 'DEMO-CLASS-REVIEW' })).operation;
  assert.equal(op.code, 'MODEL_REVIEW'); assert.equal(op.guardianApproval, null);
  f.ok(await f.action({ action: 'review-transfer', operationId: op.id, verdict: 'approve', comment: 'Учебная банковская проверка завершена.' }, f.staff));
  assert.equal(f.ok(await f.pay()).operation.status, 'completed');
  const before = (await f.state()).balance;
  const paused = f.ok(await f.action({ action: 'confirm-reviewed', operationId: op.id }));
  assert.equal(paused.decision.code, 'TRUSTED_REQUIRED'); assert.equal(paused.state.balance, before);
  assert.equal(paused.operation.guardianApproval.reasons[0].spent, 300000);
  f.ok(await f.call('/api/trusted/decision', { ownerClientId: 'client-demo', operationId: op.id, requestId: paused.operation.guardianApproval.id, verdict: 'approve' }, f.b));
  const result = f.ok(await f.action({ action: 'confirm-trusted', operationId: op.id }));
  assert.equal(result.operation.status, 'completed'); assert.equal(result.state.balance, before - op.amount);
  assert.equal(result.state.trustedUsage.amount, 600000);
});

test('employee demo reset does not erase the rolling aggregate budget', async t => {
  const f = await apiFixture(t); f.ok(await f.configure()); f.ok(await f.pay());
  f.ok(await f.action({ action: 'reset' }, f.staff));
  assert.equal((await f.state()).trustedUsage.amount, 300000);
  assert.equal(f.ok(await f.pay()).operation.code, 'TRUSTED_REQUIRED');
});
