import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { bankApi } from '../lib/bank-api.mjs';
import { normalizeClassification } from '../lib/transfer-classifier.mjs';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  const db = {
    prepare(query) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return sql.prepare(query).get(...args) || null; },
        async all() { return { results: sql.prepare(query).all(...args) }; },
        async run() { return { meta: { changes: Number(sql.prepare(query).run(...args).changes) } }; },
      };
      return statement;
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = []; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results; }
      catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
  async function call(path, body, cookie = '', headers = {}) {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), db);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cookieHeader: response.headers.get('set-cookie') };
  }
  async function login(role) { return call('/api/auth/login', { login: role, password: role === 'client' ? 'ClientDemo2026!' : 'BankDemo2026!' }); }
  return { call, login, sql };
}
test('anonymous cannot read bank data or mutate it', async () => {
  const f = fixture();
  assert.equal((await f.call('/api/state')).status, 401);
  assert.equal((await f.call('/api/registry')).status, 401);
  assert.equal((await f.call('/api/action', { action: 'reset' })).status, 401);
});
test('two DB accounts, salted hashes, no password exposure, secure session cookie', async () => {
  const f = fixture(); const client = await f.login('client'), staff = await f.login('employee');
  assert.equal(client.status, 200); assert.equal(staff.status, 200);
  assert.equal(client.body.user.role, 'client'); assert.equal(staff.body.user.role, 'employee');
  const users = f.sql.prepare('SELECT * FROM accounts').all(); assert.equal(users.length, 2);
  assert.equal(users[0].password_hash.length, 64); assert.notEqual(users[0].password_hash, 'ClientDemo2026!');
  assert.equal('passwordHash' in client.body.user, false); assert.equal('password_hash' in staff.body.user, false);
  assert.match(client.cookieHeader, /HttpOnly/); assert.match(client.cookieHeader, /Secure/); assert.match(client.cookieHeader, /SameSite=Strict/);
  const sessions = f.sql.prepare('SELECT token_hash FROM sessions').all();
  assert.equal(sessions.length, 2); assert.equal(sessions.some(s => client.cookie.includes(s.token_hash)), false);
});
test('invalid credentials fail with generic error; body role cannot elevate account', async () => {
  const f = fixture();
  const bad = await f.call('/api/auth/login', { login: 'client', password: 'wrong' });
  assert.equal(bad.status, 401); assert.equal(bad.body.error, 'Неверный логин или пароль');
  const elevated = await f.call('/api/auth/login', { login: 'client', password: 'ClientDemo2026!', role: 'employee' });
  assert.equal(elevated.body.user.role, 'client');
});
test('client cannot access registry, staff actions or another role through query string', async () => {
  const f = fixture(), client = await f.login('client');
  assert.equal((await f.call('/api/registry', undefined, client.cookie)).status, 403);
  for (const action of ['registry-add', 'advance', 'reset', 'reply']) assert.equal((await f.call('/api/action', { action }, client.cookie)).status, 403);
  const view = await f.call('/api/state?role=employee', undefined, client.cookie);
  assert.equal(view.status, 200); assert.equal('registryAdditions' in view.body.state, false);
  assert.equal(view.body.state.events.every(e => e.actor === 'Клиент'), true);
});
test('employee may read registry but cannot impersonate client for transfers or access changes', async () => {
  const f = fixture(), employee = await f.login('employee');
  assert.equal((await f.call('/api/registry', undefined, employee.cookie)).body.entries.length, 5);
  for (const action of ['phone', 'recovery', 'attempt', 'confirm', 'ticket']) assert.equal((await f.call('/api/action', { action }, employee.cookie)).status, 403);
});
test('pause and balance are server owned; staff reply does not lift pause', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee');
  const changed = await f.call('/api/action', { action: 'phone', phone: '+7 000 000-00-02', role: 'employee', balance: 1 }, client.cookie);
  assert.equal(changed.body.state.protection.active, true);
  const blocked = await f.call('/api/action', { action: 'confirm', kind: 'transfer', recipientId: 'DEMO-NEW-001', amount: 100000, requestId: 'test-confirm-new' }, client.cookie);
  assert.equal(blocked.body.operation.status, 'blocked'); assert.equal(blocked.body.state.balance, 24830000);
  const ticket = await f.call('/api/action', { action: 'ticket', operationId: blocked.body.operation.id }, client.cookie);
  await f.call('/api/action', { action: 'reply', ticketId: ticket.body.ticket.id, reply: 'Пауза действует.' }, staff.cookie);
  const view = await f.call('/api/state', undefined, client.cookie);
  assert.equal(view.body.state.tickets[0].reply, 'Пауза действует.'); assert.equal(view.body.state.protection.active, true);
  assert.equal(view.body.state.events.some(e => e.actor === 'Сотрудник'), false);
});
test('staff registry edit persists in SQLite and blocks client; internal reason not sent', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee');
  const saved = await f.call('/api/action', { action: 'registry-add', entry: { recipient_id: 'DEMO-NEW-001', display_name: 'Продавец', reason: 'Внутреннее основание' } }, staff.cookie);
  assert.equal(saved.status, 200);
  const blocked = await f.call('/api/action', { action: 'attempt', kind: 'transfer', recipientId: 'DEMO-NEW-001', amount: 100000 }, client.cookie);
  assert.equal(blocked.body.decision.code, 'RISK_REGISTRY');
  assert.equal(JSON.stringify(blocked.body).includes('Внутреннее основание'), false);
});
test('logout revokes session and expired token is rejected', async () => {
  const f = fixture(), client = await f.login('client');
  assert.equal((await f.call('/api/auth/logout', {}, client.cookie)).status, 200);
  assert.equal((await f.call('/api/state', undefined, client.cookie)).status, 401);
  const again = await f.login('client');
  f.sql.prepare('UPDATE sessions SET expires_at = 0').run();
  assert.equal((await f.call('/api/auth/me', undefined, again.cookie)).status, 401);
});
test('cross origin writes denied before executing operation', async () => {
  const f = fixture(), client = await f.login('client');
  assert.equal((await f.call('/api/action', { action: 'recovery' }, client.cookie, { Origin: 'https://other.test' })).status, 403);
});
test('known recipient remains available during hold, duplicate confirmation debits once', async () => {
  const f = fixture(), client = await f.login('client');
  await f.call('/api/action', { action: 'recovery' }, client.cookie);
  const body = { action: 'confirm', kind: 'transfer', recipientId: 'DEMO-FAMILY-001', amount: 300000, requestId: 'same-request-id' };
  const first = await f.call('/api/action', body, client.cookie), second = await f.call('/api/action', body, client.cookie);
  assert.equal(first.body.operation.status, 'completed'); assert.equal(second.body.duplicate, true);
  assert.equal(second.body.state.balance, 24530000);
});

