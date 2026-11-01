import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePurchaseInput, createPurchaseCheck, putPurchaseCheck, purchaseGate, purchaseSummary, PURCHASE_TTL_MS } from '../lib/purchase-check.mjs';
import { renderPurchaseCheck, renderPurchaseReport, renderPurchaseCase } from '../public/purchase-view.mjs';
import { analyzePage } from '../server/scanner/analyze.mjs';
import { DEMO_SCENARIOS } from '../server/scanner/fixtures.mjs';

const NOW = 1900000000000;
const recipients = [{ id: 'DEMO-CLASS-NORMAL', name: 'Учебный продавец' }, { id: 'DEMO-FAMILY-001', name: 'Мама' }];
const body = { url: 'https://shop.example/orders/PRIVATE_PATH?token=PRIVATE_QUERY#PRIVATE_HASH', recipientId: recipients[0].id, amount: 300000, explanation: 'Покупаю велосипед, продавец прислал реквизиты.', consent: true };
const completed = { status: 'completed', verdict: 'no_signals', findings: [] };
const request = report => ({ kind: 'transfer', recipientId: report.recipientId, amount: report.amount, purchaseCheckId: report.id });
function report(options = {}, input = {}) { return createPurchaseCheck(preparePurchaseInput({ ...body, ...input }, recipients), { scan: completed, registry: [], model: { label: 'safe' }, actualNow: NOW, ...options }); }
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = { esc, money: v => `${v / 100} ₽`, date: v => new Date(v).toISOString() };

