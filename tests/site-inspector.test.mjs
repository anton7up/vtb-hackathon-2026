import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { scanTarget, publicAddress, pinnedDestination, canonicalAddress } from '../server/scanner/policy.mjs';
import { fetchPage, requestPinned, MAX_HTML_BYTES } from '../server/scanner/fetch-page.mjs';
import { analyzePage } from '../server/scanner/analyze.mjs';
import { createInspector } from '../server/scanner/service.mjs';
import { DEMO_SCENARIOS } from '../server/scanner/fixtures.mjs';
import { renderInspection, validReport } from '../public/site-inspection.mjs';

const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
const signal = () => AbortSignal.timeout(2000);
const page = (html, finalUrl = 'https://www.shop.example/') => analyzePage({ inputUrl: finalUrl, finalUrl, html, trace: [{ url: finalUrl, status: 200 }] });

test('network policy rejects local/special targets, encoded IPs, non-HTTP schemes and ports', () => {
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://localhost./', 'http://router.local/', 'http://box.home.arpa/', 'http://abc.test/', 'http://abc.example/', 'http://printer/', 'https://8.8.8.8:444/', 'file:///etc/passwd', 'https://user:pass@site.com/', 'https://site.com/\nnext']) assert.throws(() => scanTarget(url), undefined, url);
  for (const value of ['0.0.0.0', '100.64.0.1', '192.168.1.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', 'fc00::1', 'fe80::1', '2001:db8::1', '64:ff9b::7f00:1']) assert.equal(publicAddress(value), false, value);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  assert.equal(scanTarget('https://example.com/').hostname, 'example.com');
  assert.equal(canonicalAddress('::ffff:8.8.8.8'), canonicalAddress('8.8.8.8'));
});

test('all DNS answers must be public; redirects repeat validation and never access local services', async () => {
  for (const records of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }], [{ address: '198.18.2.23', family: 4 }]]) await assert.rejects(pinnedDestination(scanTarget('https://shop.com/'), signal(), async () => records), { code: 'non_public_dns' });
  assert.equal((await pinnedDestination(scanTarget('https://shop.com/'), signal(), publicDns)).address, '8.8.8.8');
  let calls = 0;
  await assert.rejects(fetchPage('https://shop.com/', { resolver: publicDns, requester: async () => { calls++; return { status: 302, location: 'http://127.0.0.1/private' }; } }), { code: 'blocked_target' });
  assert.equal(calls, 1);
  await assert.rejects(fetchPage('https://shop.com/', { resolver: publicDns, requester: async () => ({ status: 302, location: 'https://next.com/' }) }), { code: 'redirect_loop' });
  let index = 0;
  await assert.rejects(fetchPage('https://shop.com/', { resolver: publicDns, requester: async () => ({ status: 302, location: `https://next.com/${index++}` }) }), { code: 'too_many_redirects' });
});

test('DNS and fetching respect cancellation; successful trace strips query tokens', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchPage('https://shop.com/', { signal: controller.signal, resolver: publicDns }), { code: 'timeout' });
  const result = await fetchPage('https://shop.com/?secret=test', { resolver: publicDns, requester: async t => t.hostname === 'shop.com' ? { status: 302, location: 'https://store.com/?token=private' } : { status: 200, html: '<h1>Hello</h1>', bytes: 14 } });
  assert.equal(result.trace.length, 2); assert.equal(JSON.stringify(result.trace).includes('private'), false); assert.equal(JSON.stringify(result.trace).includes('secret'), false);
});