test('new login alerts only older client sessions, never itself or staff', async () => {
  const f = fixture(), old = await f.login('client'), newer = await f.login('client'), staff = await f.login('employee');
  const a = (await f.call('/api/state', undefined, old.cookie)).body.state;
  const b = (await f.call('/api/state', undefined, newer.cookie)).body.state;
  const c = (await f.call('/api/state', undefined, staff.cookie)).body.state;
  assert.equal(a.securityAlerts.length, 1); assert.equal(a.securityAlerts[0].kind, 'login');
  assert.deepEqual(b.securityAlerts, []); assert.equal('securityAlerts' in c, false);
  const me = await f.call('/api/auth/me', undefined, old.cookie);
  assert.equal(me.body.user.clientId, 'client-demo');
  assert.equal('sessionHash' in me.body.user, false); assert.equal('sessionStartedAt' in me.body.user, false);
  for (const row of f.sql.prepare('SELECT token_hash FROM sessions').all()) {
    assert.equal(JSON.stringify([a, b, c, me.body]).includes(row.token_hash), false);
  }
});

test('phone alert excludes its originating session and sessions opened after the event', async () => {
  const f = fixture(), old = await f.login('client'), origin = await f.login('client');
  await f.call('/api/action', { action: 'phone', phone: '+7 000 000-00-02' }, origin.cookie);
  const oldState = (await f.call('/api/state', undefined, old.cookie)).body.state;
  const alert = oldState.securityAlerts.find(a => a.kind === 'phone'); assert.ok(alert);
  const originState = (await f.call('/api/state', undefined, origin.cookie)).body.state;
  assert.equal(originState.securityAlerts.some(a => a.id === alert.id), false);
  assert.equal((await f.call('/api/action', { action: 'report-security', alertId: alert.id, sessionStartedAt: 0 }, origin.cookie)).status, 403);
  const after = await f.login('client');
  assert.equal((await f.call('/api/state', undefined, after.cookie)).body.state.securityAlerts.some(a => a.id === alert.id), false);
  assert.equal((await f.call('/api/action', { action: 'report-security', alertId: alert.id }, after.cookie)).status, 403);
  assert.equal((await f.call('/api/action', { action: 'report-security', alertId: 'made-up' }, old.cookie)).status, 403);
});

