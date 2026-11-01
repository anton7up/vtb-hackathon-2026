import test from 'node:test';
import assert from 'node:assert/strict';
import { bankApi } from '../lib/bank-api.mjs';
import { openDatabase } from '../server/database.mjs';

const CLIENT_A = 'client-demo';
const CLIENT_B = 'client-demo-2';
const PAYEE = 'DEMO-CLASS-NORMAL';
const HISTORY = 'HISTORY-DEMO-CLASS-NORMAL';
const PRIVATE_A = 'ALPHA_PRIVATE_NARRATIVE_ONLY: учебный магазин не доставил оплаченный товар.';
const PRIVATE_B = 'BRAVO_PRIVATE_NARRATIVE_ONLY: после оплаты продавец перестал отвечать.';

async function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const successful = result => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const call = async (path, body, cookie = '') => {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), db);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (login, password) => {
    const result = await call('/api/auth/login', { login, password });
    successful(result);
    return { ...result.body.user, cookie: result.cookie };
  };
  const a = await login('client', 'ClientDemo2026!');
  const b = await login('client2', 'ClientTwo2026!');
  const staff = await login('employee', 'BankDemo2026!');
  const action = (user, body) => call('/api/action', body, user.cookie);
  const state = async (user, clientId) => successful(await call(`/api/state${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`, undefined, user.cookie)).state;
  const create = async (user, operationId = HISTORY) => successful(await action(user, { action: 'report-create', operationId }));
  const submit = async (user, reportId, note = user.clientId === CLIENT_A ? PRIVATE_A : PRIVATE_B) => successful(await action(user, { action: 'report-submit', reportId, note }));
  const review = async (clientId, reportId, verdict, comment = 'Проверены обстоятельства учебной жалобы.') => successful(await action(staff, { action: 'report-review', clientId, reportId, verdict, comment }));
  const pay = async (user, recipientId = PAYEE, amount = 100000) => successful(await action(user, { action: 'confirm', kind: 'transfer', recipientId, amount, requestId: `shared-pay-${crypto.randomUUID()}` }));
  const registry = async () => successful(await call('/api/registry', undefined, staff.cookie)).entries;
  const summary = async (clientId = CLIENT_A, recipientId = PAYEE) => (await state(staff, clientId)).recipientRiskSummary.find(row => row.recipientId === recipientId);
  return { db, a, b, staff, call, action, state, create, submit, review, pay, registry, summary, successful };
}

function stringValues(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringValues);
}

test('employee selects either client, while clients cannot select or mutate another account', async t => {
  const f = await fixture(t);
  assert.equal(f.a.clientId, CLIENT_A);
  assert.equal(f.b.clientId, CLIENT_B);
  const listed = f.successful(await f.call('/api/clients', undefined, f.staff.cookie));
  assert.deepEqual(listed.clients.map(row => row.id).sort(), [CLIENT_A, CLIENT_B, 'client-demo-3']);
  assert.equal(listed.clients.every(row => Object.keys(row).sort().join(',') === 'id,name'), true);
  for (const user of [f.a, f.b]) assert.equal((await f.call('/api/clients', undefined, user.cookie)).status, 403);
  for (const clientId of [CLIENT_A, CLIENT_B]) {
    const state = await f.state(f.staff, clientId);
    assert.equal(state.clientId, clientId);
    assert.equal(state.client.id, clientId);
    assert.equal(typeof state.registryRevision, 'number');
    assert.ok(Array.isArray(state.recipientRiskSummary));
  }
  assert.equal((await f.call(`/api/state?clientId=${CLIENT_A}`, undefined, f.b.cookie)).status, 403);
  assert.equal((await f.call(`/api/state?clientId=${CLIENT_B}`, undefined, f.a.cookie)).status, 403);
  assert.equal((await f.call('/api/state?clientId=missing-client', undefined, f.staff.cookie)).status, 404);
  assert.equal((await f.state(f.a, CLIENT_A)).clientId, CLIENT_A);
  assert.equal((await f.state(f.b, CLIENT_B)).clientId, CLIENT_B);
  const beforeA = await f.state(f.a), beforeB = await f.state(f.b);
  const forged = await f.action(f.b, { action: 'confirm', clientId: CLIENT_A, kind: 'transfer', recipientId: PAYEE, amount: 100000, requestId: 'shared-forged-client-id' });
  assert.equal(forged.status, 403);
  assert.equal((await f.state(f.a)).balance, beforeA.balance);
  assert.equal((await f.state(f.b)).balance, beforeB.balance);
});

test('customer balances and employee demo modes are scoped independently', async t => {
  const f = await fixture(t), beforeA = await f.state(f.a), beforeB = await f.state(f.b);
  const paid = await f.pay(f.b, PAYEE, 250000);
  assert.equal(paid.operation.status, 'completed');
  assert.equal((await f.state(f.a)).balance, beforeA.balance);
  assert.equal((await f.state(f.b)).balance, beforeB.balance - 250000);
  f.successful(await f.action(f.staff, { action: 'model-mode', clientId: CLIENT_B, mode: 'review' }));
  assert.equal((await f.state(f.staff, CLIENT_B)).modelMock.mode, 'review');
  assert.equal((await f.state(f.staff, CLIENT_A)).modelMock.mode, 'normal');
});

