import test from 'node:test';
import assert from 'node:assert/strict';
import { bankApi } from '../lib/bank-api.mjs';
import { openDatabase } from '../server/database.mjs';
import { QR_DEMOS } from '../public/qr-view.mjs';

const A = 'client-demo';
async function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  async function call(path, body, cookie = '', headers = {}) {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) }), db);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const login = async (login, password) => (await call('/api/auth/login', { login, password })).cookie;
  const a = await login('client', 'ClientDemo2026!'), b = await login('client2', 'ClientTwo2026!'), c = await login('client3', 'ClientThree2026!'), staff = await login('employee', 'BankDemo2026!');
  const action = (body, cookie = a) => call('/api/action', body, cookie);
  const state = async (cookie = a) => ok(await call('/api/state', undefined, cookie)).state;
  const configure = (extra = {}) => action({ action: 'trusted-policy', enabled: true, limit: 100000, mode: 'any', guardianLogins: ['client2'], password: 'ClientDemo2026!', ...extra });
  const pay = (extra = {}) => action({ action: 'confirm', kind: 'transfer', recipientId: 'DEMO-CLASS-NORMAL', amount: 300000, requestId: crypto.randomUUID(), ...extra });
  const pending = async extra => { const r = ok(await pay(extra)); assert.equal(r.operation.status, 'pending'); assert.equal(r.decision.code, 'TRUSTED_REQUIRED'); return r.operation; };
  const vote = (op, verdict = 'approve', who = b, extra = {}) => call('/api/trusted/decision', { ownerClientId: A, operationId: op.id, requestId: op.guardianApproval.id, verdict, ...extra }, who);
  const resume = op => action({ action: 'confirm-trusted', operationId: op.id });
  const changeVote = (requestId, who = b, verdict = 'approve') => call('/api/trusted/decision', { ownerClientId: A, requestId, verdict }, who);
  async function mutate(fn) { const row = await db.prepare('SELECT data FROM bank_state WHERE id = ?').bind(A).first(); const state = JSON.parse(row.data); fn(state); await db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ?').bind(JSON.stringify(state), A).run(); }
  return { db, call, ok, a, b, c, staff, action, state, configure, pay, pending, vote, resume, changeVote, mutate };
}

test('trusted settings require owner authentication, password, valid other client logins and CSRF', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/action', { action: 'trusted-policy' })).status, 401);
  assert.equal((await f.action({ action: 'trusted-policy' }, f.staff)).status, 403);
  assert.equal((await f.call('/api/action', { action: 'trusted-policy' }, f.a, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.configure({ password: 'wrong' })).status, 403);
  for (const guardianLogins of [['client'], ['employee'], ['missing'], ['client2', 'client2']]) assert.equal((await f.configure({ guardianLogins })).status, 400);
  assert.equal((await f.configure()).status, 200);
  assert.equal((await f.state()).trustedPolicy.guardians[0].id, 'client-demo-2');
  const raw = (await f.db.prepare('SELECT data FROM bank_state WHERE id = ?').bind(A).first()).data;
  assert.equal(raw.includes('ClientDemo2026!'), false); assert.equal(raw.includes('password'), false);
});

test('strictly above per-operation limit requires approval even for direct confirm and forged browser permissions', async t => {
  const f = await fixture(t); f.ok(await f.configure()); const before = await f.state();
  const equal = f.ok(await f.pay({ amount: 100000 })); assert.equal(equal.operation.status, 'completed');
  const over = await f.pending({ amount: 100001, guardianApproval: { status: 'approved' }, trustedOperationId: 'fake', skipTrusted: true, allowed: true });
  assert.equal(over.guardianApproval.status, 'pending'); assert.equal((await f.state()).balance, before.balance - 100000);
  assert.equal(f.ok(await f.resume(over)).decision.allowed, false);
});

