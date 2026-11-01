import test from 'node:test';
import assert from 'node:assert/strict';
import { bankApi } from '../lib/bank-api.mjs';
import { openDatabase } from '../server/database.mjs';
import { analyzePage } from '../server/scanner/analyze.mjs';
import { DEMO_SCENARIOS } from '../server/scanner/fixtures.mjs';
import { PURCHASE_TTL_MS } from '../lib/purchase-check.mjs';

const A = 'client-demo', B = 'client-demo-2';
const input = { url: 'https://merchant.example/PRIVATE_ORDER?token=PRIVATE_TOKEN#PRIVATE_HASH', recipientId: 'DEMO-CLASS-NORMAL', amount: 300000,
  explanation: 'Учебная покупка велосипеда: продавец прислал ссылку на оплату.', consent: true };

async function fixture(t, options = {}) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const scanCalls = [], cbrCalls = [];
  const runtime = {
    inspectWebsite: async args => {
      scanCalls.push(structuredClone(args));
      if (options.scanThrows) throw new Error('synthetic_timeout');
      const page = DEMO_SCENARIOS[args.demoScenario || 'shop_clone'];
      return analyzePage({ inputUrl: args.url || page.url, finalUrl: page.url, html: page.html, source: args.demoScenario ? 'demo' : 'live' });
    },
    cbrWarning: { checkUrl: async url => { cbrCalls.push(url); return { status: 'not_listed', matches: [], matchCount: 0 }; } },
  };
  const call = async (path, body, cookie = '', extraHeaders = {}) => {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body) }), db, runtime);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const login = async (login, password) => (await call('/api/auth/login', { login, password })).cookie;
  const a = await login('client', 'ClientDemo2026!'), b = await login('client2', 'ClientTwo2026!'), staff = await login('employee', 'BankDemo2026!');
  const action = (body, cookie = a) => call('/api/action', body, cookie);
  const state = async (cookie = a) => ok(await call('/api/state', undefined, cookie)).state;
  const check = (body = {}, cookie = a, headers) => call('/api/purchase/check', { ...input, ...body }, cookie, headers);
  const pay = (report, extra = {}, cookie = a) => action({ action: 'confirm', kind: 'transfer', recipientId: input.recipientId, amount: input.amount, requestId: crypto.randomUUID(), purchaseCheckId: report.id, ...extra }, cookie);
  const review = (op, extra = {}) => action({ action: 'review-transfer', operationId: op.id, verdict: 'approve', comment: 'Учебная банковская проверка завершена.', ...extra }, staff);
  const resume = (op, extra = {}) => action({ action: 'confirm-reviewed', operationId: op.id, ...extra });
  const mutate = async fn => { const row = await db.prepare('SELECT data FROM bank_state WHERE id = ?').bind(A).first(); const s = JSON.parse(row.data); fn(s); await db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ?').bind(JSON.stringify(s), A).run(); };
  return { db, call, ok, a, b, staff, action, state, check, pay, review, resume, mutate, scanCalls, cbrCalls };
}

