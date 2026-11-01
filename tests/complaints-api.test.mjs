import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { bankApi } from '../lib/bank-api.mjs';

const CLAIM = 'Учебный продавец обещал велосипед, но после оплаты не доставил товар и не отвечает.';
const SOURCE = 'synthetic_complaint_review';
const modelReply = (next = null) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
  summary: 'По словам клиента, учебный продавец не доставил оплаченный товар и не отвечает.',
  next_question: next, category: 'non_delivery',
}) } }] }));

function fixture(runtime = {}) {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file, directory), 'utf8'));
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
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  async function call(path, body, cookie = '', headers = {}) {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), db, runtime);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const action = (body, cookie, headers) => call('/api/action', body, cookie, headers);
  const login = async role => call('/api/auth/login', { login: role, password: role === 'client' ? 'ClientDemo2026!' : 'BankDemo2026!' });
  const state = async cookie => {
    const result = await call('/api/state', undefined, cookie);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.state;
  };
  const successful = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const create = async (cookie, operationId = 'HISTORY-1', extra = {}) => successful(await action({ action: 'report-create', operationId, ...extra }, cookie));
  const submit = async (cookie, reportId, note = CLAIM) => successful(await action({ action: 'report-submit', reportId, note }, cookie));
  const review = async (cookie, reportId, verdict, comment = 'Учебная проверка обращения сотрудником.') => successful(await action({ action: 'report-review', reportId, verdict, comment }, cookie));
  const pay = async (cookie, recipientId = 'DEMO-NEW-001') => {
    const result = successful(await action({ action: 'confirm', kind: 'transfer', recipientId, amount: 100000, requestId: `complaint-pay-${crypto.randomUUID()}` }, cookie));
    assert.equal(result.operation.status, 'completed'); return result.operation;
  };
  const reportRows = async cookie => (await state(cookie)).fraudReports;
  const registry = async cookie => {
    const result = await call('/api/registry', undefined, cookie);
    assert.equal(result.status, 200); return result.body.entries;
  };
  return { sql, call, action, login, state, successful, create, submit, review, pay, reportRows, registry };
}

test('complaint endpoints enforce authentication, account roles, consent and CSRF', async () => {
  let calls = 0;
  const f = fixture({ GROQ_API_KEY: 'fake', fetcher: async () => { calls++; return modelReply(); } });
  assert.equal((await f.action({ action: 'report-create', operationId: 'HISTORY-1' })).status, 401);
  assert.equal((await f.call('/api/complaints/chat', { reportId: 'fake', message: CLAIM, consent: true, requestId: 'complaint-anon-001' })).status, 401);
  const client = await f.login('client'), staff = await f.login('employee');
  assert.equal((await f.action({ action: 'report-create', operationId: 'HISTORY-1' }, staff.cookie)).status, 403);
  assert.equal((await f.call('/api/complaints/chat', { reportId: 'fake', message: CLAIM, consent: true, requestId: 'complaint-staff-001' }, staff.cookie)).status, 403);
  assert.equal((await f.action({ action: 'report-review', reportId: 'fake', verdict: 'block', comment: 'Проверка сотрудником.' }, client.cookie)).status, 403);
  const csrf = { Origin: 'https://evil.example' };
  assert.equal((await f.action({ action: 'report-create', operationId: 'HISTORY-1' }, client.cookie, csrf)).status, 403);
  const created = await f.create(client.cookie);
  for (const headers of [csrf, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.call('/api/complaints/chat', { reportId: created.reportId, message: CLAIM, consent: true, requestId: 'complaint-csrf-001' }, client.cookie, headers)).status, 403);
  assert.equal((await f.call('/api/complaints/chat', { reportId: created.reportId, message: CLAIM, consent: false, requestId: 'complaint-no-consent' }, client.cookie)).status, 400);
  assert.equal(calls, 0);
});

