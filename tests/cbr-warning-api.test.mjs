import test from 'node:test';
import assert from 'node:assert/strict';
import { bankApi } from '../lib/bank-api.mjs';
import { openDatabase } from '../server/database.mjs';

const NOW = '2026-10-30T10:00:00.000Z';
const report = overrides => ({ status: 'not_listed', domain: 'invest.example', source: { name: 'Банк России', url: 'https://www.cbr.ru/inside/warning-list/' }, checkedAt: NOW, dataFetchedAt: NOW, matches: [], matchCount: 0, message: 'Совпадение не найдено. Это не означает безопасность.', ...overrides });

function fixture(t, runtime = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  async function call(path, body, cookie = '', headers = {}, method) {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), db, runtime);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  const login = role => call('/api/auth/login', { login: role, password: role === 'employee' ? 'BankDemo2026!' : 'ClientDemo2026!' });
  const check = (body, cookie, headers) => call('/api/cbr-warning', body, cookie, headers);
  const all = async (query, ...args) => (await db.prepare(query).bind(...args).all()).results;
  return { db, call, login, check, all };
}

test('CBR lookup requires authentication and same-origin before invoking the service', async t => {
  let calls = 0;
  const f = fixture(t, { cbrWarning: { checkUrl: async () => { calls += 1; return report(); } } });
  assert.equal((await f.check({ url: 'invest.example' })).status, 401);
  const client = await f.login('client');
  assert.equal(client.status, 200);
  assert.equal((await f.check({ url: 'invest.example' }, client.cookie, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.check({ url: 'invest.example' }, client.cookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(calls, 0);
});

test('client and bank employee receive an informational report, not a payment authorization', async t => {
  const submitted = [];
  const expected = report();
  const f = fixture(t, { cbrWarning: { checkUrl: async url => { submitted.push(url); return expected; } } });
  const client = await f.login('client');
  const employee = await f.login('employee');
  for (const cookie of [client.cookie, employee.cookie]) {
    const checked = await f.check({ url: 'invest.example', allowed: true, classification: { class: 'normal' }, recipientId: 'DEMO-FAKE' }, cookie);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.deepEqual(checked.body, { report: expected });
    assert.match(checked.headers.get('cache-control'), /no-store/u);
    assert.equal('allowed' in checked.body.report, false);
    assert.equal('classification' in checked.body.report, false);
  }
  assert.deepEqual(submitted, ['invest.example', 'invest.example']);
});

test('invalid service input is HTTP 400 rather than an unavailable or reassuring lookup', async t => {
  const f = fixture(t, { cbrWarning: { checkUrl: async () => { throw Object.assign(new Error('Введите корректный домен.'), { status: 400, code: 'invalid_url' }); } } });
  const client = await f.login('client');
  const checked = await f.check({ url: 'file:///etc/passwd' }, client.cookie);
  assert.equal(checked.status, 400, JSON.stringify(checked.body));
  assert.equal('report' in checked.body, false);
});

test('missing runtime fails explicitly and upstream unavailable remains an unfinished informational report', async t => {
  const absent = fixture(t);
  const client = await absent.login('client');
  assert.equal((await absent.check({ url: 'invest.example' }, client.cookie)).status, 503);
  const expected = report({ status: 'unavailable', dataFetchedAt: null, message: 'Проверка не завершена.', errorCode: 'timeout' });
  const f = fixture(t, { cbrWarning: { checkUrl: async () => expected } });
  const secondClient = await f.login('client');
  const checked = await f.check({ url: 'invest.example' }, secondClient.cookie);
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(checked.body, { report: expected });
});

test('CBR lookup never mutates bank state, registry, sessions, complaints or persists raw URLs', async t => {
  const privateToken = 'cbr-test-private-query-DO-NOT-PERSIST';
  const url = `https://invest.example/payment?private-token=${privateToken}`;
  const f = fixture(t, { cbrWarning: { checkUrl: async () => report() } });
  const client = await f.login('client');
  const tables = (await f.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'login_limits' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map(row => row.name);
  const snapshot = async () => {
    const result = {};
    for (const table of tables) result[table] = await f.all(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`);
    return result;
  };
  const before = await snapshot();
  const checked = await f.check({ url, verdict: 'block', action: 'registry-add', amount: 1 }, client.cookie);
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(await snapshot(), before);
  assert.equal(JSON.stringify(await f.all('SELECT * FROM login_limits')).includes(privateToken), false);
  assert.equal(JSON.stringify(checked.body).includes(privateToken), false);
});

test('six-request quota is per account, persistent across sessions and never invokes service after limit', async t => {
  let calls = 0;
  const f = fixture(t, { cbrWarning: { checkUrl: async () => { calls += 1; return report(); } } });
  const client = await f.login('client');
  const me = await f.call('/api/auth/me', undefined, client.cookie);
  const userId = me.body.user.id;
  const minute = Math.floor(Date.now() / 60000);
  // Seed adjacent windows too, so the assertion is deterministic at a clock-minute boundary.
  for (const window of [minute - 1, minute, minute + 1]) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cbr-warning:${userId}:${window}`));
    const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    await f.db.prepare('INSERT INTO login_limits (key, attempts, window_start) VALUES (?, 5, ?) ON CONFLICT(key) DO UPDATE SET attempts = 5').bind(key, Date.now()).run();
  }
  assert.equal((await f.check({ url: 'invest.example' }, client.cookie)).status, 200);
  assert.equal(calls, 1);
  const again = await f.login('client');
  assert.equal((await f.check({ url: 'invest.example' }, again.cookie)).status, 429);
  assert.equal(calls, 1);
  const employee = await f.login('employee');
  assert.equal((await f.check({ url: 'invest.example' }, employee.cookie)).status, 200);
  assert.equal(calls, 2);
});

test('GET cannot trigger an external list refresh and wrong media type is rejected', async t => {
  let calls = 0;
  const f = fixture(t, { cbrWarning: { checkUrl: async () => { calls += 1; return report(); } } });
  const client = await f.login('client');
  const get = await f.call('/api/cbr-warning', undefined, client.cookie);
  assert.ok([404, 405].includes(get.status));
  const invalid = await f.check({ url: 'invest.example' }, client.cookie, { 'Content-Type': 'text/plain' });
  assert.equal(invalid.status, 415);
  assert.equal(calls, 0);
});
