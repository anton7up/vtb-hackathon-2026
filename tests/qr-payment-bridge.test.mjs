import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQrPayment, qrTransferRequest } from '../lib/qr-payment-bridge.mjs';
import { QR_DEMOS, renderQrCheck, renderQrDemo } from '../public/qr-view.mjs';
import { renderQrPayment, renderQrPaymentEntry } from '../public/qr-payment-view.mjs';
import { analyzeQr } from '../public/qr-analysis.mjs';
import { initialState, attempt, confirmOperation, changeAccess } from '../lib/bank-engine.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const helpers = { esc };
const registryEntry = (status, extra = {}) => ({ recipient_id: 'DEMO-CLASS-NORMAL', status, source: 'synthetic_complaint_review', ...extra });
const classified = (payload = QR_DEMOS.shared.text, fixtureId = 'demo-qr-shared') => ({ ...qrTransferRequest(payload, fixtureId), classification: { class: 'normal' }, requestId: 'qr-payment-test-0001' });

test('only the two exact, explicitly fictional QR fixtures resolve canonical bank fields', () => {
  const cases = [['normal', 'DEMO-FAMILY-001', 100000], ['shared', 'DEMO-CLASS-NORMAL', 300000]];
  for (const [key, recipientId, amount] of cases) {
    assert.equal(analyzeQr(QR_DEMOS[key].text).kind, 'sbp');
    const report = resolveQrPayment(QR_DEMOS[key].text, []);
    assert.equal(report.supported, true);
    assert.equal(report.recipient.id, recipientId);
    assert.equal(report.amountKopecks, amount);
    assert.equal(report.registryStatus, 'clear');
    assert.equal(report.demo, true);
    assert.equal(report.source, 'demo_qr_adapter');
    assert.equal(report.recipientVerified, false);
    assert.equal(report.authenticQrVerified, false);
    assert.equal('allowed' in report, false);
    assert.equal('safe' in report, false);
    const canonical = qrTransferRequest(QR_DEMOS[key].text, report.fixtureId);
    assert.equal(canonical.amount, amount);
    assert.equal(canonical.recipientId, recipientId);
    assert.equal(canonical.paymentContext.fixtureId, report.fixtureId);
    assert.equal(Object.hasOwn(canonical.paymentContext, 'payload'), false);
  }
});

test('unknown SBP, subscription, lookalike, receipt, requisites and arbitrary text never become transfers', () => {
  for (const payload of [QR_DEMOS.sbp.text, QR_DEMOS.subscription.text, QR_DEMOS.spoof.text, QR_DEMOS.mismatch.text, 't=20260101T1200&s=100&fn=1234567890123456&i=1&fp=123&n=1', 'https://example.com/', '', null, {}, 42, 'a'.repeat(4097)]) {
    const report = resolveQrPayment(payload, []);
    assert.equal(report.supported, false);
    assert.equal(report.registryStatus, 'not_checked');
    assert.equal('recipient' in report, false);
    assert.throws(() => qrTransferRequest(payload, 'demo-qr-shared'), { code: 'QR_PAYMENT_UNSUPPORTED' });
  }
});

test('changed content, mismatched preview, missing fixture and client-provided amount cannot expand the allowlist', () => {
  for (const payload of [
    `${QR_DEMOS.shared.text}?sum=1`, `${QR_DEMOS.shared.text} `,
    QR_DEMOS.shared.text.toLowerCase(), `${QR_DEMOS.shared.text}#test`,
    QR_DEMOS.shared.text.replace('qr.nspk.ru/', 'qr.nspk.ru.evil.example/'),
  ]) {
    assert.equal(resolveQrPayment(payload, []).supported, false);
    assert.throws(() => qrTransferRequest(payload, 'demo-qr-shared'), { code: 'QR_PAYMENT_UNSUPPORTED' });
  }
  assert.throws(() => qrTransferRequest(QR_DEMOS.normal.text, 'demo-qr-shared'), { code: 'QR_PAYMENT_UNSUPPORTED' });
  assert.throws(() => qrTransferRequest(QR_DEMOS.shared.text), { code: 'QR_PAYMENT_UNSUPPORTED' });
  assert.equal(qrTransferRequest(QR_DEMOS.shared.text, 'demo-qr-shared', { amount: 1 }).amount, 300000);
});