test('a complaint copies its completed payment and ignores forged recipient, amount and AI verdict', async () => {
  const f = fixture(), client = await f.login('client');
  const before = await f.state(client.cookie);
  const created = await f.create(client.cookie, 'HISTORY-1', { recipientId: 'DEMO-ATTACKER', recipientName: 'FORGED_RECIPIENT', amount: 1, status: 'reviewed', verdict: 'block' });
  assert.ok(created.reportId);
  const report = created.state.fraudReports.find(row => row.id === created.reportId);
  assert.ok(report); assert.equal(report.operationId, 'HISTORY-1'); assert.equal(report.recipientId, 'DEMO-FAMILY-001');
  assert.equal(report.recipientName, 'Мама'); assert.equal(report.amount, 300000);
  assert.equal(report.status, 'draft'); assert.equal(JSON.stringify(report).includes('FORGED_RECIPIENT'), false);
  assert.equal(created.state.balance, before.balance); assert.deepEqual(created.state.operations, before.operations);
  const duplicate = await f.create(client.cookie);
  assert.equal(duplicate.reportId, created.reportId); assert.equal(duplicate.state.fraudReports.length, 1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM registry').get().n, 10);
});

test('unknown, blocked and cash operations cannot be reported as completed recipient payments', async () => {
  const f = fixture(), client = await f.login('client');
  const blocked = f.successful(await f.action({ action: 'confirm', kind: 'transfer', recipientId: 'DEMO-RISK-001', amount: 100000, requestId: 'complaint-blocked-payment' }, client.cookie));
  const cash = f.successful(await f.action({ action: 'confirm', kind: 'cash', amount: 100000, requestId: 'complaint-cash-payment' }, client.cookie));
  assert.equal(cash.operation.status, 'completed');
  for (const operationId of ['not-an-operation', blocked.operation.id, cash.operation.id]) {
    const result = await f.action({ action: 'report-create', operationId }, client.cookie);
    assert.ok([400, 404].includes(result.status), JSON.stringify(result));
  }
  assert.deepEqual(await f.reportRows(client.cookie), []);
});

test('draft complaint is private until the client explicitly submits; manual submission needs no AI', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee');
  const before = await f.state(client.cookie), created = await f.create(client.cookie);
  assert.equal((await f.reportRows(client.cookie)).length, 1); assert.deepEqual(await f.reportRows(staff.cookie), []);
  const sent = await f.submit(client.cookie, created.reportId);
  assert.equal(sent.state.fraudReports.find(row => row.id === created.reportId).status, 'submitted');
  const employeeReports = await f.reportRows(staff.cookie);
  assert.equal(employeeReports.length, 1); assert.match(JSON.stringify(employeeReports[0]), /велосипед/);
  assert.equal((await f.registry(staff.cookie)).length, 10);
  const after = await f.state(client.cookie); assert.equal(after.balance, before.balance); assert.deepEqual(after.operations, before.operations);
});

test('complaint chat saves a redacted Qwen intake without adding any registry mark or sending payment metadata', async () => {
  let packet;
  const f = fixture({ GROQ_API_KEY: 'gsk_fake_test', fetcher: async (_url, init) => { packet = JSON.parse(init.body); return modelReply('Как вы получили ссылку на оплату?'); } });
  const client = await f.login('client'), staff = await f.login('employee'), created = await f.create(client.cookie);
  const before = await f.state(client.cookie);
  const request = { reportId: created.reportId, message: `${CLAIM} Карта 4111111111111111, код 123456.`, consent: true, requestId: 'complaint-chat-first-001', recipientId: 'DEMO-FAKE', verdict: 'block' };
  const result = f.successful(await f.call('/api/complaints/chat', request, client.cookie));
  assert.equal(result.reportId, created.reportId);
  const row = result.state.fraudReports.find(report => report.id === created.reportId);
  assert.equal(row.status, 'draft'); assert.equal(row.turns.length, 1); assert.equal(row.turns[0].status, 'done');
  assert.equal(row.turns[0].response.category, 'non_delivery'); assert.equal(row.turns[0].response.source, 'groq');
  assert.equal(JSON.stringify(row).includes('4111111111111111'), false);
  assert.equal(JSON.stringify(row).includes('123456'), false);
  const content = JSON.parse(packet.messages[1].content);
  assert.deepEqual(Object.keys(content).sort(), ['answers_count', 'dialogue', 'initial_question']);
  for (const secret of ['HISTORY-1', 'DEMO-FAMILY-001', 'Мама', '300000', '4111111111111111', '123456', 'gsk_fake_test']) assert.equal(JSON.stringify(packet).includes(secret), false, secret);
  assert.equal(result.state.balance, before.balance); assert.deepEqual(result.state.operations, before.operations);
  assert.deepEqual(await f.reportRows(staff.cookie), []); assert.equal((await f.registry(staff.cookie)).length, 10);
});

test('provider failure preserves the complaint and allows submission without an AI answer', async () => {
  const f = fixture({ GROQ_API_KEY: 'fake', fetcher: async () => new Response('{}', { status: 429 }) });
  const client = await f.login('client'), staff = await f.login('employee'), created = await f.create(client.cookie);
  const result = await f.call('/api/complaints/chat', { reportId: created.reportId, message: CLAIM, consent: true, requestId: 'complaint-provider-error' }, client.cookie);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = result.body.state.fraudReports.find(report => report.id === created.reportId);
  assert.equal(row.status, 'draft'); assert.equal(row.turns[0].status, 'error'); assert.equal(row.turns[0].message, CLAIM);
  assert.equal((await f.registry(staff.cookie)).length, 10);
  const submitted = await f.submit(client.cookie, created.reportId, 'Прошу рассмотреть обращение без ответа ИИ.');
  assert.equal(submitted.state.fraudReports.find(report => report.id === created.reportId).status, 'submitted');
  assert.equal((await f.reportRows(staff.cookie)).length, 1);
});

