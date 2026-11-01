import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/database.mjs';
import { bankApi } from '../lib/bank-api.mjs';
import { QR_DEMOS } from '../public/qr-view.mjs';

const payload = QR_DEMOS.normal.text;
const sharedPayload = QR_DEMOS.shared.text;
const privateNote = 'PRIVATE-QR-COMPLAINT: учебный продавец взял деньги за велосипед, товар не доставил и перестал отвечать.';

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let providerCalls = 0;
  const runtime = { fetcher: async () => { providerCalls++; throw new Error('No external network allowed in QR tests'); } };
  const successful = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  async function call(path, body, cookie = '', headers = {}) {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), db, runtime);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async role => {
    const password = role === 'employee' ? 'BankDemo2026!' : role === 'client2' ? 'ClientTwo2026!' : 'ClientDemo2026!';
    const result = await call('/api/auth/login', { login: role, password });
    successful(result); return result.cookie;
  };
  const action = (body, cookie, headers) => call('/api/action', body, cookie, headers);
  const state = async cookie => successful(await call('/api/state', undefined, cookie)).state;
  const resolve = async (text, cookie, extra = {}) => successful(await call('/api/qr/resolve', { payload: text, ...extra }, cookie)).payment;
  const stored = async (clientId = 'client-demo') => JSON.parse((await db.prepare('SELECT data FROM bank_state WHERE id = ?').bind(clientId).first()).data);
  const request = (actionName, extra = {}) => ({ action: actionName, qrPayload: payload, qrFixtureId: 'demo-qr-normal', requestId: 'qr-api-request-0001', ...extra });
  return { db, call, login, action, state, resolve, stored, request, successful, providerCalls: () => providerCalls };
}

test('QR API authenticates, rejects cross-site requests and does not give staff payment permissions', async t => {
  const f = fixture(t);
  assert.equal((await f.call('/api/qr/resolve', { payload })).status, 401);
  assert.equal((await f.action(f.request('attempt'))).status, 401);
  const client = await f.login('client'), staff = await f.login('employee');
  for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.call('/api/qr/resolve', { payload }, client, headers)).status, 403);
    assert.equal((await f.action(f.request('confirm'), client, headers)).status, 403);
  }
  assert.equal((await f.action(f.request('attempt'), staff)).status, 403);
  assert.equal((await f.action(f.request('confirm'), staff)).status, 403);
  assert.equal((await f.resolve(payload, client)).supported, true);
  assert.equal(f.providerCalls(), 0);
});

test('QR resolution is read-only, does not invent authorization or allow client-supplied risk counts', async t => {
  const f = fixture(t), client = await f.login('client');
  const before = await f.db.prepare('SELECT data, revision FROM bank_state WHERE id = ?').bind('client-demo').first();
  const report = await f.resolve(payload, client, { amount: 1, recipientId: 'DEMO-FORGED', allowed: true, reviewedComplaintCount: 99 });
  assert.equal(report.demo, true);
  assert.equal(report.recipient.id, 'DEMO-FAMILY-001');
  assert.equal(report.amountKopecks, 100000);
  assert.equal(report.registryStatus, 'clear');
  assert.equal(report.recipientVerified, false);
  assert.equal(report.authenticQrVerified, false);
  assert.equal('allowed' in report, false);
  assert.equal('safe' in report, false);
  assert.notEqual(report.reviewedComplaintCount, 99);
  const after = await f.db.prepare('SELECT data, revision FROM bank_state WHERE id = ?').bind('client-demo').first();
  assert.deepEqual(after, before);
  assert.equal(f.providerCalls(), 0);
});

test('unknown, subscription and altered QR never become transfers and never invoke a network provider', async t => {
  const f = fixture(t), client = await f.login('client'), before = await f.state(client);
  for (const text of [QR_DEMOS.sbp.text, QR_DEMOS.subscription.text, QR_DEMOS.spoof.text, QR_DEMOS.mismatch.text, `${payload}?sum=1`, `${payload} `, 'https://127.0.0.1/admin', 'https://unknown.example/secret']) {
    const report = await f.resolve(text, client);
    assert.equal(report.supported, false);
    assert.equal(report.registryStatus, 'not_checked');
    const stopped = await f.action(f.request('confirm', { qrPayload: text, kind: 'cash', amount: 1 }), client);
    assert.equal(stopped.status, 400, JSON.stringify(stopped.body));
  }
  const after = await f.state(client);
  assert.equal(after.balance, before.balance);
  assert.deepEqual(after.operations, before.operations);
  assert.equal(f.providerCalls(), 0);
});