test('recovery alert available only in the other pre-existing session', async () => {
  const f = fixture(), old = await f.login('client'), origin = await f.login('client');
  await f.call('/api/action', { action: 'recovery' }, origin.cookie);
  const a = (await f.call('/api/state', undefined, old.cookie)).body.state;
  const b = (await f.call('/api/state', undefined, origin.cookie)).body.state;
  assert.equal(a.securityAlerts.some(x => x.kind === 'recovery'), true);
  assert.equal(b.securityAlerts.some(x => x.kind === 'recovery'), false);
});

test('report persists full lock and urgent staff ticket, revokes other client sessions but not staff', async () => {
  const f = fixture(), old = await f.login('client'), source = await f.login('client'), staff = await f.login('employee');
  const view = (await f.call('/api/state', undefined, old.cookie)).body.state;
  const alert = view.securityAlerts[0];
  const result = await f.call('/api/action', { action: 'report-security', alertId: alert.id }, old.cookie);
  assert.equal(result.status, 200); assert.equal(result.body.state.securityLock.alertId, alert.id);
  assert.deepEqual(result.body.state.securityAlerts, []);
  assert.equal(result.body.state.balance, 24830000);
  assert.equal((await f.call('/api/state', undefined, source.cookie)).status, 401);
  const employee = await f.call('/api/state', undefined, staff.cookie);
  assert.equal(employee.status, 200); assert.ok(employee.body.state.securityLock);
  assert.equal(employee.body.state.tickets[0].priority, 'urgent');
  assert.equal(employee.body.state.tickets[0].kind, 'security');
  assert.equal(employee.body.state.events.some(e => e.type === 'security-report'), true);
  const duplicate = await f.call('/api/action', { action: 'report-security', alertId: alert.id }, old.cookie);
  assert.equal(duplicate.body.duplicate, true); assert.equal(duplicate.body.state.tickets.length, 1);
  assert.equal((await f.call('/api/action', { action: 'report-security', alertId: alert.id }, staff.cookie)).status, 403);
});

test('lock stops old/new recipients and cash, including already prepared confirmations; time and reply do not lift it', async () => {
  const f = fixture(), old = await f.login('client'), source = await f.login('client'), staff = await f.login('employee');
  const request = { kind: 'transfer', recipientId: 'DEMO-FAMILY-001', amount: 300000 };
  assert.equal((await f.call('/api/action', { action: 'attempt', ...request }, old.cookie)).body.decision.allowed, true);
  const state = (await f.call('/api/state', undefined, old.cookie)).body.state;
  const reported = await f.call('/api/action', { action: 'report-security', alertId: state.securityAlerts[0].id }, old.cookie);
  for (const data of [request, { ...request, recipientId: 'DEMO-NEW-001' }, { kind: 'cash', amount: 100000 }]) {
    const res = await f.call('/api/action', { action: 'confirm', ...data, requestId: crypto.randomUUID() }, old.cookie);
    assert.equal(res.body.decision.code, 'ACCOUNT_SECURITY_LOCK'); assert.equal(res.body.operation.status, 'blocked');
    assert.equal(res.body.state.balance, 24830000);
  }
  await f.call('/api/action', { action: 'reply', ticketId: reported.body.state.tickets[0].id, reply: 'Проверяем обращение.' }, staff.cookie);
  await f.call('/api/action', { action: 'advance' }, staff.cookie);
  const blocked = await f.call('/api/action', { action: 'attempt', ...request }, old.cookie);
  assert.equal(blocked.body.decision.code, 'ACCOUNT_SECURITY_LOCK');
  assert.equal((await f.call('/api/action', { action: 'recovery' }, old.cookie)).status, 423);
  assert.equal((await f.call('/api/action', { action: 'phone', phone: '+7 000 000-00-02' }, old.cookie)).status, 423);
  const fresh = await f.login('client');
  const freshView = await f.call('/api/state', undefined, fresh.cookie);
  assert.ok(freshView.body.state.securityLock); assert.deepEqual(freshView.body.state.securityAlerts, []);
  assert.equal((await f.call('/api/action', { action: 'report-security', alertId: state.securityAlerts[0].id }, fresh.cookie)).status, 403);
});