test('purchase input requires explicit consent, known recipient, positive integer kopecks and explanation', () => {
  for (const change of [{ consent: false }, { consent: 'true' }, { recipientId: 'FOREIGN-ONE' }, { amount: '300000' }, { amount: 0 }, { amount: 1.1 }, { explanation: 'нет' }, { explanation: 'x'.repeat(2001) }, { url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com/' }, { demoScenario: 'unsafe' }]) {
    assert.throws(() => preparePurchaseInput({ ...body, ...change }, recipients), error => error.status === 400);
  }
  assert.equal(preparePurchaseInput(body, recipients).url, body.url);
  assert.equal(preparePurchaseInput(body, recipients).amount, 300000);
});

test('persisted purchase contains no full URL, path/query/fragment, HTML or arbitrary scanner evidence', () => {
  const result = report({ scan: { ...completed, title: 'PRIVATE_TITLE', html: 'PRIVATE_HTML', input_url: body.url, final_url: 'https://else.example/PRIVATE_REDIRECT', redirects: [{ url: body.url }], findings: [{ code: 'BRAND_CREDENTIALS', severity: 'high', message: 'PRIVATE_REMOTE_MESSAGE', evidence: body.url }] } });
  const json = JSON.stringify(result);
  for (const forbidden of ['PRIVATE_PATH', 'PRIVATE_QUERY', 'PRIVATE_HASH', 'PRIVATE_TITLE', 'PRIVATE_HTML', 'PRIVATE_REDIRECT', 'PRIVATE_REMOTE_MESSAGE']) assert.equal(json.includes(forbidden), false, forbidden);
  assert.deepEqual(result.site, { origin: 'https://shop.example', hostname: 'shop.example', suppliedBy: 'client', ownershipVerified: false });
  assert.equal(result.scan.findings[0].code, 'BRAND_CREDENTIALS');
  assert.match(result.scan.findings[0].message, /чувствительных данных/);
});

test('free explanation redacts keys, contact and payment details as best effort', () => {
  const result = report({}, { explanation: 'За покупку. Мой email me@example.com, телефон +7 900 123-45-67. Карта 4111 1111 1111 1111. пароль: PRIVATE_PASSWORD token=PRIVATE_TOKEN ссылка https://secret.example/private?key=secret' });
  const text = result.explanation;
  for (const secret of ['me@example.com', '+7 900', '4111', 'PRIVATE_PASSWORD', 'PRIVATE_TOKEN', 'secret.example']) assert.equal(text.includes(secret), false, secret);
  assert.match(text, /скрыт/);
});

test('only matching saved owner report can be bound and request verdict fields are ignored', () => {
  const result = report();
  const state = { purchaseChecks: [result] };
  assert.equal(purchaseGate(state, { ...request(result), status: 'review', verdict: 'block' }, NOW + 1), null);
  assert.equal(purchaseGate({}, request(result), NOW + 1).code, 'PURCHASE_INVALID');
  for (const change of [{ recipientId: 'DEMO-FAMILY-001' }, { amount: 1 }, { kind: 'cash' }, { purchaseCheckId: 'PURCHASE-foreign' }]) assert.equal(purchaseGate(state, { ...request(result), ...change }, NOW + 1).code, 'PURCHASE_INVALID');
  assert.equal(purchaseGate(state, { kind: 'transfer', amount: 1, recipientId: 'DEMO-FAMILY-001' }, NOW + 1), null);
});

test('binding fingerprint catches stored report amount or recipient tampering', () => {
  const result = report();
  for (const change of [{ amount: 100 }, { recipientId: 'DEMO-FAMILY-001' }, { bindingKey: 'forged' }, { version: 'old' }]) {
    const changed = { ...result, ...change };
    assert.equal(purchaseGate({ purchaseChecks: [changed] }, request(changed), NOW + 1).code, 'PURCHASE_INVALID');
  }
});

test('15-minute real TTL is strict, rejects future creation and modified expiry', () => {
  const result = report(), state = { offsetMs: 48 * 3600000, purchaseChecks: [result] };
  assert.equal(purchaseGate(state, request(result), NOW + PURCHASE_TTL_MS - 1), null);
  assert.equal(purchaseGate(state, request(result), NOW + PURCHASE_TTL_MS).code, 'PURCHASE_EXPIRED');
  assert.equal(purchaseGate(state, request(result), NOW - 1).code, 'PURCHASE_EXPIRED');
  assert.equal(purchaseGate({ purchaseChecks: [{ ...result, expiresAt: NOW + PURCHASE_TTL_MS * 3 }] }, request(result), NOW + 1).code, 'PURCHASE_EXPIRED');
});

test('risk signals need employee review, not automatic payment or global fraud accusation', () => {
  for (const options of [
    { scan: { status: 'completed', verdict: 'high_risk', findings: [{ code: 'FORM_HTTP_0', severity: 'high' }] } },
    { scan: { status: 'completed', verdict: 'review', findings: [{ code: 'BRAND_MISMATCH', severity: 'medium' }] } },
    { cbr: { status: 'matched', matchCount: 2, matches: [{ id: 123 }] } },
    { registry: [{ recipient_id: body.recipientId, status: 'watch' }] },
    { registry: [{ recipient_id: body.recipientId, status: 'active' }] },
    { model: { label: 'phishing', phishing_score: 0.99999 } },
  ]) {
    const result = report(options);
    assert.equal(result.status, 'review');
    assert.equal(purchaseGate({ purchaseChecks: [result] }, request(result), NOW + 1).code, 'PURCHASE_REVIEW');
    assert.equal(Object.hasOwn(result, 'allowed'), false);
    assert.equal(JSON.stringify(result).includes('0.99999'), false);
  }
});

test('unavailable or malformed sources never become a reassuring no-signals result', () => {
  for (const options of [{ scan: undefined }, { scan: { status: 'unavailable', findings: [] } }, { scan: { ...completed, verdict: 'unknown' } }, { registry: null }, { cbr: { status: 'unavailable' } }, { model: null }, { scan: { ...completed, findings: [{ code: 'FUTURE_RISK', severity: 'high', evidence: 'PRIVATE_UNKNOWN' }] } }]) {
    const result = report(options);
    assert.equal(result.status, 'incomplete');
    assert.equal(purchaseGate({ purchaseChecks: [result] }, request(result), NOW + 1).code, 'PURCHASE_CHECK_INCOMPLETE');
    assert.equal(JSON.stringify(result).includes('PRIVATE_UNKNOWN'), false);
  }
});

test('risk and incompleteness can coexist, keeping both facts visible', () => {
  const result = report({ scan: { status: 'unavailable' }, model: { label: 'phishing' } });
  assert.equal(result.status, 'review'); assert.equal(result.incomplete, true);
  assert.equal(purchaseGate({ purchaseChecks: [result] }, request(result), NOW + 1).code, 'PURCHASE_REVIEW');
});

test('controlled shop substitution fixture yields a genuine scanner signal, not a hard-coded approval', () => {
  const input = preparePurchaseInput({ ...body, demoScenario: 'shop_clone', url: 'http://127.0.0.1/private' }, recipients);
  assert.equal(input.url, DEMO_SCENARIOS.shop_clone.url);
  const fixture = DEMO_SCENARIOS.shop_clone;
  const scan = analyzePage({ inputUrl: fixture.url, finalUrl: fixture.url, html: fixture.html, source: 'demo' });
  const result = createPurchaseCheck(input, { scan, registry: [], actualNow: NOW });
  assert.equal(result.source, 'demo'); assert.equal(result.status, 'review');
  assert.ok(result.scan.findings.some(f => f.code === 'BRAND_CREDENTIALS'));
});

test('source records are copied, bounded, and cannot replace a saved check ID', () => {
  const state = {}, result = report();
  putPurchaseCheck(state, result); result.explanation = 'changed';
  assert.notEqual(state.purchaseChecks[0].explanation, 'changed');
  assert.throws(() => putPurchaseCheck(state, result));
  for (let i = 0; i < 40; i++) putPurchaseCheck(state, report());
  assert.equal(state.purchaseChecks.length, 30);
});

test('summary preserves only useful linked facts and explicitly unverified origin relationship', () => {
  const result = report({ cbr: { status: 'matched', matches: [{ id: 123, name: 'PRIVATE_COMPANY_BODY', site: body.url }] } });
  const summary = purchaseSummary(result);
  assert.equal(summary.origin, 'https://shop.example');
  assert.equal(summary.ownershipVerified, false); assert.equal(summary.suppliedBy, 'client');
  assert.equal(summary.cbrStatus, 'matched'); assert.equal(purchaseSummary(null), null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_COMPANY_BODY'), false);
});

test('purchase UI explains volunteered URL, consent, account restrictions and no automatic debit', () => {
  const html = renderPurchaseCheck({ purchaseRecipient: body.recipientId }, { recipients, purchaseChecks: [report()] }, h);
  for (const phrase of ['purchase-check-form', 'purchase-url', 'purchase-consent', 'банк не узнаёт', 'из платежа автоматически', 'не отправляет деньги', 'не отменяет стоп-лист', 'в Qwen автоматически не отправляется']) assert.ok(html.includes(phrase), phrase);
  assert.match(html, /data-purchase-use=/); assert.equal(/href="https?:/.test(html), false);
});

test('owner and employee see the same saved summary without buttons to bypass banking review', () => {
  const result = report(), op = { purchaseCheckId: result.id };
  const html = renderPurchaseCase(op, { purchaseChecks: [result] }, h);
  assert.match(html, /Связанная проверка покупки/); assert.match(html, /Учебный продавец/);
  assert.equal(html.includes('data-purchase-use='), false);
  assert.match(renderPurchaseCase(op, {}, h), /отчёт недоступен/);
  assert.equal(renderPurchaseCase({}, {}, h), '');
});

test('untrusted client and scanner text stays escaped; expired results cannot continue', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const result = { ...report(), recipientName: xss, explanation: xss, site: { origin: xss }, expiresAt: 1000 };
  const html = renderPurchaseReport(result, h, { actionable: true }) + renderPurchaseCheck({ purchaseUrl: xss, purchaseExplanation: xss, purchaseError: xss }, { recipients: [{ id: xss, name: xss }] }, h);
  assert.equal(html.includes('<img'), false); assert.match(html, /&lt;img/);
  assert.equal(html.includes('data-purchase-use='), false); assert.match(html, /Срок привязки истёк/);
});