test('A draft stays private, then reviewed A complaint protects B without exposing A narrative or identity', async t => {
  const f = await fixture(t), beforeB = await f.state(f.b), created = await f.create(f.a);
  assert.equal((await f.state(f.a)).fraudReports.length, 1);
  assert.deepEqual((await f.state(f.staff, CLIENT_A)).fraudReports, []);
  assert.deepEqual((await f.state(f.b)).fraudReports, []);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM complaint_index').first()).n, 0);
  await f.submit(f.a, created.reportId);
  const selectedA = await f.state(f.staff, CLIENT_A), selectedB = await f.state(f.staff, CLIENT_B);
  assert.match(JSON.stringify(selectedA.fraudReports), /ALPHA_PRIVATE_NARRATIVE_ONLY/);
  assert.deepEqual(selectedB.fraudReports, []);
  assert.equal((await f.pay(f.b)).operation.status, 'completed'); // A pending complaint alone is not a stop signal.
  const afterOrdinaryPayment = await f.state(f.b);
  const reviewed = await f.review(CLIENT_A, created.reportId, 'watch', 'ALPHA_PRIVATE_EMPLOYEE_COMMENT: проверено сотрудником.');
  assert.equal(reviewed.state.clientId, CLIENT_A);
  const result = await f.pay(f.b);
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.code, 'MODEL_REVIEW');
  assert.equal(result.classification.source, 'policy');
  assert.equal(result.operation.status, 'pending');
  assert.equal(result.state.balance, afterOrdinaryPayment.balance);
  assert.equal(result.state.balance, beforeB.balance - 100000);
  assert.deepEqual(result.state.fraudReports, []);
  assert.deepEqual(result.state.recipientRiskSummary.find(row => row.recipientId === PAYEE), { recipientId: PAYEE, status: 'watch', reviewedCount: 1, source: 'reviewed_complaints' });
  const serialized = JSON.stringify(result.body || result);
  for (const secret of [created.reportId, PRIVATE_A, 'ALPHA_PRIVATE_EMPLOYEE_COMMENT', f.a.name]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(stringValues(result).includes(CLIENT_A), false);
  const index = (await f.db.prepare('SELECT * FROM complaint_index').all()).results;
  assert.equal(index.length, 1);
  assert.equal(JSON.stringify(index).includes('ALPHA_PRIVATE'), false);
  assert.equal(Object.keys(index[0]).some(key => /note|dialog|turn|assessment|comment/i.test(key)), false);
});

test('B cannot report A-only operation or access A complaint by guessing its UUID', async t => {
  const f = await fixture(t), paymentA = await f.pay(f.a);
  assert.equal(paymentA.operation.status, 'completed');
  assert.equal((await f.state(f.b)).operations.some(row => row.id === paymentA.operation.id), false);
  const created = await f.create(f.a, paymentA.operation.id);
  await f.submit(f.a, created.reportId);
  for (const body of [
    { action: 'report-create', operationId: paymentA.operation.id },
    { action: 'report-submit', reportId: created.reportId, note: 'Поддельное описание от другого клиента.' },
    { action: 'report-withdraw', reportId: created.reportId },
  ]) assert.ok([400, 404].includes((await f.action(f.b, body)).status), JSON.stringify(body));
  const wrongSelection = await f.action(f.staff, { action: 'report-review', clientId: CLIENT_B, reportId: created.reportId, verdict: 'block', comment: 'Попытка открыть жалобу другого выбранного клиента.' });
  assert.ok([400, 404].includes(wrongSelection.status));
  const chat = await f.call('/api/complaints/chat', { reportId: created.reportId, message: 'Попытка чужого ответа', consent: true, requestId: 'shared-foreign-report-chat' }, f.b.cookie);
  assert.ok([400, 404].includes(chat.status));
  assert.deepEqual((await f.state(f.b)).fraudReports, []);
  assert.equal((await f.state(f.a)).fraudReports[0].status, 'submitted');
});

test('repeated creation cannot inflate counts; multiple reports count distinct customers once', async t => {
  const f = await fixture(t), extraPayment = await f.pay(f.a);
  const first = await f.create(f.a), second = await f.create(f.a, extraPayment.operation.id);
  await f.submit(f.a, first.reportId);
  await f.submit(f.a, second.reportId);
  const duplicate = await f.create(f.a);
  assert.equal(duplicate.reportId, first.reportId);
  let aggregate = await f.summary();
  assert.equal(aggregate.reportCount, 2);
  assert.equal(aggregate.uniqueReporters, 1);
  assert.equal(aggregate.submittedCount, 2);
  const bReport = await f.create(f.b);
  await f.submit(f.b, bReport.reportId);
  aggregate = await f.summary();
  assert.equal(aggregate.reportCount, 3);
  assert.equal(aggregate.uniqueReporters, 2);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM complaint_index').first()).n, 3);
});