test('only a staff-reviewed watch mark changes subsequent payments into policy review', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee');
  const payment = await f.pay(client.cookie), created = await f.create(client.cookie, payment.id);
  await f.submit(client.cookie, created.reportId);
  const ready = f.successful(await f.action({ action: 'attempt', kind: 'transfer', recipientId: payment.recipientId, amount: 100000 }, client.cookie));
  assert.equal(ready.decision.allowed, true);
  await f.review(staff.cookie, created.reportId, 'watch');
  const entries = await f.registry(staff.cookie), entry = entries.find(row => row.recipient_id === payment.recipientId);
  assert.equal(entry.status, 'watch'); assert.equal(entry.source, SOURCE);
  const before = await f.state(client.cookie);
  const result = f.successful(await f.action({ action: 'confirm', kind: 'transfer', recipientId: payment.recipientId, amount: 100000, requestId: 'complaint-watch-confirm' }, client.cookie));
  assert.equal(result.decision.code, 'MODEL_REVIEW'); assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.classification.class, 'review'); assert.equal(result.decision.classification.source, 'policy');
  assert.equal(result.operation.status, 'pending'); assert.equal(result.state.balance, before.balance);
});

test('a block mark stops known recipients; dismissal removes only the complaint-owned mark', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee'), created = await f.create(client.cookie);
  await f.submit(client.cookie, created.reportId); await f.review(staff.cookie, created.reportId, 'block');
  const blocked = f.successful(await f.action({ action: 'attempt', kind: 'transfer', recipientId: 'DEMO-FAMILY-001', amount: 100000 }, client.cookie));
  assert.equal(blocked.decision.known, true); assert.equal(blocked.decision.code, 'RISK_REGISTRY');
  assert.equal(blocked.operation.status, 'blocked');
  await f.review(staff.cookie, created.reportId, 'dismiss');
  assert.equal((await f.registry(staff.cookie)).some(row => row.recipient_id === 'DEMO-FAMILY-001'), false);
  const ready = f.successful(await f.action({ action: 'attempt', kind: 'transfer', recipientId: 'DEMO-FAMILY-001', amount: 100000 }, client.cookie));
  assert.equal(ready.decision.allowed, true);
});

test('complaint dismissal never deletes seed or manually maintained recipient entries', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee');
  const base = (await f.registry(staff.cookie)).find(row => row.recipient_id === 'DEMO-RISK-002');
  const seeded = await f.create(client.cookie, 'HISTORY-3');
  await f.submit(client.cookie, seeded.reportId); await f.review(staff.cookie, seeded.reportId, 'block'); await f.review(staff.cookie, seeded.reportId, 'dismiss');
  assert.deepEqual((await f.registry(staff.cookie)).find(row => row.recipient_id === 'DEMO-RISK-002'), base);
  f.successful(await f.action({ action: 'registry-add', entry: { recipient_id: 'DEMO-FAMILY-001', display_name: 'Учебный получатель', reason: 'Независимое основание сотрудника.' } }, staff.cookie));
  const manual = (await f.registry(staff.cookie)).find(row => row.recipient_id === 'DEMO-FAMILY-001');
  const reported = await f.create(client.cookie);
  await f.submit(client.cookie, reported.reportId); await f.review(staff.cookie, reported.reportId, 'block'); await f.review(staff.cookie, reported.reportId, 'dismiss');
  assert.deepEqual((await f.registry(staff.cookie)).find(row => row.recipient_id === 'DEMO-FAMILY-001'), manual);
});

test('multiple reviewed cases aggregate into one recipient row and duplicate reports cannot inflate it', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee');
  const firstPayment = await f.pay(client.cookie), secondPayment = await f.pay(client.cookie);
  const first = await f.create(client.cookie, firstPayment.id), second = await f.create(client.cookie, secondPayment.id);
  assert.notEqual(first.reportId, second.reportId);
  await f.submit(client.cookie, first.reportId); await f.submit(client.cookie, second.reportId);
  await f.review(staff.cookie, first.reportId, 'watch'); await f.review(staff.cookie, second.reportId, 'block');
  const rows = await f.registry(staff.cookie);
  assert.equal(rows.filter(row => row.recipient_id === firstPayment.recipientId).length, 1);
  assert.equal(rows.find(row => row.recipient_id === firstPayment.recipientId).status, 'active');
  const duplicate = await f.create(client.cookie, firstPayment.id);
  assert.equal(duplicate.reportId, first.reportId); assert.equal(duplicate.state.fraudReports.length, 2);
  await f.review(staff.cookie, second.reportId, 'dismiss');
  assert.equal((await f.registry(staff.cookie)).find(row => row.recipient_id === firstPayment.recipientId).status, 'watch');
  await f.review(staff.cookie, first.reportId, 'dismiss');
  assert.equal((await f.registry(staff.cookie)).some(row => row.recipient_id === firstPayment.recipientId), false);
});

