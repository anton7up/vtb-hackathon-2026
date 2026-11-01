import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQr } from '../public/qr-analysis.mjs';
import { QR_DEMOS, renderQrCheck, renderQrDemo } from '../public/qr-view.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const helpers = { esc };
const state = overrides => ({
  qrBusy: false, qrMode: 'file', qrFile: null, qrText: '', qrDecoded: '', qrExpectedAmount: '', qrExpectedRecipient: '', qrError: '', qrReport: null,
  qrDemo: 'sbp', qrDemoReport: null, ...overrides,
});
const paymentUrl = QR_DEMOS.sbp.text;

test('client QR screen has a local-only explicit form, no network action or automatic upload', () => {
  const html = renderQrCheck(state(), helpers);
  assert.match(html, /id="qr-form"/);
  assert.match(html, /id="qr-file"[^>]*type="file"[^>]*accept="image\/png,image\/jpeg"/);
  assert.equal((html.match(/type="submit"/g) || []).length, 1);
  for (const tag of html.match(/<form\b[^>]*>/g) || []) assert.equal(/\b(?:action|method|enctype)\s*=/.test(tag), false);
  assert.equal(/\bformaction\s*=|<script\b|<iframe\b|<img\b/i.test(html), false);
  assert.match(html, /Изображение распознаётся только в этой вкладке/);
  assert.match(html, /data-page="qr-demo"/);
  assert.equal(/data-qr-demo=/.test(html), false);
});

test('client QR text, file name, comparison inputs, errors and report fields are escaped', () => {
  const attack = '"><img src=x onerror=alert(1)></textarea><script>alert(2)</script>';
  const report = {
    ...analyzeQr(QR_DEMOS.mismatch.text),
    title: attack, message: attack, displayUrl: attack,
    fields: [{ label: attack, value: attack }], warnings: [attack], tone: 'danger" onclick="alert(3)',
  };
  const html = renderQrCheck(state({ qrFile: { name: attack }, qrText: attack, qrDecoded: attack, qrExpectedAmount: attack, qrExpectedRecipient: attack, qrError: attack, qrReport: report }), helpers);
  assert.equal(/<(?:script|img|iframe|svg)\b/i.test(html), false);
  assert.equal(html.includes('value=""><img'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;\/textarea&gt;/);
  assert.equal(html.includes('outcome-danger" onclick='), false);
  assert.match(html, /Получатель не подтверждён банком/);
});

test('client and jury renderers never use each other’s QR reports or decoded contents', () => {
  const clientReport = { ...analyzeQr(paymentUrl), title: 'CLIENT_REPORT_ONLY' };
  const demoReport = { ...analyzeQr(QR_DEMOS.subscription.text), title: 'JURY_REPORT_ONLY' };
  const ui = state({ qrReport: clientReport, qrDecoded: 'CLIENT_DECODED_ONLY', qrDemo: 'subscription', qrDemoReport: demoReport });
  const client = renderQrCheck(ui, helpers), jury = renderQrDemo(ui, helpers);
  assert.equal(client.includes('CLIENT_REPORT_ONLY'), true);
  assert.equal(client.includes('CLIENT_DECODED_ONLY'), true);
  assert.equal(client.includes('JURY_REPORT_ONLY'), false);
  assert.equal(jury.includes('JURY_REPORT_ONLY'), true);
  assert.equal(jury.includes('CLIENT_REPORT_ONLY'), false);
  assert.equal(jury.includes('CLIENT_DECODED_ONLY'), false);
  assert.match(jury, /ДЕМО · вымышленные платёжные данные/);
  assert.match(jury, /ДЕМО · без реальных денег/);
});

test('decoded payment addresses and bank application schemes remain inert text', () => {
  for (const text of [paymentUrl, QR_DEMOS.subscription.text, 'bank100000000001://qr.nspk.ru/EXAMPLE', QR_DEMOS.mismatch.text]) {
    const html = renderQrCheck(state({ qrDecoded: text, qrReport: analyzeQr(text) }), helpers);
    assert.equal(/<a\b/i.test(html), false);
    assert.equal(/\b(?:href|src|action|formaction)\s*=/i.test(html), false);
    assert.equal(/data-qr-link/.test(html), false);
  }
});

test('an ordinary URL offers an internal button, not an external anchor or automatic fetch', () => {
  const text = 'https://www.wikipedia.org/path?token=private#section';
  const html = renderQrCheck(state({ qrDecoded: text, qrReport: analyzeQr(text) }), helpers);
  assert.match(html, /<button\b(?=[^>]*type="button")(?=[^>]*data-qr-link)[^>]*>/);
  assert.equal(/<a\b|\bhref\s*=|\bsrc\s*=/i.test(html), false);
  assert.match(html, /Загрузка сайта начнётся после отдельного нажатия/);
  assert.match(html, /<details class="client-details"><summary>Содержимое QR/);
  assert.equal(/<details class="client-details"[^>]*\bopen/.test(html), false);
});

test('jury PNG downloads are fixed same-origin files and demos have no payment or network form action', () => {
  const report = analyzeQr(QR_DEMOS.spoof.text);
  const html = renderQrDemo(state({ qrDemo: 'spoof', qrDemoReport: report }), helpers);
  const anchors = html.match(/<a\b[^>]*>/g) || [];
  assert.equal(anchors.length, Object.keys(QR_DEMOS).length);
  const origin = 'http://127.0.0.1:3000';
  for (const anchor of anchors) {
    assert.match(anchor, /\bdownload(?:\s|>)/);
    const href = anchor.match(/\bhref="([^"]+)"/)?.[1];
    assert.match(href, /^\/qr-demo-[a-z]+\.png$/);
    assert.equal(new URL(href, origin).origin, origin);
    assert.equal(new URL(href, origin).search, '');
  }
  for (const key of Object.keys(QR_DEMOS)) assert.match(html, new RegExp(`data-qr-demo="${key}"`));
  assert.equal(/<form\b|\bformaction\s*=|<iframe\b|<script\b|<img\b/i.test(html), false);
  assert.equal(/data-qr-link/.test(html), false, 'a demo result must not offer its synthetic URL as a live action');
});

test('busy client QR processing disables all editable controls and does not change the jury state', () => {
  const ui = state({ qrBusy: true, qrDemo: 'mismatch', qrDemoReport: analyzeQr(QR_DEMOS.mismatch.text) });
  const client = renderQrCheck(ui, helpers);
  for (const id of ['qr-file', 'qr-text', 'qr-expected-amount', 'qr-expected-recipient']) {
    const tag = client.match(new RegExp(`<(?:input|textarea)\\b[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id); assert.match(tag, /\bdisabled\b/);
  }
  assert.match(client, /<button\b(?=[^>]*type="submit")(?=[^>]*\bdisabled)[^>]*>/);
  assert.match(client, /role="status"/);
  const jury = renderQrDemo(ui, helpers);
  assert.match(jury, /data-qr-demo="mismatch"/);
  assert.equal(jury.includes('Читаем QR'), false);
});
