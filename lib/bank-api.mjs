import { ACCOUNT_SEEDS } from './accounts-seed.mjs';
import seedRegistry from './registry-seed.json' with { type: 'json' };
import { DAY, initialState, timeOf, protectionOf, isKnown, RECIPIENTS, changeAccess, attempt, confirmOperation, openTicket, replyToTicket, addRegistryEntry, securityEvent, reportSecurity } from './bank-engine.mjs';
import { TRANSFER_CLASSES, mockConfig, classifyTransfer, transferFeatures } from './transfer-classifier.mjs';
import { decideReview, confirmReviewed } from './transfer-review.mjs';

const COOKIE = 'antiscam_session';
const CLIENT_ID = 'client-demo';
const SESSION_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
function equalHash(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
function safeUser(row) { return { id: row.id, login: row.login, role: row.role, name: row.name, clientId: row.client_id ?? row.clientId ?? null }; }
const bootstraps = new WeakMap();
async function ensureSeed(db) {
  if (bootstraps.has(db)) return bootstraps.get(db);
  const task = (async () => {
    const stmts = ACCOUNT_SEEDS.map(a => db.prepare('INSERT OR IGNORE INTO accounts (id, login, role, name, client_id, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(a.id, a.login, a.role, a.name, a.clientId, a.hash, a.salt));
    stmts.push(db.prepare('INSERT OR IGNORE INTO bank_state (id, revision, data) VALUES (?, 0, ?)').bind(CLIENT_ID, JSON.stringify(initialState())));
    for (const e of seedRegistry.entries) stmts.push(db.prepare('INSERT OR IGNORE INTO registry (recipient_id, display_name, reason, reason_code, status, source) VALUES (?, ?, ?, ?, ?, ?)').bind(e.recipient_id, e.display_name, e.reason, e.reason_code, e.status, e.source));
    await db.batch(stmts);
  })();
  bootstraps.set(db, task);
  try { await task; } catch (e) { bootstraps.delete(db); throw e; }
}
function cookieToken(request) {
  return (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
}
function cookie(request, value, maxAge = SESSION_MS / 1000) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
async function authenticate(request, db) {
  const token = cookieToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, 'Войдите в аккаунт');
  const row = await db.prepare('SELECT a.*, s.expires_at AS session_expires_at, s.token_hash AS session_hash FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?').bind(await digest(token), Date.now()).first();
  if (!row || !['client', 'employee'].includes(row.role)) throw new ApiError(401, 'Сессия завершена. Войдите снова');
  // Sessions have a fixed eight-hour TTL and are never extended: expiry also records their start.
  return { ...safeUser(row), sessionStartedAt: row.session_expires_at - SESSION_MS, sessionHash: row.session_hash };
}
export async function sessionUser(request, db) {
  await ensureSeed(db);
  return safeUser(await authenticate(request, db));
}
async function bodyOf(request) {
  if (!request.headers.get('Content-Type')?.includes('application/json')) throw new ApiError(415, 'Ожидается JSON');
  const body = await request.text();
  if (body.length > 12000) throw new ApiError(413, 'Запрос слишком большой');
  try { const value = JSON.parse(body); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; } catch { throw new ApiError(400, 'Некорректный запрос'); }
}
async function login(request, db) {
  const body = await bodyOf(request);
  const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
  if (!login || login.length > 80 || typeof body.password !== 'string' || body.password.length > 200) throw new ApiError(400, 'Введите логин и пароль');
  const rateKey = await digest('login:' + (request.headers.get('CF-Connecting-IP') || 'local'));
  const windowStart = Date.now();
  const limit = await db.prepare('SELECT * FROM login_limits WHERE key = ?').bind(rateKey).first();
  if (limit && windowStart - limit.window_start < 60000 && limit.attempts >= 10) throw new ApiError(429, 'Слишком много попыток. Повторите через минуту');
  await db.prepare('INSERT INTO login_limits (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN ? - window_start >= 60000 THEN 1 ELSE attempts + 1 END, window_start = CASE WHEN ? - window_start >= 60000 THEN ? ELSE window_start END').bind(rateKey, windowStart, windowStart, windowStart, windowStart).run();
  const row = await db.prepare('SELECT * FROM accounts WHERE login = ?').bind(login).first();
  const hash = await passwordHash(body.password, row?.password_salt || ACCOUNT_SEEDS[0].salt);
  if (!row || !equalHash(hash, row.password_hash)) throw new ApiError(401, 'Неверный логин или пароль');
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digest(token), startedAt = Date.now();
  if (row.role === 'client') {
    let saved = false;
    for (let retry = 0; retry < 5; retry++) {
      const loaded = await loadState(db, row.client_id);
      if (!loaded.state.securityLock) securityEvent(loaded.state, 'login', startedAt, tokenHash);
      const results = await db.batch([
        db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM bank_state WHERE id = ? AND revision = ?)').bind(tokenHash, row.id, startedAt + SESSION_MS, row.client_id, loaded.revision),
        db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(JSON.stringify(loaded.state), row.client_id, loaded.revision),
      ]);
      if (results[1].meta.changes) { saved = true; break; }
    }
    if (!saved) throw new ApiError(409, 'Повторите вход: данные аккаунта изменились');
  } else await db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').bind(tokenHash, row.id, startedAt + SESSION_MS).run();
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()).run();
  return json({ user: safeUser(row) }, 200, { 'Set-Cookie': cookie(request, token) });
}
async function getRegistry(db) { return (await db.prepare('SELECT * FROM registry WHERE status = ? ORDER BY recipient_id').bind('active').all()).results; }
async function loadState(db, clientId = CLIENT_ID) {
  const row = await db.prepare('SELECT * FROM bank_state WHERE id = ?').bind(clientId).first();
  if (!row) throw new ApiError(404, 'Счёт не найден');
  return { state: JSON.parse(row.data), revision: row.revision, id: clientId };
}
function reportableAlerts(state, user) {
  if (user.role !== 'client' || state.securityLock) return [];
  return (state.securityAlerts || []).filter(a => user.sessionStartedAt < a.createdAt && user.sessionHash !== a.sourceSessionHash);
}
function serialize(state, user, revision) {
  const at = timeOf(state);
  const common = {
    version: state.version, balance: state.balance, phone: state.phone, lastCriticalChange: state.lastCriticalChange,
    changeKind: state.changeKind, serverNow: at, protection: protectionOf(state, at),
    knownRecipientIds: [...new Set(state.operations.filter(op => op.kind === 'transfer' && isKnown(state, op.recipientId, at)).map(op => op.recipientId))],
    operations: state.operations.map(op => user.role === 'employee' ? op : {
      id: op.id, kind: op.kind, recipientId: op.recipientId, recipientName: op.recipientName,
      amount: op.amount, createdAt: op.createdAt, status: op.status, code: op.code, reason: op.reason,
      seeded: op.seeded, holdEndsAt: op.holdEndsAt,
      classification: op.classification ?? null, review: op.review ?? null,
    }),
    tickets: state.tickets, securityLock: state.securityLock || null, revision,
    recipients: RECIPIENTS.map(r => ({ ...r, known: isKnown(state, r.id, at) })),
  };
  if (user.role === 'employee') return { ...common, events: state.events, modelMock: mockConfig(state) };
  return { ...common, securityAlerts: reportableAlerts(state, user).map(({ id, kind, text, at }) => ({ id, kind, text, at })), events: state.events.filter(e => ['phone', 'recovery', 'security-report'].includes(e.type) && e.actor === 'Клиент') };
}
const permissions = {
  client: ['phone', 'recovery', 'attempt', 'confirm', 'ticket', 'report-security', 'confirm-reviewed'],
  employee: ['reply', 'registry-add', 'advance', 'reset', 'model-mode', 'review-transfer'],
};
async function act(request, db, user) {
  const body = await bodyOf(request);
  if (!permissions[user.role].includes(body.action)) throw new ApiError(403, 'Для этого действия недостаточно прав');
  const clientId = user.role === 'client' ? user.clientId : CLIENT_ID;
  const recipientId = typeof body.recipientId === 'string' ? body.recipientId.trim().toUpperCase() : '';
  if (['attempt', 'confirm'].includes(body.action) && body.kind === 'transfer' && !/^DEMO-[A-Z0-9_-]{1,40}$/.test(recipientId)) throw new ApiError(400, 'Используйте демонстрационный ID, начинающийся с DEMO-');
  for (let retry = 0; retry < 5; retry++) {
    const loaded = await loadState(db, clientId);
    let state = loaded.state;
    const at = timeOf(state);
    const statements = [];
    let result = {};
    if (state.securityLock && ['phone', 'recovery'].includes(body.action)) throw new ApiError(423, 'Данные доступа заблокированы после сообщения «Это был не я». Обратитесь в банк.');
    if (body.action === 'phone') {
      if (typeof body.phone !== 'string' || !/^\+?[\d ()-]{10,25}$/.test(body.phone) || body.phone.replace(/\D/g, '').length !== 11 || body.phone.replace(/\D/g, '') === state.phone.replace(/\D/g, '')) throw new ApiError(400, 'Укажите другой номер из 11 цифр');
      changeAccess(state, 'phone', at, body.phone);
    }
    if (body.action === 'recovery') changeAccess(state, 'recovery', at);
    if (['phone', 'recovery'].includes(body.action)) securityEvent(state, body.action, Date.now(), user.sessionHash);
    if (body.action === 'report-security') {
      const alert = (state.securityAlerts || []).find(a => a.id === body.alertId && user.sessionStartedAt < a.createdAt && user.sessionHash !== a.sourceSessionHash);
      if (!alert) throw new ApiError(403, 'Сообщить об этом событии можно только из другой сессии, открытой до события.');
      if (state.securityLock) result.duplicate = true;
      else {
        reportSecurity(state, alert, at);
        // Commit revocation and the persistent operation lock in the same CAS-protected transaction.
        statements.push(db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ? AND EXISTS (SELECT 1 FROM bank_state WHERE id = ? AND revision = ?)').bind(user.id, user.sessionHash, clientId, loaded.revision));
      }
    }
    if (['attempt', 'confirm'].includes(body.action)) {
      const requestData = { kind: body.kind, amount: body.amount, recipientId, recipientName: body.kind === 'cash' ? 'Наличные' : (RECIPIENTS.find(r => r.id === recipientId)?.name || String(body.recipientName || recipientId).slice(0, 80)), requestId: body.requestId };
      if (body.action === 'confirm' && (typeof body.requestId !== 'string' || !/^[\w-]{10,80}$/.test(body.requestId))) throw new ApiError(400, 'Нет корректного подтверждения');
      if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[\w-]{10,80}$/.test(body.requestId))) throw new ApiError(400, 'Нет корректного идентификатора операции');
      if (body.kind === 'transfer') {
        requestData.classification = await classifyTransfer(state, requestData, at);
        requestData.modelFeatures = transferFeatures(state, requestData, at);
      }
      const entries = body.kind === 'cash' ? [] : await getRegistry(db).catch(() => null);
      result = body.action === 'attempt' ? attempt(state, requestData, entries, at) : confirmOperation(state, requestData, entries, at);
      if (['INVALID_KIND', 'INVALID_AMOUNT', 'INVALID_RECIPIENT'].includes(result.decision?.code)) throw new ApiError(400, result.decision.reason);
      result.classification = result.decision.classification ?? requestData.classification ?? null;
    }
    if (body.action === 'model-mode') {
      if (![...TRANSFER_CLASSES, 'unavailable'].includes(body.mode)) throw new ApiError(400, 'Неизвестный демонстрационный режим классификатора');
      state.modelMock = { mode: body.mode, revision: mockConfig(state).revision + 1 };
      state.events.unshift({ id: `EVENT-${state.nextId++}`, at, type: 'model-mode', actor: 'Сотрудник', text: `Заглушка классификатора: ${body.mode}. Это не результат обученной ML-модели.` });
    }
    if (['review-transfer', 'confirm-reviewed'].includes(body.action)) {
      const op = state.operations.find(op => op.id === body.operationId && op.kind === 'transfer');
      if (!op) throw new ApiError(404, 'Перевод не найден');
      const entries = await getRegistry(db).catch(() => null);
      const classification = await classifyTransfer(state, op, at);
      if (body.action === 'review-transfer') result.operation = decideReview(state, op.id, body.verdict, body.comment, entries, classification, at, Date.now(), user.name);
      else result = confirmReviewed(state, op.id, entries, classification, at, Date.now());
    }
    if (body.action === 'ticket') result.ticket = openTicket(state, String(body.operationId), at);
    if (body.action === 'reply') replyToTicket(state, String(body.ticketId), String(body.reply || ''), at);
    if (body.action === 'registry-add') {
      if (!body.entry || typeof body.entry.recipient_id !== 'string' || typeof body.entry.display_name !== 'string' || typeof body.entry.reason !== 'string') throw new ApiError(400, 'Укажите данные получателя');
      addRegistryEntry(state, body.entry, await getRegistry(db), at);
      const e = state.registryAdditions.pop();
      statements.push(db.prepare('INSERT INTO registry (recipient_id, display_name, reason, reason_code, status, source) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bank_state WHERE id = ? AND revision = ?)').bind(e.recipient_id, e.display_name, e.reason, e.reason_code, e.status, e.source, clientId, loaded.revision));
    }
    if (body.action === 'advance') {
      state.offsetMs += DAY;
      state.events.unshift({ id: `EVENT-${state.nextId++}`, at: timeOf(state), type: 'time', actor: 'Сотрудник', text: 'Демо-время перемотано на 24 часа. Остановленные операции не отправлены.' });
    }
    if (body.action === 'reset') {
      state = initialState();
      statements.push(db.prepare('DELETE FROM registry WHERE source = ? AND EXISTS (SELECT 1 FROM bank_state WHERE id = ? AND revision = ?)').bind('synthetic_employee_entry', clientId, loaded.revision));
    }
    if (body.action === 'registry-add') {
      // Distinguish staff-created rows so resetting the demonstration preserves the base registry.
      const e = body.entry;
      statements.push(db.prepare('UPDATE registry SET source = ? WHERE recipient_id = ? AND EXISTS (SELECT 1 FROM bank_state WHERE id = ? AND revision = ?)').bind('synthetic_employee_entry', e.recipient_id.trim().toUpperCase(), clientId, loaded.revision));
    }
    statements.push(db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(JSON.stringify(state), clientId, loaded.revision));
    const saved = await db.batch(statements);
    if (saved[saved.length - 1].meta.changes) {
      const view = serialize(state, user, loaded.revision + 1);
      if (user.role === 'client') {
        if (result.operation) result.operation = view.operations.find(op => op.id === result.operation.id);
        if (result.decision) { delete result.decision.registryReason; delete result.decision.registryCode; }
      }
      return json({ ...result, state: view });
    }
  }
  throw new ApiError(409, 'Операция изменилась в другой сессии. Попробуйте ещё раз');
}
export async function bankApi(request, db) {
  try {
    const url = new URL(request.url);
    if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'Метод не поддерживается');
    if (request.method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new ApiError(403, 'Недопустимый источник запроса');
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'Недопустимый источник запроса');
    }
    await ensureSeed(db);
    if (url.pathname === '/api/auth/login' && request.method === 'POST') return await login(request, db);
    const user = await authenticate(request, db);
    if (url.pathname === '/api/auth/me' && request.method === 'GET') return json({ user: safeUser(user) });
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(cookieToken(request))).run();
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
    }
    if (url.pathname === '/api/state' && request.method === 'GET') {
      const loaded = await loadState(db, user.role === 'client' ? user.clientId : CLIENT_ID);
      return json({ state: serialize(loaded.state, user, loaded.revision) });
    }
    if (url.pathname === '/api/registry' && request.method === 'GET') {
      if (user.role !== 'employee') throw new ApiError(403, 'Реестр доступен только сотруднику банка');
      return json({ entries: await getRegistry(db) });
    }
    if (url.pathname === '/api/action' && request.method === 'POST') return await act(request, db, user);
    throw new ApiError(404, 'Раздел не найден');
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    if (/^Нет |^Выберите |^Укажите |^Такой ID|^ID должен|^Неизвестное/.test(err.message || '')) return json({ error: err.message }, 400);
    console.error('Bank API failure', err.message);
    return json({ error: 'Сервис временно недоступен. Попробуйте позже' }, 503);
  }
}