test('only assigned independent account can approve; inbox shares just the request, not balance/history', async t => {
  const f = await fixture(t); f.ok(await f.configure()); const op = await f.pending(); const before = await f.state();
  const inbox = (await f.state(f.b)).trustedInbox;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].amount, 300000); assert.equal(inbox[0].ownerName, 'Анна Ковалёва');
  for (const field of ['balance', 'phone', 'operations', 'tickets', 'fraudReports', 'events', 'data']) assert.equal(field in inbox[0], false, field);
  assert.deepEqual((await f.state(f.c)).trustedInbox, []);
  for (const user of [f.a, f.c, f.staff]) assert.equal((await f.vote(op, 'approve', user)).status, 403);
  assert.equal((await f.call('/api/trusted/decision', { ownerClientId: A }, f.b, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  f.ok(await f.vote(op)); assert.equal((await f.state()).balance, before.balance);
  const result = f.ok(await f.action({ action: 'confirm-trusted', operationId: op.id, amount: 1, recipientId: 'DEMO-FAKE' }));
  assert.equal(result.operation.amount, 300000); assert.equal(result.operation.recipientId, 'DEMO-CLASS-NORMAL');
  assert.equal(result.operation.status, 'completed'); assert.equal(result.state.balance, before.balance - 300000);
  assert.equal(f.ok(await f.resume(op)).duplicate, true); assert.equal((await f.state()).balance, before.balance - 300000);
});

test('all mode waits for each person; duplicate approval cannot inflate quorum', async t => {
  const f = await fixture(t); f.ok(await f.configure({ mode: 'all', guardianLogins: ['client2', 'client3'] }));
  const op = await f.pending(), before = (await f.state()).balance;
  f.ok(await f.vote(op)); assert.equal(f.ok(await f.vote(op)).duplicate, true);
  assert.equal(f.ok(await f.resume(op)).decision.allowed, false); assert.equal((await f.state()).balance, before);
  f.ok(await f.vote(op, 'approve', f.c));
  assert.equal(f.ok(await f.resume(op)).operation.status, 'completed');
  assert.equal((await f.state()).balance, before - op.amount);
});

test('one rejection closes the operation, other approvals cannot revive it', async t => {
  const f = await fixture(t); f.ok(await f.configure({ mode: 'all', guardianLogins: ['client2', 'client3'] }));
  const op = await f.pending(), before = (await f.state()).balance;
  f.ok(await f.vote(op, 'reject')); assert.equal((await f.vote(op, 'approve', f.c)).status, 409);
  assert.equal(f.ok(await f.resume(op)).operation.code, 'TRUSTED_REJECTED'); assert.equal((await f.state()).balance, before);
});

test('cash and canonical QR transfers follow the same configured amount limit', async t => {
  const f = await fixture(t); f.ok(await f.configure({ limit: 50000 })); const before = (await f.state()).balance;
  const cash = await f.pending({ kind: 'cash' }); f.ok(await f.vote(cash));
  assert.equal(f.ok(await f.resume(cash)).operation.status, 'completed');
  const qr = await f.pending({ qrPayload: QR_DEMOS.normal.text, qrFixtureId: 'demo-qr-normal', amount: 1, kind: 'cash' });
  assert.equal(qr.kind, 'transfer'); assert.equal(qr.amount, 100000); f.ok(await f.vote(qr));
  assert.equal(f.ok(await f.resume(qr)).operation.status, 'completed'); assert.equal((await f.state()).balance, before - cash.amount - qr.amount);
});

test('bank stop-list wins before guardian request and after a guardian has approved', async t => {
  const f = await fixture(t); f.ok(await f.configure());
  const blocked = f.ok(await f.pay({ recipientId: 'DEMO-RISK-001' })).operation;
  assert.equal(blocked.code, 'RISK_REGISTRY'); assert.equal(blocked.guardianApproval, null);
  const op = await f.pending(), before = (await f.state()).balance; f.ok(await f.vote(op));
  f.ok(await f.action({ action: 'registry-add', entry: { recipient_id: op.recipientId, display_name: 'Учебный получатель', reason: 'Независимое основание ограничения.' } }, f.staff));
  const result = f.ok(await f.resume(op)); assert.equal(result.decision.code, 'RISK_REGISTRY'); assert.equal(result.state.balance, before);
});

test('staff approval alone cannot bypass guardians for a review-class operation', async t => {
  const f = await fixture(t); f.ok(await f.configure());
  const reviewed = f.ok(await f.pay({ recipientId: 'DEMO-CLASS-REVIEW' })).operation;
  assert.equal(reviewed.code, 'MODEL_REVIEW'); assert.equal(reviewed.guardianApproval.status, 'pending');
  const before = (await f.state()).balance;
  f.ok(await f.action({ action: 'review-transfer', operationId: reviewed.id, verdict: 'approve', comment: 'Банковская проверка завершена.' }, f.staff));
  assert.equal(f.ok(await f.action({ action: 'confirm-reviewed', operationId: reviewed.id })).decision.code, 'TRUSTED_REQUIRED');
  assert.equal(f.ok(await f.resume(reviewed)).decision.allowed, false);
  f.ok(await f.vote(reviewed)); assert.equal(f.ok(await f.resume(reviewed)).operation.status, 'completed');
  assert.equal((await f.state()).balance, before - reviewed.amount);
});

test('new watch mark requires bank review even if guardians approved an initially normal operation', async t => {
  const f = await fixture(t); f.ok(await f.configure()); const op = await f.pending(); f.ok(await f.vote(op));
  const report = f.ok(await f.action({ action: 'report-create', operationId: 'HISTORY-DEMO-CLASS-NORMAL' }));
  f.ok(await f.action({ action: 'report-submit', reportId: report.reportId, note: 'Учебная жалоба на недоставленный товар.' }));
  f.ok(await f.action({ action: 'report-review', reportId: report.reportId, verdict: 'watch', comment: 'Нужна дополнительная проверка.' }, f.staff));
  const before = (await f.state()).balance, result = f.ok(await f.resume(op));
  assert.equal(result.operation.code, 'MODEL_REVIEW'); assert.equal(result.operation.review.status, 'pending'); assert.equal(result.state.balance, before);
  assert.equal(f.ok(await f.resume(op)).decision.allowed, false);
});

test('expiry and changed saved amount invalidate approval without debiting', async t => {
  const f = await fixture(t); f.ok(await f.configure()); const op = await f.pending(); f.ok(await f.vote(op));
  const before = (await f.state()).balance;
  await f.mutate(state => { state.operations.find(item => item.id === op.id).guardianApproval.expiresAt = Date.now() - 1; });
  assert.equal(f.ok(await f.resume(op)).decision.allowed, false); assert.equal((await f.state()).operations.find(item => item.id === op.id).trustedStatus, 'expired');
  const second = await f.pending(); f.ok(await f.vote(second));
  await f.mutate(state => { state.operations.find(item => item.id === second.id).amount++; });
  assert.equal(f.ok(await f.resume(second)).decision.allowed, false); assert.equal((await f.state()).balance, before);
});

test('a critical access change invalidates old consent; pause still blocks cash', async t => {
  const f = await fixture(t); f.ok(await f.configure()); const op = await f.pending(); f.ok(await f.vote(op));
  f.ok(await f.action({ action: 'phone', phone: '+7 000 000-00-09' })); const before = (await f.state()).balance;
  assert.equal(f.ok(await f.resume(op)).decision.allowed, false);
  assert.equal(f.ok(await f.pay({ kind: 'cash' })).decision.code, 'CASH_HOLD');
  assert.equal((await f.configure({ limit: 50000 })).status, 400); assert.equal((await f.state()).balance, before);
});

test('weakening settings needs current guardians; selecting a new person cannot authorize their own appointment', async t => {
  const f = await fixture(t); f.ok(await f.configure());
  const requested = f.ok(await f.configure({ limit: 1000000, guardianLogins: ['client3'] }));
  assert.equal(requested.trusted.pending, true); assert.equal(requested.state.trustedPolicy.limit, 100000);
  const id = requested.state.trustedPolicyChange.id;
  assert.equal((await f.changeVote(id, f.c)).status, 403);
  const op = await f.pending(); assert.equal(op.guardianApproval.guardians[0].id, 'client-demo-2');
  f.ok(await f.changeVote(id)); const after = await f.state();
  assert.equal(after.trustedPolicy.limit, 1000000); assert.equal(after.trustedPolicy.guardians[0].id, 'client-demo-3');
  assert.equal((await f.vote(op)).status, 409);
});

test('disabling policy needs old quorum, and pending disable is not a bypass', async t => {
  const f = await fixture(t); f.ok(await f.configure({ mode: 'all', guardianLogins: ['client2', 'client3'] }));
  const changed = f.ok(await f.configure({ enabled: false, guardianLogins: [] })); const id = changed.state.trustedPolicyChange.id;
  f.ok(await f.changeVote(id)); assert.equal((await f.state()).trustedPolicy.enabled, true); await f.pending();
  f.ok(await f.changeVote(id, f.c)); assert.equal((await f.state()).trustedPolicy.enabled, false);
  assert.equal(f.ok(await f.pay()).operation.status, 'completed');
});

test('cancel and per-client demo reset cannot bypass the active trusted policy', async t => {
  const f = await fixture(t); f.ok(await f.configure()); const op = await f.pending();
  f.ok(await f.action({ action: 'trusted-cancel', operationId: op.id })); assert.equal((await f.vote(op)).status, 409);
  f.ok(await f.action({ action: 'reset' }, f.staff)); assert.equal((await f.state()).trustedPolicy.enabled, true);
  await f.pending();
});

test('policy enabled between preview and confirmation still gates payment', async t => {
  const f = await fixture(t), request = { action: 'attempt', kind: 'transfer', recipientId: 'DEMO-CLASS-NORMAL', amount: 300000, requestId: 'trusted-late-enable-001' };
  assert.equal(f.ok(await f.action(request)).decision.allowed, true); f.ok(await f.configure());
  const before = (await f.state()).balance, result = f.ok(await f.action({ ...request, action: 'confirm' }));
  assert.equal(result.decision.code, 'TRUSTED_REQUIRED'); assert.equal(result.state.balance, before);
});

test('demo time advance does not expire real-time requests and concurrent votes save both decisions', async t => {
  const f = await fixture(t); f.ok(await f.configure({ mode: 'all', guardianLogins: ['client2', 'client3'] })); const op = await f.pending();
  f.ok(await f.action({ action: 'advance' }, f.staff));
  const results = await Promise.all([f.vote(op), f.vote(op, 'approve', f.c)]); results.forEach(f.ok);
  const approved = (await f.state()).operations.find(item => item.id === op.id);
  assert.equal(approved.guardianApproval.votes.length, 2); assert.equal(approved.trustedStatus, 'approved');
  assert.equal(f.ok(await f.resume(op)).operation.status, 'completed');
});
