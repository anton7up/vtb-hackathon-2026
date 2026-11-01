// Server-only evidence binding. This module never opens a site or moves money.
import { normalizeCheckUrl } from './url-phishing-model.mjs';
import { redact } from './anti-scam-model.mjs';

export const PURCHASE_TTL_MS = 15 * 60 * 1000;
export const PURCHASE_DEMOS = Object.freeze({
  brand_clone: 'https://vtb-login.example/confirm',
  shop_clone: 'https://ozon-sale.example/checkout',
  ordinary_shop: 'https://www.store.example/',
  challenge: 'https://protected.example/',
});
export class PurchaseError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'invalid_purchase'; }
}

const amountValid = n => Number.isSafeInteger(n) && n > 0 && n <= 100_000_000_000;
const recipientValid = id => typeof id === 'string' && /^[A-Z0-9][A-Z0-9_-]{2,49}$/u.test(id);
function safeText(value, max = 2000) {
  return redact(String(value || ''))
    .replace(/\b\d{20}\b/gu, '[реквизиты скрыты]')
    .replace(/((?:пароль|password|token|токен|secret|секрет)\s*[:=]\s*)[^\s,;]+/giu, '$1[скрыто]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/gu, '[длинный идентификатор скрыт]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, max);
}

/** Full URL exists only in this transient object for the existing protected scanner. */
export function preparePurchaseInput(body, recipients) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PurchaseError('Некорректная проверка покупки.');
  if (body.consent !== true) throw new PurchaseError('Подтвердите загрузку публичной страницы и сохранение краткого объяснения для сотрудника.');
  if (!amountValid(body.amount)) throw new PurchaseError('Укажите положительную сумму в копейках.');
  const recipient = Array.isArray(recipients) && recipients.find(r => r.id === body.recipientId);
  if (!recipient || !recipientValid(recipient.id)) throw new PurchaseError('Выберите получателя из списка.');
  if (typeof body.explanation !== 'string' || body.explanation.trim().length < 5 || body.explanation.length > 2000) throw new PurchaseError('Кратко объясните покупку: от 5 до 2000 символов без персональных данных.');
  if (body.demoScenario !== undefined && !Object.hasOwn(PURCHASE_DEMOS, body.demoScenario)) throw new PurchaseError('Неизвестный учебный пример.');
  let url;
  try { url = normalizeCheckUrl(body.demoScenario ? PURCHASE_DEMOS[body.demoScenario] : body.url); }
  catch { throw new PurchaseError('Укажите полную HTTP(S)-ссылку без логина и пароля.'); }
  const parsed = new URL(url);
  return { url, origin: parsed.origin, hostname: parsed.hostname, recipientId: recipient.id,
    recipientName: safeText(recipient.name, 80), amount: body.amount,
    explanation: safeText(body.explanation), consent: true,
    ...(body.demoScenario ? { demoScenario: body.demoScenario } : {}) };
}