function fakeTransport({ headers = { 'content-type': 'text/html' }, chunks = [Buffer.from('<h1>Demo</h1>')], remote = '8.8.8.8', status = 200 } = {}) {
  let captured;
  const transport = (url, options, callback) => {
    captured = { url, options };
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = error => req.emit('error', error);
    req.end = () => queueMicrotask(() => { const res = Readable.from(chunks); res.socket = { remoteAddress: remote }; res.headers = headers; res.statusCode = status; callback(res); });
    return req;
  };
  return { transports: { httpRequest: transport, httpsRequest: transport }, get captured() { return captured; } };
}
test('transport pins connection DNS, validates the real remote address and never forwards bank headers', async () => {
  const fake = fakeTransport();
  const r = await requestPinned(scanTarget('https://shop.com/'), { address: '8.8.8.8', family: 4 }, signal(), fake.transports);
  assert.equal(r.html, '<h1>Demo</h1>');
  const o = fake.captured.options;
  assert.equal(o.agent, false); assert.equal(o.rejectUnauthorized, true);
  assert.deepEqual(Object.keys(o.headers).sort(), ['Accept', 'Accept-Encoding', 'User-Agent'].sort());
  o.lookup('shop.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  o.lookup('shop.com', { all: true }, (error, records) => assert.deepEqual(records, [{ address: '8.8.8.8', family: 4 }]));
  await assert.rejects(requestPinned(scanTarget('https://shop.com/'), { address: '8.8.8.8', family: 4 }, signal(), fakeTransport({ remote: '127.0.0.1' }).transports), { code: 'blocked_target' });
});

test('response limits reject oversized bodies, compression, non-HTML and access restrictions', async () => {
  for (const [options, code] of [
    [{ chunks: [Buffer.alloc(MAX_HTML_BYTES + 1)] }, 'too_large'],
    [{ headers: { 'content-type': 'text/html', 'content-length': String(MAX_HTML_BYTES + 1) } }, 'too_large'],
    [{ headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } }, 'unsupported_encoding'],
    [{ headers: { 'content-type': 'application/pdf' } }, 'not_html'],
    [{ status: 403 }, 'access_restricted'],
  ]) await assert.rejects(requestPinned(scanTarget('https://shop.com/'), { address: '8.8.8.8', family: 4 }, signal(), fakeTransport(options).transports), { code });
});

test('analyzer identifies brand impersonation, sensitive fields and declared destination, without sending forms', () => {
  const d = DEMO_SCENARIOS.brand_clone, r = page(d.html, d.url);
  assert.equal(r.verdict, 'high_risk'); assert.equal(r.source, 'live');
  assert.equal(r.forms[0].action, 'https://collector.example/receive');
  assert.deepEqual(r.forms[0].sensitive_fields, ['password', 'otp']);
  assert.equal(r.findings.some(f => f.code === 'BRAND_CREDENTIALS'), true);
  assert.equal(r.brands[0].domain_match, false);
  assert.equal(JSON.stringify(r).includes('token=demo'), false);
});

test('synthetic shop clone combines a brand mismatch, sensitive payment fields and an external destination', () => {
  const d = DEMO_SCENARIOS.shop_clone, r = page(d.html, d.url);
  assert.equal(r.status, 'completed'); assert.equal(r.verdict, 'high_risk');
  assert.equal(r.source, 'live');
  assert.equal(r.brands.some(b => b.name.toLowerCase() === 'ozon' && b.domain_match === false), true);
  assert.equal(r.findings.some(f => f.code === 'BRAND_MISMATCH'), true);
  assert.equal(r.findings.some(f => f.code === 'BRAND_CREDENTIALS' && f.severity === 'high'), true);
  assert.equal(r.findings.some(f => f.code.startsWith('FORM_EXTERNAL_')), true);
  const form = r.forms.find(f => f.action === 'https://collector.example/payment');
  assert.ok(form); assert.equal(form.method.toLowerCase(), 'post');
  assert.equal(form.external, true); assert.equal(form.unknown_external, true);
  assert.deepEqual([...form.sensitive_fields].sort(), ['card', 'cvv', 'otp']);
  assert.equal('allowed' in r, false); assert.equal('probability' in r, false);
});

