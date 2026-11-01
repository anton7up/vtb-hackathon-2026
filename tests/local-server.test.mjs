import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { openDatabase } from '../server/database.mjs';
import { createAppServer, parseOrigin } from '../server/http.mjs';
import { dashboardPage } from '../server/pages.mjs';
import { createInspector } from '../server/scanner/service.mjs';

async function fixture(t, filename = ':memory:', options = {}) {
  const db = openDatabase(filename);
  const server = createAppServer({ db, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    db.close();
  };
  t.after(stop);
  async function call(path, body, cookie = '', headers = {}) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual',
      method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, cookie: response.headers.get('set-cookie')?.split(';')[0],
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  }
  async function login(role) { return call('/api/auth/login', { login: role, password: role === 'client' ? 'ClientDemo2026!' : 'BankDemo2026!' }); }
  return { db, server, origin, call, login, stop };
}

test('standalone HTTP serves login and protected role shells with the existing browser scripts', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/')).headers.get('location'), '/login');
  assert.equal((await f.call('/employee')).headers.get('location'), '/login');
  const loginPage = await f.call('/login');
  assert.equal(loginPage.status, 200); assert.match(loginPage.text, /id="login-form"/);
  assert.match(loginPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const client = await f.login('client'), staff = await f.login('employee');
  assert.equal(client.status, 200); assert.equal(staff.status, 200);
  assert.match(client.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(client.headers.get('set-cookie').includes('; Secure'), false); // Loopback HTTP, not a weakened HTTPS session.
  assert.equal((await f.call('/employee', undefined, client.cookie)).headers.get('location'), '/client');
  assert.equal((await f.call('/client', undefined, staff.cookie)).headers.get('location'), '/employee');
  const clientPage = await f.call('/client', undefined, client.cookie);
  const staffPage = await f.call('/employee', undefined, staff.cookie);
  assert.match(clientPage.text, /src="\/app.mjs"/); assert.doesNotMatch(clientPage.text, /id="demo-reset"/);
  assert.match(staffPage.text, /id="demo-reset"/);
  for (const asset of ['/app.mjs', '/login.mjs', '/review-assistant.mjs', '/site-inspection.mjs', '/shell.css', '/style.css', '/redesign.css', '/shield.svg']) assert.equal((await f.call(asset)).status, 200);
  assert.match((await f.call('/shell.css')).text, /@import '\/style.css'/);
  assert.match((await f.call('/shell.css')).text, /@import '\/redesign.css'/);
  assert.equal((await f.call('/healthz')).body.ok, true);
  assert.doesNotMatch(dashboardPage({ role: 'client', login: '<script>', name: '<img>' }), /<script>|<img>/);
});

test('standalone server preserves API authorization, CSRF checks and private file isolation', async t => {
  const f = await fixture(t), c = await f.login('client');
  assert.equal((await f.call('/api/state')).status, 401);
  assert.equal((await f.call('/api/registry', undefined, c.cookie)).status, 403);
  assert.equal((await f.call('/api/action', { action: 'reset' }, c.cookie)).status, 403);
  assert.equal((await f.call('/api/action', { action: 'recovery' }, c.cookie, { Origin: 'https://evil.example' })).status, 403);
  for (const path of ['/.env', '/data/antiscam.sqlite', '/lib/phishing-model.json', '/package.json', '/server/index.mjs', '/%2e%2e/.env']) assert.equal((await f.call(path)).status, 404);
  const hostile = await new Promise((resolve, reject) => {
    const req = httpRequest(f.origin, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end();
  });
  assert.equal(hostile, 421);
  const tooLarge = await f.call('/api/auth/login', { text: 'x'.repeat(50000) });
  assert.equal(tooLarge.status, 413);
});

test('real URL inference works on local HTTP without Groq and does not modify bank state', async t => {
  const f = await fixture(t), c = await f.login('client');
  const before = (await f.call('/api/state', undefined, c.cookie)).body;
  const checked = await f.call('/api/phishing/check', { url: 'https://bank-login.example/confirm?account=test' }, c.cookie);
  assert.equal(checked.status, 200); assert.equal(checked.body.result.label, 'phishing'); assert.equal(checked.body.result.source, 'ml');
  assert.ok(checked.body.result.phishing_score > 0.99);
  const clean = await f.call('/api/phishing/check', { url: 'https://www.wikipedia.org/' }, c.cookie);
  assert.equal(clean.body.result.label, 'safe');
  const after = (await f.call('/api/state', undefined, c.cookie)).body.state;
  delete before.state.serverNow; delete after.serverNow; // Response clock advances, stored bank state does not.
  assert.deepEqual(after, before.state);
  assert.equal(before.assistant.configured, false);
});

test('SQLite migration is idempotent; transactions roll back fully and reject foreign statements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antiscam-db-test-')), file = join(dir, 'bank.sqlite');
  let db = openDatabase(file);
  const other = openDatabase(':memory:');
  try {
    await assert.rejects(db.batch([
      db.prepare('INSERT INTO login_limits VALUES (?, ?, ?)').bind('rollback', 1, 0),
      db.prepare('INSERT INTO login_limits VALUES (?, ?, ?)').bind('rollback', 2, 0),
    ]));
    assert.equal(await db.prepare('SELECT * FROM login_limits WHERE key = ?').bind('rollback').first(), null);
    await assert.rejects(db.batch([other.prepare('DELETE FROM login_limits')]));
    await db.prepare('INSERT INTO login_limits VALUES (?, ?, ?)').bind('persist', 1, 0).run();
    db.close(); db = openDatabase(file);
    assert.equal((await db.prepare('SELECT * FROM login_limits WHERE key = ?').bind('persist').first()).attempts, 1);
  } finally { db.close(); other.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('bank changes and login session survive a real standalone server restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'antiscam-http-test-')), file = join(dir, 'bank.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await fixture(t, file), c = await first.login('client');
  const changed = await first.call('/api/action', { action: 'phone', phone: '+7 000 000-00-02' }, c.cookie);
  assert.equal(changed.status, 200); assert.equal(changed.body.state.protection.active, true);
  const blocked = await first.call('/api/action', { action: 'attempt', kind: 'transfer', recipientId: 'DEMO-NEW-001', amount: 100000 }, c.cookie);
  assert.equal(blocked.body.decision.code, 'NEW_RECIPIENT_HOLD');
  await first.stop();
  const second = await fixture(t, file);
  const persisted = await second.call('/api/state', undefined, c.cookie);
  assert.equal(persisted.status, 200); assert.equal(persisted.body.state.phone, '+7 000 000-00-02');
  assert.equal(persisted.body.state.balance, changed.body.state.balance); assert.equal(persisted.body.state.operations[0].id, blocked.body.operation.id);
  assert.equal((await second.call('/api/auth/logout', {}, c.cookie)).status, 200);
  assert.equal((await second.call('/api/state', undefined, c.cookie)).status, 401);
  await second.stop();
});

test('configured HTTPS origin produces Secure cookies without trusting spoofed forwarding headers', async t => {
  const f = await fixture(t, ':memory:', { publicOrigin: 'https://bank.example' });
  const c = await f.call('/api/auth/login', { login: 'client', password: 'ClientDemo2026!' }, '', { Origin: 'https://bank.example' });
  assert.equal(c.status, 200); assert.match(c.headers.get('set-cookie'), /; Secure/);
  assert.equal((await f.call('/api/action', { action: 'recovery' }, c.cookie, { Origin: 'http://evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' })).status, 403);
  for (const value of ['https://bank.example/path', 'ftp://bank.example', 'https://user:pass@bank.example', 'https://bank.example/?key=secret']) assert.throws(() => parseOrigin(value));
});

test('concurrent HTTP confirmations use atomic SQLite batches and debit one time', async t => {
  const f = await fixture(t), c = await f.login('client');
  const before = (await f.call('/api/state', undefined, c.cookie)).body.state.balance;
  const body = { action: 'confirm', kind: 'transfer', recipientId: 'DEMO-CLASS-NORMAL', amount: 300000, requestId: 'concurrent-local-confirmation' };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.call('/api/action', body, c.cookie)));
  assert.ok(results.every(r => r.status === 200 || r.status === 409));
  assert.ok(results.some(r => r.status === 200));
  const after = (await f.call('/api/state', undefined, c.cookie)).body.state;
  assert.equal(after.balance, before - 300000);
  assert.equal(after.operations.filter(op => !op.seeded && op.status === 'completed').length, 1);
});