test('staff must see a submitted case and provide a valid verdict and substantive comment', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee'), created = await f.create(client.cookie);
  const draft = await f.action({ action: 'report-review', reportId: created.reportId, verdict: 'block', comment: 'Проверка сотрудником.' }, staff.cookie);
  assert.ok([400, 409].includes(draft.status), JSON.stringify(draft));
  await f.submit(client.cookie, created.reportId);
  for (const value of [{ verdict: 'fraud' }, { verdict: 'watch', comment: 'нет' }]) {
    const result = await f.action({ action: 'report-review', reportId: created.reportId, comment: 'Проверка сотрудником.', ...value }, staff.cookie);
    assert.equal(result.status, 400, JSON.stringify(result));
  }
  assert.equal((await f.registry(staff.cookie)).length, 10);
});

test('duplicate and concurrent chat requests make one model call and return cached state', async () => {
  let calls = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ GROQ_API_KEY: 'fake', fetcher: async () => { calls++; entered(); await gate; return modelReply('Что произошло после оплаты?'); } });
  const client = await f.login('client'), created = await f.create(client.cookie);
  const body = { reportId: created.reportId, message: CLAIM, consent: true, requestId: 'complaint-concurrent-chat' };
  const pending = f.call('/api/complaints/chat', body, client.cookie);
  await started;
  try {
    const duplicate = await f.call('/api/complaints/chat', body, client.cookie);
    assert.equal(duplicate.status, 202, JSON.stringify(duplicate.body)); assert.equal(calls, 1);
    const competing = await f.call('/api/complaints/chat', { ...body, requestId: 'complaint-competing-chat' }, client.cookie);
    assert.ok([400, 409, 429].includes(competing.status), JSON.stringify(competing)); assert.equal(calls, 1);
  } finally { release(); }
  const done = await pending; assert.equal(done.status, 200, JSON.stringify(done.body));
  const cached = await f.call('/api/complaints/chat', body, client.cookie);
  assert.equal(cached.status, 200); assert.equal(calls, 1);
  assert.equal(cached.body.state.fraudReports.find(row => row.id === created.reportId).turns.length, 1);
});

test('withdrawing an in-flight complaint prevents a late model response from reviving it', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ GROQ_API_KEY: 'fake', fetcher: async () => { entered(); await gate; return modelReply(); } });
  const client = await f.login('client'), staff = await f.login('employee'), created = await f.create(client.cookie);
  const pending = f.call('/api/complaints/chat', { reportId: created.reportId, message: CLAIM, consent: true, requestId: 'complaint-withdraw-chat' }, client.cookie);
  await started;
  try {
    // Fresh work cannot be withdrawn while it is in flight. An abandoned,
    // expired reservation may be closed; its eventual response cannot revive it.
    assert.equal((await f.action({ action: 'report-withdraw', reportId: created.reportId }, client.cookie)).status, 400);
    const saved = f.sql.prepare('SELECT * FROM bank_state').get();
    const state = JSON.parse(saved.data);
    state.fraudReports.find(row => row.id === created.reportId).turns[0].startedAt -= 45001;
    f.sql.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(state), saved.id);
    f.successful(await f.action({ action: 'report-withdraw', reportId: created.reportId }, client.cookie));
  }
  finally { release(); }
  const result = await pending;
  assert.ok([200, 409].includes(result.status), JSON.stringify(result));
  const rows = await f.reportRows(client.cookie), row = rows.find(report => report.id === created.reportId);
  assert.ok(!row || row.status === 'withdrawn');
  assert.equal(JSON.stringify(row || {}).includes('По словам клиента'), false);
  assert.deepEqual(await f.reportRows(staff.cookie), []); assert.equal((await f.registry(staff.cookie)).length, 10);
});

test('demo reset clears reports and complaint-generated marks while preserving base registry', async () => {
  const f = fixture(), client = await f.login('client'), staff = await f.login('employee');
  const base = await f.registry(staff.cookie), created = await f.create(client.cookie);
  await f.submit(client.cookie, created.reportId); await f.review(staff.cookie, created.reportId, 'block');
  assert.equal((await f.registry(staff.cookie)).filter(row => row.source === SOURCE).length, 1);
  f.successful(await f.action({ action: 'reset' }, staff.cookie));
  assert.deepEqual(await f.reportRows(client.cookie), []); assert.deepEqual(await f.reportRows(staff.cookie), []);
  assert.deepEqual(await f.registry(staff.cookie), base);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM registry WHERE source = ?').get(SOURCE).n, 0);
});
