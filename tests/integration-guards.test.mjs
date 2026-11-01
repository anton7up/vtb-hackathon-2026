import test from 'node:test';
import assert from 'node:assert/strict';
import { bankApi, passwordHash } from '../lib/bank-api.mjs';
import { openDatabase } from '../server/database.mjs';

// Hold the account snapshot before password hashing. This deterministically
// models an old-password login overtaken by recovery/credential rotation.
function suspendedLoginDatabase(db, targetLogin) {
  let release, captured;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { captured = resolve; });
  const proxy = { ...db, prepare(query) {
    const statement = db.prepare(query);
    if (query !== 'SELECT * FROM accounts WHERE login = ?') return statement;
    return { ...statement, bind(...args) {
      const bound = statement.bind(...args);
      if (args[0] !== targetLogin) return bound;
      return { ...bound, async first() {
        const snapshot = await bound.first(); captured(); await gate; return snapshot;
      } };
    } };
  } };
  return { db: proxy, ready, release };
}

async function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  async function call(path, body, cookie = '', database = db) {
    const response = await bankApi(new Request(`https://antiscam.test${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) }), database);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const login = async (name, password, database = db) => call('/api/auth/login', { login: name, password }, '', database);
  return { db, call, ok, login };
}

test('an old-password login already in flight cannot recreate a session after recovery rotates credentials', async t => {
  const f = await fixture(t);
  const old = await f.login('client', 'ClientDemo2026!'); f.ok(old);
  f.ok(await f.login('client', 'ClientDemo2026!'));
  const staff = await f.login('employee', 'BankDemo2026!'); f.ok(staff);
  const initial = f.ok(await f.call('/api/state', undefined, old.cookie)).state;
  const alert = initial.securityAlerts[0]; assert.ok(alert);
  f.ok(await f.call('/api/action', { action: 'report-security', alertId: alert.id }, old.cookie));
  const requested = f.ok(await f.call('/api/action', { action: 'security-recovery-request', password: 'ClientDemo2026!' }, old.cookie));
  const requestId = requested.state.securityRecovery.request.id;
  f.ok(await f.call('/api/action', { action: 'security-recovery-decide', requestId, verdict: 'approve', comment: 'Все учебные проверки подтверждены по известному каналу.',
    checks: { knownChannel: true, incidentReviewed: true, accessSecured: true } }, staff.cookie));

  const held = suspendedLoginDatabase(f.db, 'client');
  const pending = f.login('client', 'ClientDemo2026!', held.db); await held.ready;
  const newPassword = 'NewIndependentDemoPass2026!';
  const completed = await f.call('/api/action', { action: 'security-recovery-complete', requestId, password: 'ClientDemo2026!', newPassword }, old.cookie);
  f.ok(completed); assert.equal(completed.body.recovery.forceLogin, true);
  held.release();
  const stale = await pending;
  assert.equal(stale.status, 401); assert.equal(stale.cookie, undefined);
  const count = await f.db.prepare("SELECT COUNT(*) AS n FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.login = 'client'").first();
  assert.equal(count.n, 0, 'revocation cannot be undone by a delayed old-password login');
  assert.equal((await f.login('client', 'ClientDemo2026!')).status, 401);
  f.ok(await f.login('client', newPassword));
});

test('employee login also rejects a credential snapshot superseded before session insertion', async t => {
  const f = await fixture(t); f.ok(await f.login('employee', 'BankDemo2026!'));
  const held = suspendedLoginDatabase(f.db, 'employee');
  const pending = f.login('employee', 'BankDemo2026!', held.db); await held.ready;
  const salt = 'new-credential-generation-for-test';
  const hash = await passwordHash('NewEmployeeDemoPass2026!', salt);
  await f.db.prepare("UPDATE accounts SET password_hash = ?, password_salt = ? WHERE login = 'employee'").bind(hash, salt).run();
  const before = (await f.db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n;
  held.release();
  const stale = await pending;
  assert.equal(stale.status, 401); assert.equal(stale.cookie, undefined);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, before);
});
