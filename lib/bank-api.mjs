import { ACCOUNT_SEEDS } from './accounts-seed.mjs';
import { ensureDemoRecipientHistory } from './demo-class-recipients.mjs';
import seedRegistry from './registry-seed.json' with { type: 'json' };
import { DAY, initialState, timeOf, protectionOf, isKnown, RECIPIENTS, changeAccess, attempt, confirmOperation, openTicket, replyToTicket, addRegistryEntry, securityEvent, reportSecurity, acknowledgeSecurity } from './bank-engine.mjs';
import { TRANSFER_CLASSES, mockConfig, classifyTransfer, transferFeatures } from './transfer-classifier.mjs';
import { decideReview, confirmReviewed } from './transfer-review.mjs';
import { assessConversation, ASSISTANT_MODEL } from './anti-scam-model.mjs';
import { reserveAssistant, finishAssistant } from './assistant-workflow.mjs';
import { assessComplaint } from './complaint-assistant.mjs';
import { createFraudReport, reserveReportTurn, finishReportTurn, submitFraudReport, withdrawFraudReport, reviewFraudReport } from './recipient-reports.mjs';
import { normalizeCheckUrl, checkPhishingUrl, UrlModelError } from './url-phishing-model.mjs';
import { registryRevision, stateGuard, indexReportsStatements, reconcileRecipientStatement, riskSummaries } from './shared-complaints.mjs';
import { resolveQrPayment, qrTransferRequest } from './qr-payment-bridge.mjs';
import { trustedPolicy, trustedStatus, trustedRequests, trustedChangeStatus, configureTrusted, ensureTrustedApproval, cancelTrusted, decideTrusted, rollingTrustedUsage } from './trusted-approval.mjs';
import { confirmTrusted } from './trusted-workflow.mjs';
import { preparePurchaseInput, createPurchaseCheck, putPurchaseCheck, purchaseGate } from './purchase-check.mjs';
import { requestSecurityRecovery, decideSecurityRecovery, completeSecurityRecovery, safeSecurityLock, serializeSecurityRecovery } from './security-recovery.mjs';

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
    for (const account of ACCOUNT_SEEDS.filter(a => a.role === 'client')) {
      const state = initialState();
      if (account.clientId !== CLIENT_ID) state.phone = '+7 000 000-00-03';
      if (account.clientId === 'client-demo-3') state.phone = '+7 000 000-00-04';
      stmts.push(db.prepare('INSERT OR IGNORE INTO bank_state (id, revision, data) VALUES (?, 0, ?)').bind(account.clientId, JSON.stringify(state)));
    }
    for (const e of seedRegistry.entries) stmts.push(db.prepare('INSERT OR IGNORE INTO registry (recipient_id, display_name, reason, reason_code, status, source) VALUES (?, ?, ?, ?, ?, ?)').bind(e.recipient_id, e.display_name, e.reason, e.reason_code, e.status, e.source));
    await db.batch(stmts);
    // Backfill the shared metadata index without modifying existing balances or complaint narratives.
    const saved = (await db.prepare('SELECT id, data FROM bank_state').all()).results;
    const affected = new Map();
    const indexStatements = [];
    for (const row of saved) {
      const state = JSON.parse(row.data);
      indexStatements.push(...indexReportsStatements(db, state, row.id, { sql: '1', args: [] }));
      for (const report of state.fraudReports || []) affected.set(report.recipientId, report.recipientName);
    }
    for (const row of (await db.prepare("SELECT recipient_id, display_name FROM registry WHERE source = 'synthetic_complaint_review'").all()).results) affected.set(row.recipient_id, row.display_name);
    for (const [id, name] of affected) indexStatements.push(reconcileRecipientStatement(db, id, name, { sql: '1', args: [] }));
    if (indexStatements.length) await db.batch(indexStatements);
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
        db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM bank_state WHERE id = ? AND revision = ?) AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND password_hash = ? AND password_salt = ?)').bind(tokenHash, row.id, startedAt + SESSION_MS, row.client_id, loaded.revision, row.id, row.password_hash, row.password_salt),
        db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND password_hash = ? AND password_salt = ?)').bind(JSON.stringify(loaded.state), row.client_id, loaded.revision, row.id, row.password_hash, row.password_salt),
      ]);
      if (results[0].meta.changes && results[1].meta.changes) { saved = true; break; }
      const current = await db.prepare('SELECT password_hash, password_salt FROM accounts WHERE id = ?').bind(row.id).first();
      if (!current || !equalHash(current.password_hash, row.password_hash) || current.password_salt !== row.password_salt) throw new ApiError(401, 'Данные входа изменились. Введите актуальный пароль');
    }
    if (!saved) throw new ApiError(409, 'Повторите вход: данные аккаунта изменились');
  } else {
    const inserted = await db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND password_hash = ? AND password_salt = ?)').bind(tokenHash, row.id, startedAt + SESSION_MS, row.id, row.password_hash, row.password_salt).run();
    if (!inserted.meta.changes) throw new ApiError(401, 'Данные входа изменились. Введите актуальный пароль');
  }
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()).run();
  return json({ user: safeUser(row) }, 200, { 'Set-Cookie': cookie(request, token) });
}
async function getRegistry(db) { return (await db.prepare("SELECT * FROM registry WHERE status IN ('active', 'watch') ORDER BY recipient_id").all()).results; }
function purchaseClassification(state, operation, classification) {
  if (operation.status === 'completed' && operation.id) return classification;
  const gate = purchaseGate(state, operation, Date.now());
  if (!gate) return classification;
  if (!['PURCHASE_REVIEW', 'PURCHASE_CHECK_INCOMPLETE'].includes(gate.code)) throw new ApiError(409, gate.reason);
  // Website signals may add a review, but can never soften an unavailable or blocking model.
  if (!classification || classification.class === 'block') return classification;
  return { ...classification, class: 'review', source: 'policy', model_version: 'purchase-check-v1' };
}
async function clientsOf(db) { return (await db.prepare("SELECT client_id AS id, name FROM accounts WHERE role = 'client' ORDER BY client_id").all()).results; }
async function selectedClient(db, user, requested) {
  if (requested !== undefined && typeof requested !== 'string') throw new ApiError(400, 'Некорректный клиент');
  if (user.role === 'client') {
    if (requested && requested !== user.clientId) throw new ApiError(403, 'Доступен только ваш счёт');
    return user.clientId;
  }
  const id = requested || CLIENT_ID;
  if (!(await clientsOf(db)).some(client => client.id === id)) throw new ApiError(404, 'Клиент не найден');
  return id;
}
async function loadState(db, clientId = CLIENT_ID) {
  const row = await db.prepare('SELECT * FROM bank_state WHERE id = ?').bind(clientId).first();
  if (!row) throw new ApiError(404, 'Счёт не найден');
  return { state: ensureDemoRecipientHistory(JSON.parse(row.data), Date.now()), revision: row.revision, id: clientId };
}
function reportableAlerts(state, user) {
  if (user.role !== 'client' || state.securityLock) return [];
  return (state.securityAlerts || []).filter(a => user.sessionStartedAt < a.createdAt && user.sessionHash !== a.sourceSessionHash);
}
function serialize(state, user, revision) {
  const at = timeOf(state);
  const { asOf: _usageClock, ...usage } = rollingTrustedUsage(state, Date.now());
  const common = {
    version: state.version, balance: state.balance, phone: state.phone, lastCriticalChange: state.lastCriticalChange,
    changeKind: state.changeKind, serverNow: at, protection: protectionOf(state, at),
    knownRecipientIds: [...new Set(state.operations.filter(op => op.kind === 'transfer' && isKnown(state, op.recipientId, at)).map(op => op.recipientId))],
    operations: state.operations.map(op => user.role === 'employee' ? { ...op, trustedStatus: trustedStatus(state, op, Date.now()) } : {
      id: op.id, kind: op.kind, recipientId: op.recipientId, recipientName: op.recipientName,
      amount: op.amount, createdAt: op.createdAt, status: op.status, code: op.code, reason: op.reason,
      seeded: op.seeded, holdEndsAt: op.holdEndsAt,
      classification: op.classification ?? null, review: op.review ?? null,
      aiAssessment: op.aiAssessment ?? null, aiPendingUntil: op.aiPendingUntil ?? null,
      paymentContext: op.paymentContext ?? null, purchaseCheckId: op.purchaseCheckId ?? null,
      guardianApproval: op.guardianApproval ?? null, trustedStatus: trustedStatus(state, op, Date.now()),
    }),
    tickets: state.tickets, securityLock: safeSecurityLock(state.securityLock), securityRecovery: serializeSecurityRecovery(state, user, Date.now()), revision,
    purchaseChecks: state.purchaseChecks || [],
    trustedPolicy: trustedPolicy(state), trustedPolicyChange: state.trustedPolicyChange ? { ...state.trustedPolicyChange, status: trustedChangeStatus(state, Date.now()) } : null,
    trustedUsage: usage,
    aiConversations: state.aiConversations || [],
    fraudReports: (state.fraudReports || []).filter(r => user.role === 'client' || !['draft', 'withdrawn'].includes(r.status)),
    recipients: RECIPIENTS.map(r => ({ ...r, known: isKnown(state, r.id, at) })),
  };
  if (user.role === 'employee') return { ...common, events: state.events, modelMock: mockConfig(state) };
  return { ...common, securityAlerts: reportableAlerts(state, user).map(({ id, kind, text, at }) => ({ id, kind, text, at })), events: state.events.filter(e => ['phone', 'recovery', 'security-report'].includes(e.type) && e.actor === 'Клиент') };
}
async function serializeView(db, state, user, revision, clientId) {
  const globalRevision = await registryRevision(db);
  const client = (await clientsOf(db)).find(row => row.id === clientId);
  const summary = await riskSummaries(db);
  // Clients see only aggregate reviewed signals, never another customer's identity, note or dialogue.
  const visible = user.role === 'employee' ? summary : summary.filter(row => row.watchCount + row.blockCount > 0).map(row => ({
    recipientId: row.recipientId, status: row.status, reviewedCount: row.watchCount + row.blockCount,
    source: 'reviewed_complaints',
  }));
  const inbox = user.role === 'client' ? await trustedInbox(db, user) : [];
  const view = serialize(state, user, revision);
  return { ...view, clientId, client, registryRevision: globalRevision, recipientRiskSummary: visible,
    trustedInbox: inbox, trustedInboxRevision: await digest(JSON.stringify(inbox)),
    trustedRevision: await digest(JSON.stringify([view.operations.filter(op => op.guardianApproval).map(op => [op.id, op.trustedStatus]),
      view.trustedPolicyChange?.status, view.securityRecovery?.status, view.trustedUsage?.amount,
      view.purchaseChecks.map(report => [report.id, report.expiresAt <= Date.now()])])) };
}
async function trustedInbox(db, user) {
  const owners = (await db.prepare("SELECT a.client_id AS id, a.name, s.data FROM accounts a JOIN bank_state s ON s.id = a.client_id WHERE a.role = 'client' AND a.client_id <> ?").bind(user.clientId).all()).results;
  return owners.flatMap(owner => trustedRequests(JSON.parse(owner.data), owner, user.clientId, Date.now()))
    .sort((a, b) => Number(b.status === 'pending' && !b.myVerdict) - Number(a.status === 'pending' && !a.myVerdict) || b.createdAt - a.createdAt).slice(0, 100);
}
async function reauthenticate(db, user, body) {
  if (typeof body.password !== 'string' || body.password.length > 200) throw new ApiError(400, 'Подтвердите настройку паролем аккаунта');
  const key = await digest(`sensitive-password:${user.id}:${Math.floor(Date.now() / 60000)}`);
  await db.prepare('INSERT INTO login_limits (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').bind(key, Date.now()).run();
  if ((await db.prepare('SELECT attempts FROM login_limits WHERE key = ?').bind(key).first()).attempts > 6) throw new ApiError(429, 'Слишком много подтверждений пароля. Повторите через минуту.');
  const account = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(user.id).first();
  if (!account || !equalHash(await passwordHash(body.password, account.password_salt), account.password_hash)) throw new ApiError(403, 'Неверный пароль подтверждения');
}
async function trustedSettingsInput(db, user, body) {
  await reauthenticate(db, user, body);
  if (!Array.isArray(body.guardianLogins) || body.guardianLogins.length > 5 || body.guardianLogins.some(value => typeof value !== 'string' || value.length > 80)) throw new ApiError(400, 'Укажите не более пяти логинов доверенных лиц');
  const logins = body.guardianLogins.map(value => value.trim().toLowerCase());
  if (new Set(logins).size !== logins.length) throw new ApiError(400, 'Логины доверенных лиц не должны повторяться');
  const guardians = [];
  for (const login of logins) {
    const row = await db.prepare("SELECT client_id, login, name FROM accounts WHERE role = 'client' AND login = ?").bind(login).first();
    if (!row || row.client_id === user.clientId) throw new ApiError(400, 'Укажите логины других действующих клиентов. Себя и сотрудника выбрать нельзя.');
    guardians.push({ id: row.client_id, login: row.login, name: row.name });
  }
  return guardians;
}
async function trustedDecision(request, db, user) {
  if (user.role !== 'client') throw new ApiError(403, 'Подтверждение доступно только доверенному клиенту');
  const body = await bodyOf(request);
  if (typeof body.ownerClientId !== 'string' || body.ownerClientId === user.clientId || typeof body.requestId !== 'string') throw new ApiError(403, 'Запрос недоступен');
  for (let retry = 0; retry < 5; retry++) {
    let loaded;
    try { loaded = await loadState(db, body.ownerClientId); } catch { throw new ApiError(403, 'Запрос недоступен'); }
    let result;
    try { result = decideTrusted(loaded.state, body, user.clientId, Date.now(), timeOf(loaded.state)); }
    catch (error) { throw new ApiError(error.status || 409, error.message); }
    const saved = await db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(JSON.stringify(loaded.state), loaded.id, loaded.revision).run();
    if (saved.meta.changes) return json({ ok: true, ...result });
  }
  throw new ApiError(409, 'Запрос изменился. Обновите список подтверждений.');
}
const permissions = {
  client: ['phone', 'recovery', 'attempt', 'confirm', 'ticket', 'report-security', 'acknowledge-security', 'confirm-reviewed', 'report-create', 'report-submit', 'report-withdraw', 'trusted-policy', 'trusted-cancel', 'confirm-trusted', 'security-recovery-request', 'security-recovery-complete'],
  employee: ['reply', 'registry-add', 'advance', 'reset', 'model-mode', 'review-transfer', 'report-review', 'security-recovery-decide'],
};
async function act(request, db, user, runtime) {
  const body = await bodyOf(request);
  if (!permissions[user.role].includes(body.action)) throw new ApiError(403, 'Для этого действия недостаточно прав');
  const clientId = await selectedClient(db, user, body.clientId);
  const guardians = body.action === 'trusted-policy' ? await trustedSettingsInput(db, user, body) : null;
  if (['security-recovery-request', 'security-recovery-complete'].includes(body.action)) await reauthenticate(db, user, body);
  let recoveryPassword;
  if (body.action === 'security-recovery-complete') {
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 200 || body.newPassword === body.password) throw new ApiError(400, 'Укажите новый пароль от 12 символов, отличный от прежнего');
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    recoveryPassword = { salt, hash: await passwordHash(body.newPassword, salt) };
  }
  let qrRequest = null;
  if (['attempt', 'confirm'].includes(body.action) && (Object.hasOwn(body, 'qrPayload') || Object.hasOwn(body, 'qrFixtureId'))) {
    try { qrRequest = qrTransferRequest(body.qrPayload, body.qrFixtureId); }
    catch (error) { throw new ApiError(400, error.message); }
    Object.assign(body, qrRequest);
  }
  const recipientId = typeof body.recipientId === 'string' ? body.recipientId.trim().toUpperCase() : '';
  if (['attempt', 'confirm'].includes(body.action) && body.kind === 'transfer' && !/^DEMO-[A-Z0-9_-]{1,40}$/.test(recipientId)) throw new ApiError(400, 'Используйте демонстрационный ID, начинающийся с DEMO-');
  for (let retry = 0; retry < 5; retry++) {
    // A CAS retry must not revive a session revoked by a concurrent security action.
    await authenticate(request, db);
    const loaded = await loadState(db, clientId);
    const globalRevision = await registryRevision(db);
    const guard = stateGuard(clientId, loaded.revision, globalRevision);
    let state = loaded.state;
    const affectedRecipients = new Map((state.fraudReports || []).map(r => [r.recipientId, r.recipientName]));
    const at = timeOf(state);
    const statements = [];
    let result = {};
    if (body.action === 'trusted-policy') result.trusted = configureTrusted(state, body, guardians, Date.now(), at);
    if (body.action === 'trusted-cancel') cancelTrusted(state, body, at);
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
        state.securityLock.reporterSessionHash = user.sessionHash;
        // Commit revocation and the persistent operation lock in the same CAS-protected transaction.
        statements.push(db.prepare(`DELETE FROM sessions WHERE account_id = ? AND token_hash <> ? AND ${guard.sql}`).bind(user.id, user.sessionHash, ...guard.args));
      }
    }
    if (body.action === 'acknowledge-security') {
      const alert = (state.securityAlerts || []).find(a => a.id === body.alertId && user.sessionStartedAt < a.createdAt && user.sessionHash !== a.sourceSessionHash);
      if (!alert || state.securityLock) throw new ApiError(403, 'Подтвердить событие можно только из старой сессии до отправки тревоги.');
      acknowledgeSecurity(state, alert, at);
    }
    if (body.action === 'security-recovery-request') result.recovery = requestSecurityRecovery(state, user.sessionHash, Date.now(), at);
    if (body.action === 'security-recovery-decide') result.recovery = decideSecurityRecovery(state, body, { id: user.id, name: user.name }, Date.now(), at);
    if (body.action === 'security-recovery-complete') {
      result.recovery = completeSecurityRecovery(state, body, user.sessionHash, Date.now(), at);
      statements.push(db.prepare(`UPDATE accounts SET password_hash = ?, password_salt = ? WHERE id = ? AND ${guard.sql}`).bind(recoveryPassword.hash, recoveryPassword.salt, user.id, ...guard.args));
      statements.push(db.prepare(`DELETE FROM sessions WHERE account_id = ? AND ${guard.sql}`).bind(user.id, ...guard.args));
    }
    if (['attempt', 'confirm'].includes(body.action)) {
      const requestData = { kind: body.kind, amount: body.amount, recipientId, recipientName: body.kind === 'cash' ? 'Наличные' : (RECIPIENTS.find(r => r.id === recipientId)?.name || String(body.recipientName || recipientId).slice(0, 80)), requestId: body.requestId };
      if (body.purchaseCheckId !== undefined) {
        if (typeof body.purchaseCheckId !== 'string' || !body.purchaseCheckId || body.purchaseCheckId.length > 80) throw new ApiError(400, 'Некорректная проверка покупки');
        if (body.kind !== 'transfer') throw new ApiError(409, 'Проверка покупки относится к переводу, а не к снятию наличных');
        requestData.purchaseCheckId = body.purchaseCheckId;
      }
      if (body.action === 'confirm' && (typeof body.requestId !== 'string' || !/^[\w-]{10,80}$/.test(body.requestId))) throw new ApiError(400, 'Нет корректного подтверждения');
      if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[\w-]{10,80}$/.test(body.requestId))) throw new ApiError(400, 'Нет корректного идентификатора операции');
      const previous = body.requestId && state.operations.find(op => op.requestId === body.requestId);
      if (previous && (previous.purchaseCheckId || requestData.purchaseCheckId) && previous.purchaseCheckId !== requestData.purchaseCheckId) throw new ApiError(409, 'Подтверждение уже относится к другой проверке покупки');
      if (previous && (qrRequest || previous.paymentContext) && (!qrRequest ||
          previous.paymentContext?.fixtureId !== qrRequest.paymentContext.fixtureId || previous.kind !== requestData.kind ||
          previous.recipientId !== requestData.recipientId || previous.amount !== requestData.amount)) {
        throw new ApiError(409, 'Идентификатор уже принадлежит другому платежу. Повторите проверку QR.');
      }
      if (body.kind === 'transfer') {
        requestData.classification = await classifyTransfer(state, requestData, at, runtime, clientId);
        if (previous?.status !== 'completed') requestData.classification = purchaseClassification(state, requestData, requestData.classification);
        requestData.modelFeatures = transferFeatures(state, requestData, at);
      }
      const entries = body.kind === 'cash' ? [] : await getRegistry(db).catch(() => null);
      result = body.action === 'attempt' ? attempt(state, requestData, entries, at) : confirmOperation(state, requestData, entries, at);
      if (qrRequest && result.operation && !result.duplicate) result.operation.paymentContext = qrRequest.paymentContext;
      if (requestData.purchaseCheckId && result.operation && !result.duplicate) result.operation.purchaseCheckId = requestData.purchaseCheckId;
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
      const classification = purchaseClassification(state, op, await classifyTransfer(state, op, at, runtime, clientId));
      ensureTrustedApproval(state, op, Date.now());
      if (body.action === 'review-transfer') result.operation = decideReview(state, op.id, body.verdict, body.comment, entries, classification, at, Date.now(), user.name);
      else result = confirmReviewed(state, op.id, entries, classification, at, Date.now());
    }
    if (body.action === 'confirm-trusted') {
      const op = state.operations.find(item => item.id === body.operationId && item.guardianApproval);
      if (!op) throw new ApiError(404, 'Операция не найдена');
      const entries = op.kind === 'cash' ? [] : await getRegistry(db).catch(() => null);
      const classification = op.kind === 'transfer' ? purchaseClassification(state, op, await classifyTransfer(state, op, at, runtime, clientId)) : null;
      result = op.review ? confirmReviewed(state, op.id, entries, classification, at, Date.now()) : confirmTrusted(state, op.id, entries, classification, at, Date.now());
    }
    if (body.action === 'ticket') result.ticket = openTicket(state, String(body.operationId), at);
    if (body.action === 'reply') replyToTicket(state, String(body.ticketId), String(body.reply || ''), at);
    if (body.action === 'report-create') result.reportId = createFraudReport(state, body.operationId, at).id;
    if (body.action === 'report-submit') result.reportId = submitFraudReport(state, body.reportId, body.note, at).id;
    if (body.action === 'report-withdraw') result.reportId = withdrawFraudReport(state, body.reportId, at).id;
    if (body.action === 'report-review') {
      const report = reviewFraudReport(state, body.reportId, body.verdict, body.comment, at, user.name);
      result.reportId = report.id;
    }
    if (body.action === 'registry-add') {
      if (!body.entry || typeof body.entry.recipient_id !== 'string' || typeof body.entry.display_name !== 'string' || typeof body.entry.reason !== 'string') throw new ApiError(400, 'Укажите данные получателя');
      addRegistryEntry(state, body.entry, await getRegistry(db), at);
      const e = state.registryAdditions.pop();
      statements.push(db.prepare(`INSERT INTO registry (recipient_id, display_name, reason, reason_code, status, source) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql} ON CONFLICT(recipient_id) DO UPDATE SET display_name = excluded.display_name, reason = excluded.reason, reason_code = excluded.reason_code, status = excluded.status, source = excluded.source WHERE registry.status = 'inactive'`).bind(e.recipient_id, e.display_name, e.reason, e.reason_code, e.status, e.source, ...guard.args));
    }
    if (body.action === 'advance') {
      state.offsetMs += DAY;
      state.events.unshift({ id: `EVENT-${state.nextId++}`, at: timeOf(state), type: 'time', actor: 'Сотрудник', text: 'Демо-время перемотано на 24 часа. Остановленные операции не отправлены.' });
    }
    if (body.action === 'reset') {
      if (state.securityLock) throw new ApiError(423, 'Во время тревоги сброс недоступен. Используйте отдельный сценарий восстановления доступа.');
      const savedTrustedPolicy = state.trustedPolicy;
      const recentDebits = [...(state.trustedDebitHistory || []), ...state.operations].filter(op => !op.seeded && op.status === 'completed' && op.actualCompletedAt > Date.now() - DAY)
        .map(({ id, kind, amount, status, actualCompletedAt }) => ({ id, kind, amount, status, actualCompletedAt }));
      state = initialState();
      if (savedTrustedPolicy) state.trustedPolicy = savedTrustedPolicy;
      state.trustedDebitHistory = recentDebits;
      if (clientId !== CLIENT_ID) state.phone = '+7 000 000-00-03';
      if (clientId === 'client-demo-3') state.phone = '+7 000 000-00-04';
      // Shared manual entries survive a per-client reset. Other clients' complaints do too.
    }
    if (body.action === 'registry-add') {
      // Distinguish staff-created rows so resetting the demonstration preserves the base registry.
      const e = body.entry;
      statements.push(db.prepare(`UPDATE registry SET source = ? WHERE recipient_id = ? AND ${guard.sql}`).bind('synthetic_employee_entry', e.recipient_id.trim().toUpperCase(), ...guard.args));
    }
    const updateShared = ['report-submit', 'report-withdraw', 'report-review', 'reset'].includes(body.action);
    if (updateShared) {
      statements.push(...indexReportsStatements(db, state, clientId, guard));
      for (const report of state.fraudReports || []) affectedRecipients.set(report.recipientId, report.recipientName);
      for (const [id, name] of affectedRecipients) statements.push(reconcileRecipientStatement(db, id, name, guard));
      if (body.action === 'reset') for (const id of affectedRecipients.keys()) {
        statements.push(db.prepare(`DELETE FROM registry WHERE recipient_id = ? AND source = 'synthetic_complaint_review' AND status = 'inactive' AND ${guard.sql}`).bind(id, ...guard.args));
      }
    }
    const updateRegistryVersion = updateShared || body.action === 'registry-add';
    if (updateRegistryVersion) statements.push(db.prepare(`UPDATE registry_version SET revision = revision + 1 WHERE id = 'global' AND ${guard.sql}`).bind(...guard.args));
    statements.push(db.prepare("UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM registry_version WHERE id = 'global' AND revision = ?)").bind(JSON.stringify(state), clientId, loaded.revision, globalRevision + (updateRegistryVersion ? 1 : 0)));
    const saved = await db.batch(statements);
    if (saved[saved.length - 1].meta.changes) {
      if (result.recovery?.forceLogin) return json({ recovery: { forceLogin: true } }, 200, { 'Set-Cookie': cookie(request, '', 0) });
      const view = await serializeView(db, state, user, loaded.revision + 1, clientId);
      if (user.role === 'client') {
        if (result.operation) result.operation = view.operations.find(op => op.id === result.operation.id);
        if (result.decision) { delete result.decision.registryReason; delete result.decision.registryCode; }
      }
      return json({ ...result, state: view });
    }
  }
  throw new ApiError(409, 'Операция изменилась в другой сессии. Попробуйте ещё раз');
}
async function consumeAiQuota(db, user) {
  // Shared across both assistants/sessions; retries with the same ID are cached.
  for (const [suffix, limit] of [[`minute:${Math.floor(Date.now() / 60000)}`, 4], [`day:${new Date().toISOString().slice(0, 10)}`, 60]]) {
    const key = await digest(`assistant:${user.clientId}:${suffix}`);
    await db.prepare('INSERT INTO login_limits (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').bind(key, Date.now()).run();
    const counter = await db.prepare('SELECT attempts FROM login_limits WHERE key = ?').bind(key).first();
    if (counter.attempts > limit) throw { code: 'quota' };
  }
}
async function complaintChat(request, db, user, runtime) {
  if (user.role !== 'client') throw new ApiError(403, 'Опрос доступен только клиенту по собственной жалобе.');
  const body = await bodyOf(request);
  let reserved;
  for (let retry = 0; retry < 5; retry++) {
    const loaded = await loadState(db, user.clientId);
    reserved = reserveReportTurn(loaded.state, body, timeOf(loaded.state), Date.now());
    if (reserved.cached) return json({ reportId: reserved.report.id, state: await serializeView(db, loaded.state, user, loaded.revision, loaded.id) }, reserved.turn.status === 'processing' ? 202 : 200);
    const saved = await db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(JSON.stringify(loaded.state), loaded.id, loaded.revision).run();
    if (saved.meta.changes) break;
    reserved = null;
  }
  if (!reserved) throw new ApiError(409, 'Жалоба изменилась. Повторите запрос.');
  let assessment = null, errorCode;
  try {
    if (!runtime.GROQ_API_KEY) throw { code: 'not_configured' };
    await consumeAiQuota(db, user);
    assessment = await assessComplaint(reserved.report, runtime);
  } catch (error) { errorCode = ['quota', 'timeout', 'invalid_response', 'not_configured'].includes(error?.code) ? error.code : 'unavailable'; }
  for (let retry = 0; retry < 5; retry++) {
    const loaded = await loadState(db, user.clientId);
    const report = finishReportTurn(loaded.state, reserved.report.id, body.requestId, assessment, errorCode, timeOf(loaded.state));
    if (!report) throw new ApiError(409, 'Жалоба уже закрыта или демонстрация сброшена. Обновите страницу.');
    const saved = await db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(JSON.stringify(loaded.state), loaded.id, loaded.revision).run();
    if (saved.meta.changes) return json({ reportId: report.id, state: await serializeView(db, loaded.state, user, loaded.revision + 1, loaded.id) });
  }
  throw new ApiError(409, 'Не удалось сохранить ответ. Повторите запрос с тем же идентификатором.');
}
async function assistantChat(request, db, user, runtime) {
  if (user.role !== 'client') throw new ApiError(403, 'Диалог доступен только клиенту. Сотрудник видит результаты в своём кабинете.');
  if (!runtime.GROQ_API_KEY) throw new ApiError(503, 'ИИ-помощник пока не настроен. Обратитесь к сотруднику.');
  const body = await bodyOf(request);
  let reserved;
  for (let retry = 0; retry < 5; retry++) {
    const loaded = await loadState(db, user.clientId);
    reserved = reserveAssistant(loaded.state, body, timeOf(loaded.state), Date.now());
    if (reserved.cached) return json({ conversationId: reserved.conversation.id, state: await serializeView(db, loaded.state, user, loaded.revision, loaded.id) }, reserved.turn.status === 'processing' ? 202 : 200);
    const saved = await db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(JSON.stringify(loaded.state), loaded.id, loaded.revision).run();
    if (saved.meta.changes) break;
    reserved = null;
  }
  if (!reserved) throw new ApiError(409, 'Данные изменились. Попробуйте снова.');
  let assessment = null, errorCode;
  try {
    // Persistent limits apply across sessions. Increment once per reserved turn, not per CAS retry.
    await consumeAiQuota(db, user);
    assessment = await assessConversation(reserved.conversation, runtime);
  } catch (err) { errorCode = ['quota', 'timeout', 'invalid_response', 'not_configured'].includes(err?.code) ? err.code : 'unavailable'; }
  for (let retry = 0; retry < 5; retry++) {
    const loaded = await loadState(db, user.clientId);
    const conversation = finishAssistant(loaded.state, reserved.conversation.id, body.requestId, assessment, errorCode, timeOf(loaded.state));
    if (!conversation) throw new ApiError(409, 'Демонстрация была сброшена. Начните новый диалог.');
    const saved = await db.prepare('UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(JSON.stringify(loaded.state), loaded.id, loaded.revision).run();
    if (saved.meta.changes) return json({ conversationId: conversation.id, state: await serializeView(db, loaded.state, user, loaded.revision + 1, loaded.id) });
  }
  throw new ApiError(409, 'Не удалось сохранить ответ. Обновите страницу: повторная отправка с тем же идентификатором не вызывает модель снова.');
}
async function checkWebsiteUrl(request, db, user) {
  const body = await bodyOf(request);
  let text;
  try { text = normalizeCheckUrl(body.url); }
  catch (err) {
    if (err instanceof UrlModelError && err.code === 'invalid_url') throw new ApiError(400, 'Укажите полную ссылку http:// или https:// без логина, пароля и пробелов внутри. Максимум 2048 символов.');
    throw err;
  }
  // No submitted URLs are persisted. Only an opaque per-account minute counter.
  const key = await digest(`url-check:${user.id}:${Math.floor(Date.now() / 60000)}`);
  await db.prepare('INSERT INTO login_limits (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').bind(key, Date.now()).run();
  const counter = await db.prepare('SELECT attempts FROM login_limits WHERE key = ?').bind(key).first();
  if (counter.attempts > 30) throw new ApiError(429, 'Достигнут лимит проверок ссылок. Подождите минуту.');
  try { return json({ result: checkPhishingUrl(text) }); }
  catch {
    console.error('URL phishing inference unavailable'); // No URLs, tokens or user messages in logs.
    throw new ApiError(503, 'Не удалось проверить ссылку. Это не означает, что сайт безопасен. Повторите проверку позже.');
  }
}

async function inspectWebsite(request, db, user, runtime) {
  if (typeof runtime.inspectWebsite !== 'function') throw new ApiError(503, 'Проверка HTML недоступна в этом запуске. Перезапустите локальный сервер новой версии.');
  const body = await bodyOf(request);
  const demos = ['brand_clone', 'shop_clone', 'ordinary_shop', 'challenge'];
  const demo = body.demoScenario;
  if (demo !== undefined && !demos.includes(demo)) throw new ApiError(400, 'Неизвестный демонстрационный пример');
  let url;
  if (!demo) {
    try { url = normalizeCheckUrl(body.url); } catch { throw new ApiError(400, 'Укажите полную ссылку http:// или https:// без логина и пароля.'); }
    if (body.consent !== true) throw new ApiError(400, 'Подтвердите загрузку публичной страницы: проверяемый сайт увидит сетевой адрес сканера.');
  }
  const key = await digest(`page-check:${user.id}:${Math.floor(Date.now() / 60000)}`);
  await db.prepare('INSERT INTO login_limits (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').bind(key, Date.now()).run();
  const counter = await db.prepare('SELECT attempts FROM login_limits WHERE key = ?').bind(key).first();
  if (counter.attempts > 6) throw new ApiError(429, 'Лимит — 6 подробных проверок в минуту на аккаунт. Подождите минуту.');
  let report;
  try { report = await runtime.inspectWebsite({ url, demoScenario: demo }); }
  catch (error) { throw new ApiError(error.code === 'busy' ? 429 : 503, error.code === 'busy' ? 'Сканер занят. Повторите через несколько секунд.' : 'Сканер не завершил проверку. Это не означает, что сайт безопасен.'); }
  if (!report || !['completed', 'unavailable'].includes(report.status) || !Array.isArray(report.findings)) throw new ApiError(503, 'Сканер вернул некорректный ответ. Проверка не завершена.');
  // No submitted URLs, downloaded HTML or reports are stored in bank state or DB.
  return json({ report });
}

async function resolveBankQr(request, db, user) {
  const body = await bodyOf(request);
  if (typeof body.payload !== 'string' || body.payload.length > 4096) throw new ApiError(400, 'Укажите текст QR длиной до 4096 символов');
  const entries = await getRegistry(db).catch(() => null);
  const report = resolveQrPayment(body.payload, entries);
  if (report.supported) {
    const summary = (await riskSummaries(db)).find(row => row.recipientId === report.recipient.id);
    return json({ payment: resolveQrPayment(body.payload, entries, { reviewedComplaintCount: (summary?.watchCount || 0) + (summary?.blockCount || 0) }) });
  }
  return json({ payment: report });
}
async function checkCbrWarning(request, db, user, runtime) {
  const body = await bodyOf(request);
  if (typeof body.url !== 'string' || !body.url.trim() || body.url.length > 4096) throw new ApiError(400, 'Укажите домен или ссылку длиной до 4096 символов');
  if (typeof runtime.cbrWarning?.checkUrl !== 'function') throw new ApiError(503, 'Проверка списка ЦБ недоступна в этом запуске');
  const key = await digest(`cbr-warning:${user.id}:${Math.floor(Date.now() / 60000)}`);
  await db.prepare('INSERT INTO login_limits (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').bind(key, Date.now()).run();
  if ((await db.prepare('SELECT attempts FROM login_limits WHERE key = ?').bind(key).first()).attempts > 6) throw new ApiError(429, 'Лимит — 6 проверок списка ЦБ в минуту. Подождите минуту.');
  try { return json({ report: await runtime.cbrWarning.checkUrl(body.url) }); }
  catch (error) {
    if (error?.code === 'invalid_url') throw new ApiError(400, error.message);
    throw new ApiError(503, 'Не удалось проверить список ЦБ. Это не означает безопасность сайта.');
  }
}

async function checkPurchase(request, db, user, runtime) {
  if (user.role !== 'client') throw new ApiError(403, 'Проверка покупки привязывается только к вашему счёту');
  const body = await bodyOf(request);
  let input;
  try { input = preparePurchaseInput(body, RECIPIENTS); }
  catch (error) { throw new ApiError(400, error.message); }
  const key = await digest(`purchase-check:${user.id}:${Math.floor(Date.now() / 60000)}`);
  await db.prepare('INSERT INTO login_limits (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').bind(key, Date.now()).run();
  if ((await db.prepare('SELECT attempts FROM login_limits WHERE key = ?').bind(key).first()).attempts > 6) throw new ApiError(429, 'Лимит — 6 проверок покупки в минуту. Подождите минуту.');
  const unavailable = { status: 'unavailable', findings: [] };
  const [scan, cbr] = await Promise.all([
    typeof runtime.inspectWebsite === 'function' ? runtime.inspectWebsite({ url: input.url, demoScenario: input.demoScenario }).catch(() => unavailable) : unavailable,
    !input.demoScenario && typeof runtime.cbrWarning?.checkUrl === 'function' ? runtime.cbrWarning.checkUrl(input.url).catch(() => ({ status: 'unavailable' })) : input.demoScenario ? undefined : { status: 'unavailable' },
  ]);
  let model = null;
  try { model = checkPhishingUrl(input.url); } catch { /* Incomplete is not a safety verdict. */ }
  for (let retry = 0; retry < 5; retry++) {
    await authenticate(request, db);
    const loaded = await loadState(db, user.clientId);
    const globalRevision = await registryRevision(db);
    const report = createPurchaseCheck(input, { scan, cbr, model, registry: await getRegistry(db).catch(() => null), actualNow: Date.now() });
    putPurchaseCheck(loaded.state, report);
    const saved = await db.prepare("UPDATE bank_state SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM registry_version WHERE id = 'global' AND revision = ?)")
      .bind(JSON.stringify(loaded.state), loaded.id, loaded.revision, globalRevision).run();
    if (saved.meta.changes) return json({ report, state: await serializeView(db, loaded.state, user, loaded.revision + 1, loaded.id) });
  }
  throw new ApiError(409, 'Данные изменились. Повторите проверку покупки.');
}

export async function bankApi(request, db, runtime = {}) {
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
      const id = await selectedClient(db, user, url.searchParams.has('clientId') ? url.searchParams.get('clientId') : undefined);
      const loaded = await loadState(db, id);
      return json({ state: await serializeView(db, loaded.state, user, loaded.revision, id), assistant: { configured: !!runtime.GROQ_API_KEY, model: ASSISTANT_MODEL }, transferClassifier: { configured: !!runtime.TRANSFER_MODEL_URL }, websiteInspector: { configured: typeof runtime.inspectWebsite === 'function' } });
    }
    if (url.pathname === '/api/clients' && request.method === 'GET') {
      if (user.role !== 'employee') throw new ApiError(403, 'Список клиентов доступен только сотруднику');
      return json({ clients: await clientsOf(db) });
    }
    if (url.pathname === '/api/registry' && request.method === 'GET') {
      if (user.role !== 'employee') throw new ApiError(403, 'Реестр доступен только сотруднику банка');
      return json({ entries: await getRegistry(db) });
    }
    if (url.pathname === '/api/action' && request.method === 'POST') return await act(request, db, user, runtime);
    if (url.pathname === '/api/trusted/decision' && request.method === 'POST') return await trustedDecision(request, db, user);
    if (url.pathname === '/api/assistant' && request.method === 'POST') return await assistantChat(request, db, user, runtime);
    if (url.pathname === '/api/complaints/chat' && request.method === 'POST') return await complaintChat(request, db, user, runtime);
    if (url.pathname === '/api/phishing/check' && request.method === 'POST') return await checkWebsiteUrl(request, db, user);
    if (url.pathname === '/api/phishing/inspect' && request.method === 'POST') return await inspectWebsite(request, db, user, runtime);
    if (url.pathname === '/api/qr/resolve' && request.method === 'POST') return await resolveBankQr(request, db, user);
    if (url.pathname === '/api/cbr-warning' && request.method === 'POST') return await checkCbrWarning(request, db, user, runtime);
    if (url.pathname === '/api/purchase/check' && request.method === 'POST') return await checkPurchase(request, db, user, runtime);
    throw new ApiError(404, 'Раздел не найден');
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    if ([400, 403, 409, 423].includes(err.status)) return json({ error: err.message }, err.status);
    if (/^Нет |^Дождитесь |^Выберите |^Укажите |^Такой ID|^ID должен|^Неизвестное/.test(err.message || '')) return json({ error: err.message }, 400);
    console.error('Bank API failure', err.message);
    return json({ error: 'Сервис временно недоступен. Попробуйте позже' }, 503);
  }
}