// Do not store remote HTML, title, form actions, evidence, redirects or messages:
// any of them may contain arbitrary personal data or URL tokens.
const FINDINGS = Object.freeze({
  BRAND_CREDENTIALS: ['high', 'Известный бренд на другом домене вместе с запросом чувствительных данных.'],
  BRAND_MISMATCH: ['medium', 'Принадлежность домена указанному бренду не подтверждена. Возможен независимый продавец.'],
  FORM_HTTP: ['high', 'Чувствительные данные запрашиваются или передаются по незащищённому HTTP.'],
  FORM_GET: ['medium', 'Объявленная форма может помещать чувствительные данные в адресную строку.'],
  FORM_EXTERNAL: ['medium', 'Форма заявляет отправку чувствительных данных на сторонний домен.'],
  FORM_TARGET: ['medium', 'Безопасный адрес отправки формы не определён.'],
  SENSITIVE_FIELDS: ['info', 'Есть поля чувствительных данных; само по себе это не доказывает фишинг.'],
  SAFE_ACCOUNT: ['medium', 'Есть упоминание «безопасного счёта»; контекст должен проверить сотрудник.'],
  REMOTE_ACCESS: ['medium', 'Есть просьба установить удалённый доступ или отключить защиту.'],
  PERSONAL_TRANSFER: ['medium', 'Есть указание на оплату переводом частному лицу.'],
  REDIRECT_DOMAIN: ['info', 'Перенаправление меняет домен. Это бывает и законно.'],
  HTTPS_DOWNGRADE: ['medium', 'Защищённое соединение при перенаправлении сменилось на HTTP.'],
  IDN: ['info', 'Домен содержит международные символы; проверьте написание.'],
  META_REFRESH: ['medium', 'Страница объявляет дополнительное перенаправление; его цель не проверена.'],
  JS_FORM: ['medium', 'Направление отправки поля пароля из JavaScript неизвестно.'],
  URL_MODEL: ['medium', 'URL-модель дала предупреждение; возможны ложные срабатывания.'],
});
function scanSummary(scan, actualNow) {
  if (!scan || scan.status !== 'completed' || !Array.isArray(scan.findings) || !['high_risk', 'review', 'no_signals'].includes(scan.verdict)) return { status: 'unavailable', checkedAt: actualNow, findings: [] };
  const findings = [], seen = new Set();
  let unknownRisk = false;
  for (const f of scan.findings.slice(0, 50)) {
    const code = typeof f?.code === 'string' ? f.code.replace(/^(FORM_(?:HTTP|GET|EXTERNAL|TARGET))_\d+$/u, '$1') : '';
    if (!Object.hasOwn(FINDINGS, code)) { if (['high', 'medium'].includes(f?.severity)) unknownRisk = true; continue; }
    if (seen.has(code)) continue;
    seen.add(code);
    const [severity, message] = FINDINGS[code];
    findings.push({ code, severity, message });
  }
  // An unfamiliar scanner schema must not silently produce a positive conclusion.
  if (unknownRisk || (scan.verdict !== 'no_signals' && !findings.some(f => ['high', 'medium'].includes(f.severity)))) return { status: 'unavailable', checkedAt: actualNow, findings };
  return { status: 'completed', checkedAt: actualNow, findings };
}
function cbrSummary(cbr) {
  if (!cbr) return { status: 'not_requested' };
  if (!['matched', 'not_listed'].includes(cbr.status)) return { status: 'unavailable' };
  return { status: cbr.status, matchCount: cbr.status === 'matched' ? Math.max(1, Math.min(100000, Number.isSafeInteger(cbr.matchCount) ? cbr.matchCount : 1)) : 0,
    recordIds: (cbr.matches || []).filter(r => Number.isSafeInteger(r?.id) && r.id > 0).slice(0, 10).map(r => r.id) };
}
function registrySummary(entries, id) {
  if (!Array.isArray(entries)) return { status: 'unavailable' };
  const matches = entries.filter(e => e?.recipient_id === id);
  return { status: matches.some(e => e.status === 'active') ? 'blocked' : matches.some(e => e.status === 'watch') ? 'watch' : 'not_listed' };
}
function modelSummary(value) {
  if (value === undefined) return { status: 'not_requested', inputType: 'url_only' };
  if (!value || !['safe', 'phishing'].includes(value.label)) return { status: 'unavailable', inputType: 'url_only' };
  // The URL-only classifier has known false positives. Its score is not the
  // probability that this purchase is fraudulent.
  return { status: 'completed', label: value.label, inputType: 'url_only' };
}