test('QR transfer rejects missing or mismatched fixture binding without recording any operation', async t => {
  const f = fixture(t), client = await f.login('client'), before = await f.state(client);
  for (const body of [
    { action: 'confirm', qrPayload: payload, requestId: 'qr-api-bad-001' },
    { action: 'confirm', qrFixtureId: 'demo-qr-normal', requestId: 'qr-api-bad-002' },
    f.request('confirm', { qrFixtureId: 'demo-qr-shared' }),
    f.request('confirm', { qrPayload: sharedPayload }),
    f.request('confirm', { qrPayload: null, kind: 'cash', amount: 100000 }),
  ]) assert.equal((await f.action(body, client)).status, 400);
  const after = await f.state(client);
  assert.equal(after.balance, before.balance);
  assert.deepEqual(after.operations, before.operations);
});

test('QR payment uses authoritative amount, recipient and transfer kind at attempt and confirmation', async t => {
  const f = fixture(t), client = await f.login('client'), before = await f.state(client);
  const forged = { kind: 'cash', amount: 1, recipientId: 'DEMO-FORGED', recipientName: 'PRIVATE-FORGED-NAME', classification: { class: 'block' } };
  const checked = f.successful(await f.action(f.request('attempt', forged), client));
  assert.equal(checked.decision.allowed, true);
  assert.equal(checked.classification.class, 'normal');
  assert.equal(checked.state.balance, before.balance);
  assert.equal(checked.operation, null);
  const completed = f.successful(await f.action(f.request('confirm', forged), client));
  assert.equal(completed.operation.kind, 'transfer');
  assert.equal(completed.operation.recipientId, 'DEMO-FAMILY-001');
  assert.equal(completed.operation.recipientName, 'Мама');
  assert.equal(completed.operation.amount, 100000);
  assert.equal(completed.operation.status, 'completed');
  assert.equal(completed.state.balance, before.balance - 100000);
  const saved = await f.stored();
  const operation = saved.operations.find(item => item.id === completed.operation.id);
  assert.deepEqual(operation.paymentContext, { source: 'demo_qr_adapter', fixtureId: 'demo-qr-normal', fixtureVersion: 'demo-qr-v1', recipientId: 'DEMO-FAMILY-001' });
  for (const forbidden of [payload, 'qrPayload', 'PRIVATE-FORGED-NAME', 'DEMO-FORGED']) assert.equal(JSON.stringify(saved).includes(forbidden), false, forbidden);
});

test('replayed QR confirmation does not debit again or mutate the original canonical context', async t => {
  const f = fixture(t), client = await f.login('client'), before = await f.state(client);
  const first = f.successful(await f.action(f.request('confirm'), client));
  const replay = f.successful(await f.action(f.request('confirm', { amount: 1, recipientId: 'DEMO-FAKE' }), client));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.operation.id, first.operation.id);
  assert.equal(replay.state.balance, before.balance - 100000);
  const state = await f.stored();
  assert.equal(state.operations.filter(operation => operation.requestId === 'qr-api-request-0001').length, 1);
  assert.equal(state.operations.find(operation => operation.requestId === 'qr-api-request-0001').paymentContext.fixtureId, 'demo-qr-normal');
});

test('a saved QR request ID cannot be reused for another fixture or the ordinary payment form', async t => {
  const f = fixture(t), client = await f.login('client');
  const completed = f.successful(await f.action(f.request('confirm'), client));
  const before = await f.state(client);
  const wrongFixture = await f.action(f.request('confirm', { qrPayload: sharedPayload, qrFixtureId: 'demo-qr-shared' }), client);
  assert.equal(wrongFixture.status, 409);
  const wrongChannel = await f.action({ action: 'confirm', kind: 'transfer', recipientId: completed.operation.recipientId,
    amount: completed.operation.amount, requestId: 'qr-api-request-0001' }, client);
  assert.equal(wrongChannel.status, 409);
  assert.equal((await f.state(client)).balance, before.balance);
  assert.deepEqual((await f.state(client)).operations, before.operations);
});