test('HTML scan API requires authentication, same-origin requests and explicit live-page consent', async t => {
  let calls = 0;
  const f = await fixture(t, ':memory:', { runtime: { inspectWebsite: async () => { calls++; return { status: 'unavailable', verdict: null, findings: [] }; } } });
  assert.equal((await f.call('/api/phishing/inspect', { url: 'https://example.com/', consent: true })).status, 401);
  const c = await f.login('client');
  assert.equal((await f.call('/api/state', undefined, c.cookie)).body.websiteInspector.configured, true);
  assert.equal((await f.call('/api/phishing/inspect', { url: 'https://example.com/' }, c.cookie)).status, 400);
  assert.equal((await f.call('/api/phishing/inspect', { url: 'https://user:secret@example.com/', consent: true }, c.cookie)).status, 400);
  assert.equal((await f.call('/api/phishing/inspect', { demoScenario: 'arbitrary-file' }, c.cookie)).status, 400);
  assert.equal((await f.call('/api/phishing/inspect', { url: 'https://example.com/', consent: true }, c.cookie, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await f.call('/api/phishing/inspect', { url: 'https://example.com/', consent: true }, c.cookie)).status, 200);
  assert.equal(calls, 1);
});

test('worker demos and rejected localhost scans are honest reports, visible to both roles without bank writes', async t => {
  const f = await fixture(t, ':memory:', { runtime: { inspectWebsite: createInspector() } });
  const c = await f.login('client'), staff = await f.login('employee');
  const before = (await f.call('/api/state', undefined, c.cookie)).body.state;
  const checked = await f.call('/api/phishing/inspect', { demoScenario: 'brand_clone', url: 'http://localhost/ignore-me' }, c.cookie);
  assert.equal(checked.status, 200); assert.equal(checked.body.report.source, 'demo_fixture'); assert.equal(checked.body.report.verdict, 'high_risk');
  const shop = await f.call('/api/phishing/inspect', { demoScenario: 'shop_clone' }, c.cookie);
  assert.equal(shop.status, 200); assert.equal(shop.body.report.source, 'demo_fixture'); assert.equal(shop.body.report.verdict, 'high_risk');
  assert.equal(shop.body.report.input_url, 'https://ozon-sale.example/checkout');
  assert.equal(shop.body.report.brands.some(b => b.domain_match === false), true);
  assert.deepEqual([...shop.body.report.forms[0].sensitive_fields].sort(), ['card', 'cvv', 'otp']);
  const staffReport = await f.call('/api/phishing/inspect', { demoScenario: 'ordinary_shop' }, staff.cookie);
  assert.equal(staffReport.body.report.verdict, 'no_signals');
  const staffShop = await f.call('/api/phishing/inspect', { demoScenario: 'shop_clone' }, staff.cookie);
  assert.equal(staffShop.status, 200); assert.equal(staffShop.body.report.source, 'demo_fixture'); assert.equal(staffShop.body.report.verdict, 'high_risk');
  const unavailable = await f.call('/api/phishing/inspect', { url: 'http://127.0.0.1:3000/api/state', consent: true }, c.cookie);
  assert.equal(unavailable.body.report.status, 'unavailable'); assert.equal(unavailable.body.report.verdict, null);
  const after = (await f.call('/api/state', undefined, c.cookie)).body.state;
  delete before.serverNow; delete after.serverNow;
  assert.deepEqual(after, before);
  const stored = (await f.db.prepare('SELECT data FROM bank_state').first()).data;
  assert.equal(stored.includes('collector.example'), false); assert.equal(stored.includes('vtb-login.example'), false);
  assert.equal(stored.includes('ozon-sale.example'), false);
});

test('HTML scan API has persistent quota and never silently substitutes URL-only checking', async t => {
  const f = await fixture(t, ':memory:', { runtime: { inspectWebsite: async () => ({ status: 'unavailable', verdict: null, findings: [] }) } });
  const c = await f.login('client');
  for (let i = 0; i < 6; i++) assert.equal((await f.call('/api/phishing/inspect', { demoScenario: 'challenge' }, c.cookie)).status, 200);
  assert.equal((await f.call('/api/phishing/inspect', { demoScenario: 'challenge' }, c.cookie)).status, 429);
  const unconfigured = await fixture(t), u = await unconfigured.login('client');
  assert.equal((await unconfigured.call('/api/phishing/inspect', { demoScenario: 'challenge' }, u.cookie)).status, 503);
});