/** Called only with server-produced results, never with a verdict from request JSON. */
export function createPurchaseCheck(input, { scan, cbr, registry, model, actualNow = Date.now() } = {}) {
  if (!input || input.consent !== true || !amountValid(input.amount) || !recipientValid(input.recipientId) || !Number.isSafeInteger(actualNow) || actualNow <= 0) throw new PurchaseError('Некорректные условия проверки покупки.');
  const url = new URL(normalizeCheckUrl(input.url));
  const html = scanSummary(scan, actualNow), bankList = cbrSummary(cbr), recipient = registrySummary(registry, input.recipientId), urlModel = modelSummary(model === undefined ? scan?.ml : model);
  const suspicious = html.findings.some(f => ['high', 'medium'].includes(f.severity)) || bankList.status === 'matched' || ['watch', 'blocked'].includes(recipient.status) || urlModel.label === 'phishing';
  const incomplete = html.status !== 'completed' || bankList.status === 'unavailable' || recipient.status === 'unavailable' || urlModel.status === 'unavailable';
  return { id: `PURCHASE-${crypto.randomUUID()}`, version: 'purchase-check-v1', createdAt: actualNow, expiresAt: actualNow + PURCHASE_TTL_MS,
    source: input.demoScenario ? 'demo' : 'live', ...(input.demoScenario ? { demoScenario: input.demoScenario } : {}),
    site: { origin: url.origin, hostname: url.hostname, suppliedBy: 'client', ownershipVerified: false },
    recipientId: input.recipientId, recipientName: safeText(input.recipientName, 80), amount: input.amount,
    bindingKey: JSON.stringify([input.recipientId, input.amount]), explanation: safeText(input.explanation),
    scan: html, cbr: bankList, registry: recipient, model: urlModel,
    status: suspicious ? 'review' : incomplete ? 'incomplete' : 'no_signals', incomplete,
    reviewRequired: suspicious || incomplete,
  };
}

export function putPurchaseCheck(state, report) {
  if (!report?.id || (state.purchaseChecks || []).some(r => r.id === report.id)) throw new PurchaseError('Проверка покупки уже сохранена или некорректна.');
  state.purchaseChecks = [structuredClone(report), ...(state.purchaseChecks || [])].slice(0, 30);
  return report;
}

/** Return a policy condition, not a permission to debit. The bank still owns every decision. */
export function purchaseGate(state, request, actualNow = Date.now()) {
  if (!request.purchaseCheckId) return null;
  const report = (state.purchaseChecks || []).find(r => r.id === request.purchaseCheckId);
  if (!report || report.version !== 'purchase-check-v1' || request.kind !== 'transfer' || report.recipientId !== request.recipientId || report.amount !== request.amount || report.bindingKey !== JSON.stringify([request.recipientId, request.amount])) return { code: 'PURCHASE_INVALID', reason: 'Проверка покупки не соответствует сумме или получателю. Выполните новую проверку.' };
  if (!Number.isSafeInteger(actualNow) || !Number.isSafeInteger(report.createdAt) || report.createdAt > actualNow || !Number.isSafeInteger(report.expiresAt) || report.expiresAt !== report.createdAt + PURCHASE_TTL_MS || actualNow >= report.expiresAt) return { code: 'PURCHASE_EXPIRED', reason: 'Срок проверки покупки истёк. Проверьте сайт и условия заново; деньги не списаны.' };
  if (report.status === 'review') return { code: 'PURCHASE_REVIEW', reason: 'В связанной проверке покупки есть признаки риска. До решения сотрудника деньги не списываются.' };
  if (report.status !== 'no_signals' || report.incomplete || report.scan?.status !== 'completed' || report.registry?.status === 'unavailable' || report.cbr?.status === 'unavailable') return { code: 'PURCHASE_CHECK_INCOMPLETE', reason: 'Связанная проверка покупки не завершена. Это не подтверждение безопасности; нужна проверка сотрудника.' };
  return null;
}

export function purchaseSummary(report) {
  if (!report) return null;
  return { id: report.id, status: report.status, source: report.source, origin: report.site?.origin || '', suppliedBy: 'client', ownershipVerified: false,
    recipientId: report.recipientId, recipientName: report.recipientName, amount: report.amount, explanation: report.explanation,
    createdAt: report.createdAt, expiresAt: report.expiresAt, incomplete: report.incomplete,
    findings: (report.scan?.findings || []).map(f => ({ code: f.code, severity: f.severity, message: f.message })),
    model: report.model, scanStatus: report.scan?.status || 'unavailable', registryStatus: report.registry?.status || 'unavailable', cbrStatus: report.cbr?.status || 'not_requested' };
}
