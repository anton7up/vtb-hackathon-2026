import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePage } from '../server/scanner/analyze.mjs';
import { DEMO_SCENARIOS } from '../server/scanner/fixtures.mjs';
import { normalizeClientUrl, renderClientResult, renderJuryDemo, renderLinkChecks } from '../public/site-inspection.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const helpers = { esc, icon: () => '<svg aria-hidden="true"></svg>', date: () => '29.10, 12:00', inspectorAvailable: true };
const state = overrides => ({
  urlDraft: '', siteReport: null, urlResult: null, urlBusy: false, urlError: '', pageConsent: false,
  juryReport: null, juryBusy: false, juryError: '', juryScenario: 'brand_clone', juryUrl: '', juryModelResult: null,
  ...overrides,
});
function report(scenario = 'brand_clone', overrides = {}) {
  const d = DEMO_SCENARIOS[scenario];
  return { ...analyzePage({ inputUrl: d.url, finalUrl: d.url, html: d.html, trace: [{ url: d.url, status: 200 }] }), ...overrides };
}
const visiblePart = html => html.split(/<details\b/i)[0];

test('client accepts a bare domain without requiring technical URL syntax', () => {
  assert.equal(new URL(normalizeClientUrl('  example.com/shop?item=1  ')).href, 'https://example.com/shop?item=1');
  assert.equal(new URL(normalizeClientUrl('https://example.com/')).href, 'https://example.com/');
  assert.equal(new URL(normalizeClientUrl('http://example.com/')).href, 'http://example.com/');
});

test('client URL normalization rejects schemes, credentials, invalid input and embedded whitespace', () => {
  for (const raw of ['', '   ', null, undefined, 42, 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/', 'https://user:password@example.com/', 'user:password@example.com', 'https://example.com/a b', 'https://example.com/\nprivate', 'example .com']) {
    assert.throws(() => normalizeClientUrl(raw), undefined, String(raw));
  }
});

test('client screen has one primary check action and keeps examples off the form', () => {
  const html = renderLinkChecks(state(), helpers);
  assert.equal((html.match(/id=["']website-url["']/g) || []).length, 1);
  assert.equal((html.match(/type=["']submit["']/g) || []).length, 1);
  const urlField = html.match(/<input\b[^>]*id=["']website-url["'][^>]*>/)?.[0];
  assert.equal(/type=["']url["']/.test(urlField) && !/<form\b[^>]*\bnovalidate/.test(html), false, 'bare domains must reach the normalization handler');
  assert.match(html, /Проверить ссылку/);
  assert.equal(/data-page-demo=/.test(html), false);
  assert.equal(/Только URL-модель/.test(html), false);
  assert.equal(/<aside\b/i.test(html), false);
  assert.match(html, /data-page=["']jury-demo["']/);
});

test('client result shows a concise verdict and leaves the full report closed', () => {
  const r = report();
  r.findings = Array.from({ length: 8 }, (_, i) => ({ code: `TEST_${i}`, severity: 'high', message: `ПРИЧИНА_${i}_КОНЕЦ`, evidence: `DETAIL_${i}` }));
  const html = renderClientResult(r, helpers);
  const visible = visiblePart(html);
  assert.ok(visible.length > 0);
  assert.equal((visible.match(/ПРИЧИНА_\d+_КОНЕЦ/g) || []).length <= 3, true);
  assert.equal(/scan-facts|scan-form|scan-ml|phishing_score|TF-IDF/.test(visible), false);
  assert.match(html, /<details\b[^>]*>\s*<summary[^>]*>\s*Подробнее о проверке/);
  assert.equal(/<details\b[^>]*\bopen(?:\s|=|>)/.test(html), false);
  assert.match(html, /DETAIL_7/);
});

test('client cannot mistake a fixture result for a real check', () => {
  for (const scenario of ['brand_clone', 'shop_clone', 'ordinary_shop', 'challenge']) {
    const demo = report(scenario, { source: 'demo_fixture' });
    assert.equal(renderClientResult(demo, helpers), '', scenario);
    const html = renderLinkChecks(state({ siteReport: demo }), helpers);
    assert.equal(html.includes('collector.example'), false, scenario);
    assert.equal(html.includes('scan-findings'), false, scenario);
  }
});

test('unavailable and no-signal results never promise unconditional safety', () => {
  const unavailable = visiblePart(renderClientResult(report('challenge'), helpers));
  assert.match(unavailable, /Не удалось проверить/i);
  assert.equal(/class=["'][^"']*\bgreen\b/.test(unavailable), false);
  assert.equal(/сайт безопасен|можно доверять|гарантированно безопас/i.test(unavailable), false);
  const ordinary = visiblePart(renderClientResult(report('ordinary_shop'), helpers));
  assert.equal(/сайт безопасен|можно доверять|гарантированно безопас/i.test(ordinary), false);
});

test('jury screen owns four honest offline scenarios and does not render the client result', () => {
  const clientReport = report('ordinary_shop');
  clientReport.title = 'CLIENT_RESULT_MUST_NOT_LEAK';
  const juryReport = report('shop_clone', { source: 'demo_fixture' });
  juryReport.title = 'JURY_REPORT_VISIBLE';
  const html = renderJuryDemo(state({ siteReport: clientReport, juryReport, juryScenario: 'shop_clone' }), helpers);
  for (const scenario of ['brand_clone', 'shop_clone', 'ordinary_shop', 'challenge']) assert.match(html, new RegExp(`data-page-demo=["']${scenario}["']`));
  assert.equal((html.match(/data-page-demo=/g) || []).length, 4);
  assert.match(html, /Учебный пример · без сети/);
  assert.equal(html.includes('CLIENT_RESULT_MUST_NOT_LEAK'), false);
  assert.equal(html.includes('JURY_REPORT_VISIBLE'), true);
});

test('client and jury loading states use their own busy flags', () => {
  const clientBusy = renderLinkChecks(state({ urlBusy: true }), helpers);
  assert.match(clientBusy, /<button\b(?=[^>]*type=["']submit["'])(?=[^>]*\bdisabled)[^>]*>/);
  const juryBusy = renderJuryDemo(state({ juryBusy: true }), helpers);
  for (const scenario of ['brand_clone', 'shop_clone', 'ordinary_shop', 'challenge']) assert.match(juryBusy, new RegExp(`<button\\b(?=[^>]*data-page-demo=["']${scenario}["'])(?=[^>]*\\bdisabled)[^>]*>`));
  const independentClient = renderLinkChecks(state({ juryBusy: true }), helpers);
  assert.equal(/<button\b(?=[^>]*type=["']submit["'])(?=[^>]*\bdisabled)[^>]*>/.test(independentClient), false);
});

test('untrusted input and report text remain escaped and target addresses stay inert', () => {
  const r = report();
  r.title = '<img src=x onerror=alert(1)>';
  r.findings[0].message = '<script>alert(1)</script>';
  r.findings[0].evidence = '</code><iframe src="https://evil.example/"></iframe>';
  const html = renderLinkChecks(state({ urlDraft: '\"><script>alert(1)</script>', siteReport: r }), helpers);
  assert.equal(/<script>|<iframe|<img src=x/.test(html), false);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(/href=["']https?:/i.test(html), false);
  assert.equal(/src=["']https?:/i.test(html), false);
});