test('existing pre-update bank state without security fields remains compatible', async () => {
  const f = fixture(), client = await f.login('client');
  const row = f.sql.prepare('SELECT data FROM bank_state').get(), state = JSON.parse(row.data);
  delete state.securityAlerts; delete state.securityLock;
  f.sql.prepare('UPDATE bank_state SET data = ?').run(JSON.stringify(state));
  const res = await f.call('/api/state', undefined, client.cookie);
  assert.equal(res.status, 200); assert.deepEqual(res.body.state.securityAlerts, []);
  await f.call('/api/action', { action: 'recovery' }, client.cookie);
  assert.equal((await f.call('/api/state', undefined, client.cookie)).status, 200);
});

const transfer = (extra = {}) => ({ kind: 'transfer', recipientId: 'DEMO-FAMILY-001', amount: 300000, requestId: crypto.randomUUID(), ...extra });
async function modelFixture(mode) {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee');
  await f.call('/api/action', { action: 'model-mode', mode }, staff.cookie);
  const send = (action, data = {}, employee = false) => f.call('/api/action', { ...data, action }, employee ? staff.cookie : client.cookie);
  return { ...f, client, staff, send };
}

test('model contract accepts exactly three named classes and rejects malformed responses', () => {
  for (const cls of ['normal', 'review', 'block']) assert.equal(normalizeClassification({ class: cls, model_version: 'v1' }).class, cls);
  for (const raw of [null, {}, { class: 'safe', model_version: 'v1' }, { class: 0, model_version: 'v1' }, { class: 'normal' }, { class: 'normal', model_version: '' }]) assert.equal(normalizeClassification(raw), null);
});

test('normal class requires confirmation; role and model verdict cannot be spoofed by client', async () => {
  const f = await modelFixture('normal'), request = transfer();
  const attempt = await f.send('attempt', { ...request, classification: { class: 'block' } });
  assert.equal(attempt.body.classification.class, 'normal'); assert.equal(attempt.body.decision.allowed, true);
  assert.equal(attempt.body.state.balance, 24830000);
  assert.equal('modelMock' in attempt.body.state, false);
  assert.equal((await f.send('model-mode', { mode: 'normal' })).status, 403);
  assert.equal((await f.send('review-transfer', { operationId: 'x' })).status, 403);
  assert.equal((await f.send('confirm-reviewed', { operationId: 'x' }, true)).status, 403);
  const paid = await f.send('confirm', request);
  assert.equal(paid.body.operation.status, 'completed'); assert.equal(paid.body.state.balance, 24530000);
  assert.equal(paid.body.operation.classification.source, 'mock');
  assert.equal('modelFeatures' in paid.body.operation, false);
});