test('registry precedence is active > watch > clear and unavailable fails closed without exposing reasons', () => {
  const secrets = { reason: 'PRIVATE_REPORT_MESSAGE', reportId: 'PRIVATE-REPORT-ID', customerName: 'PRIVATE-CUSTOMER' };
  for (const [registry, expected] of [
    [[registryEntry('watch', secrets)], 'watch'],
    [[registryEntry('watch'), registryEntry('active', secrets)], 'blocked'],
    [[registryEntry('inactive', secrets)], 'clear'],
    [[{ ...registryEntry('active', secrets), recipient_id: 'OTHER' }], 'clear'],
    [null, 'unavailable'], [undefined, 'unavailable'],
  ]) {
    const result = resolveQrPayment(QR_DEMOS.shared.text, registry);
    assert.equal(result.registryStatus, expected);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
});

test('only sanitized aggregate complaint counts are returned; no invented exact count', () => {
  assert.equal(resolveQrPayment(QR_DEMOS.shared.text, [registryEntry('watch')]).reviewedComplaintCount, null);
  for (const bad of ['3', -1, 2.2, Number.MAX_SAFE_INTEGER, NaN, Infinity, { clientId: 'SECRET' }]) {
    const result = resolveQrPayment(QR_DEMOS.shared.text, [], { reviewedComplaintCount: bad });
    assert.equal(result.reviewedComplaintCount, null);
    assert.equal(result.hasReviewedComplaints, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
  const counted = resolveQrPayment(QR_DEMOS.shared.text, [registryEntry('watch')], { reviewedComplaintCount: 2 });
  assert.equal(counted.reviewedComplaintCount, 2);
  assert.equal(counted.hasReviewedComplaints, true);
});

test('read-only QR lookup changes no balance; watch sends the ordinary engine to review with no debit', () => {
  const now = 1000000000, state = initialState(now), balance = state.balance;
  const registry = [registryEntry('watch')];
  const report = resolveQrPayment(QR_DEMOS.shared.text, registry);
  assert.equal(report.registryStatus, 'watch');
  assert.equal(state.balance, balance);
  const result = attempt(state, classified(), registry, now);
  assert.equal(result.decision.code, 'MODEL_REVIEW');
  assert.equal(result.operation.status, 'pending');
  assert.equal(state.balance, balance);
});

test('registry is checked again before QR confirmation; clear preview cannot bypass a new stop mark', () => {
  const now = 1000000000, state = initialState(now), balance = state.balance;
  const report = resolveQrPayment(QR_DEMOS.shared.text, []);
  const request = classified(QR_DEMOS.shared.text, report.fixtureId);
  assert.equal(attempt(state, request, [], now).decision.allowed, true);
  const confirmedRequest = { ...qrTransferRequest(QR_DEMOS.shared.text, report.fixtureId), classification: request.classification, requestId: request.requestId };
  const result = confirmOperation(state, confirmedRequest, [registryEntry('active')], now + 1);
  assert.equal(result.decision.code, 'RISK_REGISTRY');
  assert.equal(state.balance, balance);
});

test('ordinary QR transfers still need separate confirmation and duplicate confirmation does not debit twice', () => {
  const now = 1000000000, state = initialState(now), balance = state.balance;
  const request = classified(QR_DEMOS.normal.text, 'demo-qr-normal');
  assert.equal(attempt(state, request, [], now).decision.allowed, true);
  assert.equal(state.balance, balance);
  assert.equal(confirmOperation(state, request, [], now + 1).operation.status, 'completed');
  assert.equal(state.balance, balance - 100000);
  assert.equal(confirmOperation(state, request, [], now + 2).duplicate, true);
  assert.equal(state.balance, balance - 100000);
});

test('QR adapter does not override existing account security lock and hold policies', () => {
  const now = 1000000000, state = initialState(now), request = classified(), balance = state.balance;
  changeAccess(state, 'phone', now, '+7 000 000-00-02');
  // Both allowed fixtures are previous recipients; a hold does not mean exempt from the registry.
  assert.equal(attempt(state, request, [registryEntry('active')], now + 1).decision.code, 'RISK_REGISTRY');
  state.securityLock = { at: now };
  assert.equal(attempt(state, { ...request, requestId: 'qr-payment-test-0002' }, [], now + 2).decision.code, 'ACCOUNT_SECURITY_LOCK');
  assert.equal(state.balance, balance);
});

test('payment UI requires explicit lookup, hides employee controls and never creates links from QR', () => {
  const unknown = renderQrPaymentEntry(QR_DEMOS.shared.text, helpers);
  assert.match(unknown, /data-qr-payment-resolve="check"/);
  assert.doesNotMatch(unknown, /data-qr-payment-attempt/);
  assert.equal(renderQrPaymentEntry(QR_DEMOS.shared.text, helpers, { role: 'employee' }), '');
  const report = resolveQrPayment(QR_DEMOS.shared.text, [registryEntry('watch')], { reviewedComplaintCount: 2 });
  const rendered = renderQrPayment(report, helpers, { demo: true });
  assert.match(rendered, /data-qr-payment-attempt="demo"/);
  assert.match(rendered, /рассмотренные жалобы: 2/);
  assert.doesNotMatch(rendered, /href=|PRIVATE_|автоматически разрешён/);
  assert.match(rendered, /ещё не оплата/);
  for (const registry of [null, [registryEntry('active')]]) {
    assert.doesNotMatch(renderQrPayment(resolveQrPayment(QR_DEMOS.shared.text, registry), helpers), /data-qr-payment-attempt/);
  }
});

test('scan and jury views keep raw QR parsing separate from bank lookup and escape server text', () => {
  const ui = { role: 'client', qrReport: analyzeQr(QR_DEMOS.shared.text), qrDecoded: QR_DEMOS.shared.text, qrText: '', qrDemo: 'shared', qrDemoReport: analyzeQr(QR_DEMOS.shared.text) };
  const scanned = renderQrCheck(ui, helpers), jury = renderQrDemo(ui, helpers);
  assert.match(scanned, /data-qr-payment-resolve="check"/);
  assert.match(jury, /data-qr-payment-resolve="demo"/);
  assert.match(jury, /qr-demo-normal.png/);
  assert.match(jury, /qr-demo-shared.png/);
  assert.doesNotMatch(jury, /без оплаты и сети/);
  const report = resolveQrPayment(QR_DEMOS.shared.text, []);
  report.message = '<script>alert(1)</script>';
  report.recipient.name = '<img src=x onerror=alert(2)>';
  const rendered = renderQrPayment(report, helpers);
  assert.doesNotMatch(rendered, /<script|<img/);
  assert.match(rendered, /&lt;script/);
});