test('new registry mark after QR preview and attempt blocks the confirmation, including a previous recipient', async t => {
  const f = fixture(t), client = await f.login('client'), staff = await f.login('employee'), before = await f.state(client);
  assert.equal((await f.resolve(payload, client)).registryStatus, 'clear');
  assert.equal(f.successful(await f.action(f.request('attempt'), client)).decision.allowed, true);
  f.successful(await f.action({ action: 'registry-add', entry: { recipient_id: 'DEMO-FAMILY-001', display_name: 'Учебный прежний получатель', reason: 'PRIVATE-REGISTRY-REASON: проверка сотрудником.' } }, staff));
  const refreshed = await f.resolve(payload, client);
  assert.equal(refreshed.registryStatus, 'blocked');
  assert.doesNotMatch(JSON.stringify(refreshed), /PRIVATE-REGISTRY-REASON/);
  const stopped = f.successful(await f.action(f.request('confirm'), client));
  assert.equal(stopped.decision.code, 'RISK_REGISTRY');
  assert.equal(stopped.operation.status, 'blocked');
  assert.equal(stopped.state.balance, before.balance);
});

test('another client sees only reviewed complaint count; draft and submitted reports cannot mark QR recipient', async t => {
  const f = fixture(t), clientA = await f.login('client'), clientB = await f.login('client2'), staff = await f.login('employee');
  const beforeA = await f.state(clientA), beforeB = await f.state(clientB);
  const created = f.successful(await f.action({ action: 'report-create', operationId: 'HISTORY-DEMO-CLASS-NORMAL' }, clientA));
  const draftPreview = await f.resolve(sharedPayload, clientB);
  assert.equal(draftPreview.registryStatus, 'clear');
  assert.equal(draftPreview.reviewedComplaintCount ?? 0, 0);
  f.successful(await f.action({ action: 'report-submit', reportId: created.reportId, note: privateNote }, clientA));
  const submittedPreview = await f.resolve(sharedPayload, clientB);
  assert.equal(submittedPreview.registryStatus, 'clear');
  assert.equal(submittedPreview.reviewedComplaintCount ?? 0, 0);
  f.successful(await f.action({ action: 'report-review', reportId: created.reportId, verdict: 'watch', comment: 'PRIVATE-EMPLOYEE-NOTE: учебная проверка обращения.' }, staff));
  const reviewedPreview = await f.resolve(sharedPayload, clientB);
  assert.equal(reviewedPreview.registryStatus, 'watch');
  assert.equal(reviewedPreview.hasReviewedComplaints, true);
  assert.equal(reviewedPreview.reviewedComplaintCount, 1);
  for (const secret of [created.reportId, privateNote, 'PRIVATE-QR-COMPLAINT', 'PRIVATE-EMPLOYEE-NOTE', 'Анна Ковалёва', 'client-demo', 'HISTORY-DEMO-CLASS-NORMAL']) assert.equal(JSON.stringify(reviewedPreview).includes(secret), false, secret);
  const checked = f.successful(await f.action(f.request('attempt', { qrPayload: sharedPayload, qrFixtureId: 'demo-qr-shared', requestId: 'qr-api-second-client-001' }), clientB));
  assert.equal(checked.decision.code, 'MODEL_REVIEW');
  assert.equal(checked.operation.status, 'pending');
  assert.equal(checked.state.balance, beforeB.balance);
  assert.equal((await f.state(clientA)).balance, beforeA.balance);
  assert.deepEqual((await f.state(clientB)).fraudReports, []);
});

test('QR bank adapter cannot bypass a full account security lock', async t => {
  const f = fixture(t), client = await f.login('client'), before = await f.state(client);
  const internal = await f.stored();
  internal.securityLock = { at: Date.now(), alertId: 'TEST-SECURITY-LOCK', eventText: 'Учебный неизвестный вход' };
  await f.db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ?').bind(JSON.stringify(internal), 'client-demo').run();
  const result = f.successful(await f.action(f.request('confirm'), client));
  assert.equal(result.decision.code, 'ACCOUNT_SECURITY_LOCK');
  assert.equal(result.operation.status, 'blocked');
  assert.equal(result.state.balance, before.balance);
});