test('review class queues without debit; approval alone cannot pay; client confirms immutable saved details once', async () => {
  const f = await modelFixture('review'), request = transfer();
  const attempt = await f.send('attempt', request), op = attempt.body.operation;
  assert.equal(op.status, 'pending'); assert.equal(op.code, 'MODEL_REVIEW');
  assert.equal(attempt.body.state.balance, 24830000);
  const again = await f.send('attempt', request);
  assert.equal(again.body.duplicate, true); assert.equal(again.body.operation.id, op.id);
  const premature = await f.send('confirm-reviewed', { operationId: op.id, review: { status: 'approved' } });
  assert.equal(premature.body.decision.allowed, false); assert.equal(premature.body.state.balance, 24830000);
  const approved = await f.send('review-transfer', { operationId: op.id, verdict: 'approve', comment: 'Клиент проверен по доверенному каналу.' }, true);
  assert.equal(approved.body.operation.review.status, 'approved'); assert.equal(approved.body.state.balance, 24830000);
  const duplicateConfirm = await f.send('confirm', request);
  assert.equal(duplicateConfirm.body.operation.status, 'pending'); assert.equal(duplicateConfirm.body.state.balance, 24830000);
  const paid = await f.send('confirm-reviewed', { operationId: op.id, amount: 99999999, recipientId: 'DEMO-RISK-001' });
  assert.equal(paid.body.operation.status, 'completed'); assert.equal(paid.body.operation.amount, 300000);
  assert.equal(paid.body.operation.recipientId, 'DEMO-FAMILY-001'); assert.equal(paid.body.state.balance, 24530000);
  const duplicate = await f.send('confirm-reviewed', { operationId: op.id });
  assert.equal(duplicate.body.duplicate, true); assert.equal(duplicate.body.state.balance, 24530000);
});

test('block class cannot be approved, directly confirmed, or resumed as reviewed', async () => {
  const f = await modelFixture('block'), request = transfer();
  const blocked = await f.send('attempt', { ...request, class: 'normal' });
  assert.equal(blocked.body.operation.status, 'blocked'); assert.equal(blocked.body.decision.code, 'MODEL_BLOCK');
  const op = blocked.body.operation;
  assert.equal((await f.send('review-transfer', { operationId: op.id, verdict: 'approve', comment: 'Попытка обхода.' }, true)).status, 400);
  assert.equal((await f.send('confirm-reviewed', { operationId: op.id })).body.decision.allowed, false);
  const direct = await f.send('confirm', transfer());
  assert.equal(direct.body.decision.code, 'MODEL_BLOCK'); assert.equal(direct.body.state.balance, 24830000);
});

test('classification is repeated at confirmation, not trusted from earlier result or browser', async () => {
  const f = await modelFixture('normal'), request = transfer();
  assert.equal((await f.send('attempt', request)).body.decision.allowed, true);
  await f.send('model-mode', { mode: 'block' }, true);
  const confirmed = await f.send('confirm', { ...request, classification: { class: 'normal' }, modelMode: 'normal' });
  assert.equal(confirmed.body.decision.code, 'MODEL_BLOCK'); assert.equal(confirmed.body.state.balance, 24830000);
});

test('model unavailable fails closed without adding a fourth classification or debiting', async () => {
  const f = await modelFixture('unavailable');
  const result = await f.send('confirm', transfer());
  assert.equal(result.body.classification, null); assert.equal(result.body.decision.code, 'MODEL_UNAVAILABLE');
  assert.equal(result.body.operation.status, 'pending'); assert.equal(result.body.state.balance, 24830000);
  assert.equal((await f.send('review-transfer', { operationId: result.body.operation.id, verdict: 'approve', comment: 'Недопустимое разрешение.' }, true)).status, 400);
});

test('staff rejection is terminal for original review and a reply is not an approval', async () => {
  const f = await modelFixture('review'), result = await f.send('attempt', transfer()), id = result.body.operation.id;
  const ticket = await f.send('ticket', { operationId: id });
  await f.send('reply', { ticketId: ticket.body.ticket.id, reply: 'Ожидайте проверки.' }, true);
  assert.equal((await f.send('confirm-reviewed', { operationId: id })).body.decision.allowed, false);
  const rejected = await f.send('review-transfer', { operationId: id, verdict: 'reject', comment: 'Клиент подтвердил влияние мошенника.' }, true);
  assert.equal(rejected.body.operation.code, 'MODEL_REVIEW_REJECTED');
  assert.equal((await f.send('confirm-reviewed', { operationId: id })).body.state.balance, 24830000);
  assert.equal((await f.send('review-transfer', { operationId: id, verdict: 'approve', comment: 'Нельзя изменить решение.' }, true)).status, 400);
});