test('shared block wins watch; dismissing or resetting A preserves B protection and shared manual entries', async t => {
  const f = await fixture(t), aReport = await f.create(f.a), bReport = await f.create(f.b);
  await f.submit(f.a, aReport.reportId);
  await f.submit(f.b, bReport.reportId);
  await f.review(CLIENT_A, aReport.reportId, 'block');
  await f.review(CLIENT_B, bReport.reportId, 'watch');
  let aggregate = await f.summary();
  assert.equal(aggregate.reportCount, 2);
  assert.equal(aggregate.uniqueReporters, 2);
  assert.equal(aggregate.status, 'active');
  assert.equal(aggregate.blockCount, 1);
  assert.equal(aggregate.watchCount, 1);
  assert.equal((await f.pay(f.b)).decision.code, 'RISK_REGISTRY');
  await f.review(CLIENT_A, aReport.reportId, 'dismiss');
  aggregate = await f.summary();
  assert.equal(aggregate.status, 'watch');
  assert.equal(aggregate.dismissedCount, 1);
  assert.equal(aggregate.watchCount, 1);
  assert.equal(aggregate.blockCount, 0);
  f.successful(await f.action(f.staff, { action: 'registry-add', clientId: CLIENT_A, entry: { recipient_id: 'DEMO-MANUAL-SHARED', display_name: 'Общий учебный получатель', reason: 'Независимое ручное основание сотрудника.' } }));
  const beforeB = await f.state(f.b);
  const resetA = f.successful(await f.action(f.staff, { action: 'reset', clientId: CLIENT_A }));
  assert.equal(resetA.state.clientId, CLIENT_A);
  assert.deepEqual(resetA.state.fraudReports, []);
  assert.equal((await f.state(f.b)).balance, beforeB.balance);
  assert.equal((await f.state(f.b)).fraudReports[0].id, bReport.reportId);
  aggregate = await f.summary(CLIENT_B);
  assert.equal(aggregate.reportCount, 1);
  assert.equal(aggregate.uniqueReporters, 1);
  assert.equal(aggregate.status, 'watch');
  const registry = await f.registry();
  assert.equal(registry.find(row => row.recipient_id === PAYEE).status, 'watch');
  assert.equal(registry.find(row => row.recipient_id === 'DEMO-MANUAL-SHARED').source, 'synthetic_employee_entry');
  assert.equal((await f.pay(f.b)).decision.code, 'MODEL_REVIEW');
});

test('A shared risk change invalidates B employee approval before client confirmation', async t => {
  const f = await fixture(t), recipientId = 'DEMO-CLASS-REVIEW';
  const pending = await f.pay(f.b, recipientId);
  assert.equal(pending.operation.status, 'pending');
  f.successful(await f.action(f.staff, { action: 'review-transfer', clientId: CLIENT_B, operationId: pending.operation.id, verdict: 'approve', comment: 'Первичная учебная проверка выполнена.' }));
  assert.equal((await f.state(f.b)).operations.find(row => row.id === pending.operation.id).review.status, 'approved');
  const created = await f.create(f.a, 'HISTORY-DEMO-CLASS-REVIEW');
  await f.submit(f.a, created.reportId);
  await f.review(CLIENT_A, created.reportId, 'watch');
  const before = await f.state(f.b);
  const resumed = f.successful(await f.action(f.b, { action: 'confirm-reviewed', operationId: pending.operation.id }));
  assert.equal(resumed.decision.allowed, false);
  assert.equal(resumed.operation.status, 'pending');
  assert.equal(resumed.operation.review.status, 'pending');
  assert.equal(resumed.state.balance, before.balance);
  assert.match(resumed.operation.reason, /Условия|Требуется новое решение/);
});

test('registry change between B check and database commit forces recheck instead of a stale debit', async t => {
  const f = await fixture(t), created = await f.create(f.a);
  await f.submit(f.a, created.reportId);
  const before = await f.state(f.b);
  const originalBatch = f.db.batch;
  let intercepted = false;
  f.db.batch = async statements => {
    if (!intercepted) {
      intercepted = true;
      // Another legitimate API action lands after B has evaluated its payment,
      // but before B's atomic transaction. No real database or network is used.
      await f.review(CLIENT_A, created.reportId, 'block');
    }
    return originalBatch(statements);
  };
  const result = await f.pay(f.b);
  assert.equal(intercepted, true);
  assert.equal(result.operation.status, 'blocked');
  assert.equal(result.decision.code, 'RISK_REGISTRY');
  assert.equal(result.decision.allowed, false);
  assert.equal(result.state.balance, before.balance);
  assert.equal((await f.state(f.b)).operations.filter(row => !row.seeded && row.kind === 'transfer').length, 1);
});