test('purchase endpoint requires client authentication, consent and same-origin request before scanning', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/purchase/check', input)).status, 401);
  assert.equal((await f.check({}, f.staff)).status, 403);
  assert.equal((await f.check({}, f.a, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.check({}, f.a, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const change of [{ consent: false }, { amount: '300000' }, { recipientId: 'FOREIGN-RECIPIENT' }, { explanation: 'нет' }, { url: 'file:///etc/passwd' }]) assert.equal((await f.check(change)).status, 400);
  assert.equal(f.scanCalls.length, 0); assert.equal(f.cbrCalls.length, 0);
  f.ok(await f.check()); assert.equal(f.scanCalls.length, 1);
});

test('only sanitized server result persists; declared account or browser verdict cannot control it', async t => {
  const f = await fixture(t);
  const checked = f.ok(await f.check({ clientId: B, ownerClientId: B, status: 'no_signals', verdict: 'normal', reviewRequired: false, scan: { status: 'completed', verdict: 'no_signals', findings: [] } }));
  assert.equal(checked.report.status, 'review');
  assert.ok(checked.report.scan.findings.some(x => x.code === 'BRAND_CREDENTIALS'));
  assert.equal(checked.report.site.ownershipVerified, false);
  assert.equal(f.scanCalls[0].url, input.url); assert.equal(f.cbrCalls[0], input.url);
  assert.equal(checked.state.purchaseChecks.length, 1); assert.deepEqual((await f.state(f.b)).purchaseChecks, []);
  const row = await f.db.prepare('SELECT data FROM bank_state WHERE id = ?').bind(A).first();
  for (const secret of ['PRIVATE_ORDER', 'PRIVATE_TOKEN', 'PRIVATE_HASH', 'collector.example', 'card_number', '<form']) assert.equal(row.data.includes(secret), false, secret);
  assert.equal(JSON.stringify(checked.report).includes('phishing_score'), false);
});

test('saved report binding is owner-scoped and cannot change recipient, amount or operation kind', async t => {
  const f = await fixture(t), report = f.ok(await f.check()).report, before = (await f.state()).balance;
  for (const change of [{ amount: 1 }, { recipientId: 'DEMO-FAMILY-001' }, { kind: 'cash' }, { purchaseCheckId: 'PURCHASE-foreign' }]) assert.equal((await f.pay(report, change)).status, 409, JSON.stringify(change));
  assert.equal((await f.pay(report, {}, f.b)).status, 409);
  assert.equal((await f.call(`/api/state?clientId=${A}`, undefined, f.b)).status, 403);
  assert.equal((await f.state()).balance, before);
});

test('concrete purchase risk forces bank review despite forged normal class and approval', async t => {
  const f = await fixture(t), report = f.ok(await f.check()).report, before = (await f.state()).balance;
  const paid = f.ok(await f.pay(report, { classification: { class: 'normal' }, review: { status: 'approved' }, allowed: true, skipTrusted: true }));
  assert.equal(paid.operation.status, 'pending'); assert.equal(paid.operation.code, 'MODEL_REVIEW');
  assert.equal(paid.operation.purchaseCheckId, report.id); assert.equal(paid.operation.classification.source, 'policy');
  assert.equal(paid.operation.review.status, 'pending'); assert.equal(paid.state.balance, before);
  const staff = f.ok(await f.call('/api/state', undefined, f.staff)).state;
  assert.equal(staff.operations.find(o => o.id === paid.operation.id).purchaseCheckId, report.id);
  assert.equal(staff.purchaseChecks.find(r => r.id === report.id).explanation, input.explanation);
});

test('staff approval never sends money automatically; owner confirmation uses immutable saved operation once', async t => {
  const f = await fixture(t), report = f.ok(await f.check()).report, before = (await f.state()).balance;
  const op = f.ok(await f.pay(report)).operation;
  assert.equal(f.ok(await f.resume(op)).decision.allowed, false);
  f.ok(await f.review(op)); assert.equal((await f.state()).balance, before);
  assert.equal((await f.action({ action: 'confirm-reviewed', operationId: op.id }, f.staff)).status, 403);
  const result = f.ok(await f.resume(op, { amount: 1, recipientId: 'DEMO-FAMILY-001', purchaseCheckId: 'forged' }));
  assert.equal(result.operation.status, 'completed'); assert.equal(result.operation.amount, input.amount);
  assert.equal(result.operation.recipientId, input.recipientId); assert.equal(result.operation.purchaseCheckId, report.id);
  assert.equal(result.state.balance, before - input.amount);
  assert.equal(f.ok(await f.resume(op)).duplicate, true); assert.equal((await f.state()).balance, before - input.amount);
});

test('bank purchase review and guardian approval are independent mandatory conditions', async t => {
  const f = await fixture(t);
  f.ok(await f.action({ action: 'trusted-policy', enabled: true, limit: 100000, mode: 'any', guardianLogins: ['client2'], password: 'ClientDemo2026!' }));
  const report = f.ok(await f.check()).report, op = f.ok(await f.pay(report)).operation, before = (await f.state()).balance;
  assert.equal(op.guardianApproval.status, 'pending'); f.ok(await f.review(op));
  assert.equal(f.ok(await f.resume(op)).decision.code, 'TRUSTED_REQUIRED'); assert.equal((await f.state()).balance, before);
  f.ok(await f.call('/api/trusted/decision', { ownerClientId: A, operationId: op.id, requestId: op.guardianApproval.id, verdict: 'approve' }, f.b));
  assert.equal((await f.state()).balance, before);
  assert.equal(f.ok(await f.action({ action: 'confirm-trusted', operationId: op.id })).operation.status, 'completed');
  assert.equal((await f.state()).balance, before - input.amount);
});

test('new registry stop after review prevents purchase payment and preserves balance', async t => {
  const f = await fixture(t), report = f.ok(await f.check()).report, op = f.ok(await f.pay(report)).operation;
  f.ok(await f.review(op));
  f.ok(await f.action({ action: 'registry-add', entry: { recipient_id: input.recipientId, display_name: 'Учебный продавец', reason: 'Новое независимое основание блокировки.' } }, f.staff));
  const before = (await f.state()).balance, result = f.ok(await f.resume(op));
  assert.equal(result.decision.code, 'RISK_REGISTRY'); assert.equal(result.decision.allowed, false); assert.equal(result.state.balance, before);
});

test('expired purchase cannot be approved or completed, even with earlier staff approval', async t => {
  const f = await fixture(t), report = f.ok(await f.check()).report, op = f.ok(await f.pay(report)).operation;
  f.ok(await f.review(op)); const before = (await f.state()).balance;
  await f.mutate(s => { const r = s.purchaseChecks.find(r => r.id === report.id); r.createdAt = Date.now() - PURCHASE_TTL_MS - 1000; r.expiresAt = r.createdAt + PURCHASE_TTL_MS; });
  assert.equal((await f.resume(op)).status, 409);
  assert.equal((await f.review(op)).status, 409);
  assert.equal((await f.pay(report)).status, 409);
  assert.equal((await f.state()).balance, before);
});

test('removing a saved purchase binding cannot reuse the same pending request ID', async t => {
  const f = await fixture(t), report = f.ok(await f.check()).report, requestId = 'purchase-bound-request-0001';
  const op = f.ok(await f.pay(report, { requestId })).operation;
  const result = await f.action({ action: 'confirm', kind: 'transfer', recipientId: input.recipientId, amount: input.amount, requestId });
  assert.equal(result.status, 409);
  assert.equal((await f.state()).operations.find(o => o.id === op.id).status, 'pending');
});

test('page unavailable is incomplete or review, never successful safety result', async t => {
  const f = await fixture(t, { scanThrows: true }), checked = f.ok(await f.check());
  assert.equal(checked.report.incomplete, true); assert.notEqual(checked.report.status, 'no_signals');
  const result = f.ok(await f.pay(checked.report));
  assert.equal(result.operation.status, 'pending'); assert.equal(result.operation.code, 'MODEL_REVIEW');
});

test('raw main-model block and unavailable remain stronger than purchase review', async t => {
  // Fixed DEMO-CLASS-* fixtures intentionally ignore the staff mock switch.
  const f = await fixture(t), report = f.ok(await f.check({ recipientId: 'DEMO-FAMILY-001' })).report, before = (await f.state()).balance;
  for (const [mode, expected] of [['block', 'MODEL_BLOCK'], ['unavailable', 'MODEL_UNAVAILABLE']]) {
    f.ok(await f.action({ action: 'model-mode', mode }, f.staff));
    const result = f.ok(await f.pay(report, { recipientId: report.recipientId })); assert.equal(result.decision.code, expected); assert.equal(result.state.balance, before);
  }
});

test('jury demo forwards only exact allowlisted fixture and never queries official list for made-up domain', async t => {
  const f = await fixture(t), result = f.ok(await f.check({ demoScenario: 'shop_clone', url: 'http://127.0.0.1/private' }));
  assert.equal(f.scanCalls[0].demoScenario, 'shop_clone'); assert.equal(f.scanCalls[0].url, DEMO_SCENARIOS.shop_clone.url);
  assert.equal(f.cbrCalls.length, 0); assert.equal(result.report.source, 'demo');
  assert.equal(result.report.site.origin, 'https://ozon-sale.example');
  assert.ok(result.report.scan.findings.some(x => x.code === 'BRAND_CREDENTIALS'));
  assert.equal((await f.check({ demoScenario: 'custom' })).status, 400);
});