test('staff approval never bypasses newly registered recipient', async () => {
  const f = await modelFixture('review'), result = await f.send('attempt', transfer()), id = result.body.operation.id;
  await f.send('review-transfer', { operationId: id, verdict: 'approve', comment: 'Первичная проверка завершена.' }, true);
  await f.send('registry-add', { entry: { recipient_id: 'DEMO-FAMILY-001', display_name: 'Мама', reason: 'Новый стоп-сигнал' } }, true);
  const stopped = await f.send('confirm-reviewed', { operationId: id });
  assert.equal(stopped.body.decision.code, 'RISK_REGISTRY'); assert.equal(stopped.body.state.balance, 24830000);
});

test('approval expires and is invalidated by critical changes or mock mode changes', async () => {
  for (const change of ['expiry', 'phone', 'mode']) {
    const f = await modelFixture('review'), result = await f.send('attempt', transfer()), id = result.body.operation.id;
    await f.send('review-transfer', { operationId: id, verdict: 'approve', comment: 'Проверка завершена.' }, true);
    if (change === 'phone') await f.send('phone', { phone: '+7 000 000-00-02' });
    if (change === 'mode') await f.send('model-mode', { mode: 'normal' }, true);
    if (change === 'expiry') {
      const state = JSON.parse(f.sql.prepare('SELECT data FROM bank_state').get().data);
      state.operations.find(op => op.id === id).review.expiresAt = 0;
      f.sql.prepare('UPDATE bank_state SET data = ?').run(JSON.stringify(state));
    }
    const response = await f.send('confirm-reviewed', { operationId: id });
    assert.equal(response.body.decision.allowed, false, change); assert.equal(response.body.operation.review.status, 'pending', change);
    assert.equal(response.body.state.balance, 24830000, change);
  }
});

test('review approval cannot override active hold; normal class cannot override hold or registry', async () => {
  const f = await modelFixture('review');
  const pending = await f.send('attempt', transfer({ recipientId: 'DEMO-NEW-001' }));
  await f.send('phone', { phone: '+7 000 000-00-02' });
  assert.equal((await f.send('review-transfer', { operationId: pending.body.operation.id, verdict: 'approve', comment: 'Нельзя отменить защитную паузу.' }, true)).status, 400);
  await f.send('model-mode', { mode: 'normal' }, true);
  assert.equal((await f.send('attempt', transfer({ recipientId: 'DEMO-NEW-001' }))).body.decision.code, 'NEW_RECIPIENT_HOLD');
  assert.equal((await f.send('attempt', transfer({ recipientId: 'DEMO-RISK-001' }))).body.decision.code, 'RISK_REGISTRY');
});

test('new model block or unavailable result invalidates a previously approved review', async () => {
  for (const mode of ['block', 'unavailable']) {
    const f = await modelFixture('review'), pending = await f.send('attempt', transfer()), id = pending.body.operation.id;
    await f.send('review-transfer', { operationId: id, verdict: 'approve', comment: 'Первичная проверка.' }, true);
    await f.send('model-mode', { mode }, true);
    const result = await f.send('confirm-reviewed', { operationId: id });
    assert.equal(result.body.decision.allowed, false);
    assert.equal(result.body.decision.code, mode === 'block' ? 'MODEL_BLOCK' : 'MODEL_UNAVAILABLE');
    assert.equal(result.body.state.balance, 24830000);
  }
});

test('account security lock overrides an approved review', async () => {
  const f = await modelFixture('review'), pending = await f.send('attempt', transfer()), id = pending.body.operation.id;
  await f.send('review-transfer', { operationId: id, verdict: 'approve', comment: 'Проверка завершена.' }, true);
  await f.login('client');
  const view = await f.call('/api/state', undefined, f.client.cookie);
  await f.send('report-security', { alertId: view.body.state.securityAlerts[0].id });
  const blocked = await f.send('confirm-reviewed', { operationId: id });
  assert.equal(blocked.body.decision.code, 'ACCOUNT_SECURITY_LOCK'); assert.equal(blocked.body.state.balance, 24830000);
});