test('HTML5 entities, base URL, button overrides and externally associated form inputs are considered', () => {
  const r = page('<title>&#1042;&#1058;&#1041; официальный сайт</title><base href="https://external.example/"><h1>Проверка</h1><form id="f" action="/send" method="post"><button formaction="http://other.example/receive">Отправить</button></form><label for="secret">Пароль</label><input id="secret" form="f" type="password" value="SECRET_TEST_VALUE">');
  assert.equal(r.forms[0].action, 'https://external.example/send'); assert.equal(r.forms[0].override_count, 1); assert.equal(r.forms[0].insecure, true);
  assert.equal(r.verdict, 'high_risk'); assert.equal(JSON.stringify(r).includes('SECRET_TEST_VALUE'), false);
});

test('a brand mention, valid HTTPS, known payment provider or benign HTML never grants unconditional safety', () => {
  const r = page('<title>adidas — независимый продавец</title><h1>Обувь adidas</h1><p>Доставка, возврат, контакты.</p><form action="https://api.cloudpayments.ru/pay" method="post"><input autocomplete="cc-number"><input autocomplete="cc-csc"></form>');
  assert.equal(r.findings.some(f => f.severity === 'high'), false);
  assert.equal(r.forms[0].unknown_external, false);
  assert.equal(r.verdict, 'review');
  assert.equal('allowed' in r, false); assert.equal('probability' in r, false);
  const official = page('<title>ВТБ</title><h1>ВТБ</h1><form method="post"><input type="password"></form>', 'https://www.vtb.ru/');
  assert.equal(official.brands[0].domain_match, true); assert.equal(official.findings.some(f => f.code === 'BRAND_CREDENTIALS'), false);
});

test('CAPTCHA/JS-only pages remain unavailable and hidden scripts cannot issue scanner instructions', () => {
  const d = DEMO_SCENARIOS.challenge;
  assert.equal(page(d.html, d.url).verdict, null);
  assert.equal(page('<title>App</title><div id="root"></div><script src="app.js"></script>').status, 'unavailable');
  const safe = page('<title>Магазин</title><h1>Каталог</h1><script>process.env.GROQ_API_KEY; fetch("http://localhost"); безопасный счёт</script><div hidden>безопасный счёт</div><p>Товары и условия доставки.</p>');
  assert.equal(safe.findings.some(f => f.code === 'SAFE_ACCOUNT'), false);
});

test('isolated worker runs four honest offline demos and blocks local live URLs', async () => {
  const inspector = createInspector();
  const clone = await inspector({ demoScenario: 'brand_clone' });
  assert.equal(clone.source, 'demo_fixture'); assert.equal(clone.verdict, 'high_risk');
  const shop = await inspector({ demoScenario: 'shop_clone' });
  assert.equal(shop.source, 'demo_fixture'); assert.equal(shop.verdict, 'high_risk');
  assert.equal(shop.input_url, 'https://ozon-sale.example/checkout');
  assert.deepEqual([...shop.forms[0].sensitive_fields].sort(), ['card', 'cvv', 'otp']);
  const ordinary = await inspector({ demoScenario: 'ordinary_shop' });
  assert.equal(ordinary.verdict, 'no_signals'); assert.equal(ordinary.forms[0].sensitive_fields.length, 0);
  const challenge = await inspector({ demoScenario: 'challenge' });
  assert.equal(challenge.status, 'unavailable'); assert.equal(challenge.verdict, null);
  const blocked = await inspector({ url: 'http://127.0.0.1:3000/api/state' });
  assert.equal(blocked.error_code, 'blocked_target'); assert.equal(blocked.verdict, null);
});

test('report renderer escapes all untrusted text and never embeds target HTML or clickable addresses', () => {
  const escape = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const d = DEMO_SCENARIOS.brand_clone, r = page(d.html, d.url);
  r.title = '<img src=x onerror=alert(1)>'; r.findings[0].evidence = '</code><script>alert(1)</script>';
  const html = renderInspection(r, { esc: escape, date: () => 'test' });
  assert.equal(html.includes('<script>'), false); assert.equal(html.includes('<img src=x'), false); assert.equal(html.includes('href='), false);
  assert.match(html, /&lt;img/); assert.equal(validReport(r), true);
  assert.equal(validReport({ ...r, status: 'unavailable', verdict: 'no_signals' }), false);
});
