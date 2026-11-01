import test from 'node:test';
import assert from 'node:assert/strict';
import { CBR_WARNING_DATA_URL, normalizeCbrCheckUrl, parseCbrWarningList, lookupCbrWarningDomain } from '../lib/cbr-warning-list.mjs';
import { createCbrWarningService } from '../server/cbr-warning-service.mjs';

const row = (overrides = {}) => ({ Id: 123, DT: '2026-10-29', Name: 'Учебный проект', Site: 'invest.example, www.invest.example', Sign: 'Признаки финансовой пирамиды', DateUpdate: '2026-10-30T10:00:00', ...overrides });
const payload = (rows = [row()]) => ({ RC: rows });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });

test('normalization supports bare domains and IDNA but does not collapse distinct subdomains', () => {
  assert.equal(normalizeCbrCheckUrl('  HTTPS://WWW.Invest.Example.:443/pay?secret=private#x  ').domain, 'invest.example');
  assert.equal(normalizeCbrCheckUrl('ривада.рф').domain, 'xn--80aaejr1c.xn--p1ai');
  assert.equal(normalizeCbrCheckUrl('pay.invest.example').domain, 'pay.invest.example');
  for (const input of [null, {}, '', 'localhost', 'https://127.0.0.1', 'https://[::1]', 'http://2130706433', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://invest.example', 'https://user:pass@invest.example', 'https://invest.example/\nsecret', 'https://invest.example\\@evil.example', 'https://-bad.example', 'https://bad-.example', 'https://bad..example', 'https://invest.example/' + 'x'.repeat(4096), 'https://invest.example/\ud800']) {
    assert.throws(() => normalizeCbrCheckUrl(input), error => error.code === 'invalid_url' && error.status === 400, String(input));
  }
});

test('exact hostname match resists suffix, prefix, userinfo and Unicode lookalikes', () => {
  const index = parseCbrWarningList(payload());
  assert.equal(lookupCbrWarningDomain(index, normalizeCbrCheckUrl('https://www.INVEST.example/payment?token=not-kept').domain).matchCount, 1);
  for (const host of ['invest.example.evil.test', 'evil-invest.example', 'pay.invest.example', 'example', 'іnvest.example']) {
    assert.equal(lookupCbrWarningDomain(index, host).matchCount, 0, host);
  }
  const result = lookupCbrWarningDomain(index, 'invest.example');
  result.matches[0].name = 'MUTATED';
  assert.equal(lookupCbrWarningDomain(index, 'invest.example').matches[0].name, 'Учебный проект');
});

test('official Site domains split on commas, semicolons and whitespace; scoped pages never label shared hosts', () => {
  const index = parseCbrWarningList(payload([row({ Site: 'https://one.example/; two.example\nривада.рф, www.one.example, vk.com/one-project, https://shared.example/?page=one, https://shared.example/#project, wildcard*.example' })]));
  assert.equal(index.domains.size, 3);
  assert.ok(index.domains.has('one.example'));
  assert.ok(index.domains.has('two.example'));
  assert.ok(index.domains.has(normalizeCbrCheckUrl('ривада.рф').domain));
  assert.equal(index.domains.has('vk.com'), false);
  assert.equal(index.domains.has('shared.example'), false);
});

test('parser enforces real export schema and fails closed on changed, empty or malformed datasets', () => {
  for (const value of [null, {}, [], { RC: [] }, { Data: [row()] }, payload([null]), payload([row({ Id: 0 })]), payload([row({ Id: '123' })]), payload([row({ Name: null })]), payload([row({ Site: [] })]), payload([row({ Site: undefined })]), payload([row({ Sign: undefined })]), payload([row({ Site: 'vk.com/scoped-only' })]), payload([row(), row()])]) {
    assert.throws(() => parseCbrWarningList(value), /invalid_dataset/);
  }
  assert.throws(() => parseCbrWarningList(payload([row(), row({ Id: 124 })]), { maxRecords: 1 }), /invalid_dataset/);
  const index = parseCbrWarningList(payload([row(), row({ Id: 124, Site: null })]));
  assert.equal(index.recordCount, 2);
  assert.equal(index.indexedRecords, 1);
});

test('service fetches only fixed official endpoint and does not send checked domain, path or query upstream', async () => {
  const requests = [];
  const service = createCbrWarningService({ now: () => 1000, fetchImpl: async (...args) => { requests.push(args); return jsonResponse(payload()); } });
  const found = await service.checkUrl('https://invest.example/private?secret=do-not-send');
  assert.equal(found.status, 'matched');
  assert.equal(found.domain, 'invest.example');
  assert.equal(found.matchCount, 1);
  assert.equal(found.source.url, 'https://www.cbr.ru/inside/warning-list/');
  assert.equal(found.dataFetchedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], CBR_WARNING_DATA_URL);
  assert.equal(requests[0][1].redirect, 'manual');
  assert.equal(requests[0][1].credentials, 'omit');
  assert.equal(JSON.stringify(requests).includes('invest.example'), false);
  assert.equal(JSON.stringify(found).includes('do-not-send'), false);
  const negative = await service.checkUrl('safe.example');
  assert.equal(negative.status, 'not_listed');
  assert.match(negative.message, /не означает.*безопасны/u);
  assert.equal(requests.length, 1);
});

test('concurrent cold requests share one fetch and expired copies are refreshed', async () => {
  let clock = 1000;
  let calls = 0;
  let release;
  const service = createCbrWarningService({ now: () => clock, cacheTtlMs: 100, fetchImpl: async () => { calls += 1; if (calls === 1) await new Promise(resolve => { release = resolve; }); return jsonResponse(payload()); } });
  const first = service.checkUrl('invest.example');
  const second = service.checkUrl('other.example');
  release();
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), ['matched', 'not_listed']);
  assert.equal(calls, 1);
  clock += 101;
  assert.equal((await service.checkUrl('invest.example')).status, 'matched');
  assert.equal(calls, 2);
});

test('invalid input does not fetch the official list', async () => {
  let calls = 0;
  const service = createCbrWarningService({ fetchImpl: async () => { calls += 1; return jsonResponse(payload()); } });
  await assert.rejects(service.checkUrl('file:///etc/passwd'), error => error.code === 'invalid_url');
  assert.equal(calls, 0);
});

test('redirects, malformed JSON, wrong media type, HTTP errors and changed schema are unavailable, never safe', async () => {
  const factories = [
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/data' } }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => new Response('<html>captcha</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('outage', { status: 503 }),
    () => jsonResponse({ Data: [row()] }),
    () => jsonResponse({ RC: [] }),
    () => { throw new Error('network secret which should not leak'); },
  ];
  for (const factory of factories) {
    const service = createCbrWarningService({ fetchImpl: async () => factory() });
    const result = await service.checkUrl('invest.example');
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.matches, []);
    assert.equal(result.dataFetchedAt, null);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('cross-origin/followed response cannot replace the official dataset', async () => {
  for (const kind of ['redirected', 'url']) {
    const response = jsonResponse(payload());
    Object.defineProperty(response, kind, { value: kind === 'url' ? 'https://attacker.example/data' : true });
    const result = await createCbrWarningService({ fetchImpl: async () => response }).checkUrl('invest.example');
    assert.equal(result.status, 'unavailable');
  }
});

test('rejected HTTP response aborts its transport instead of leaving the body open', async () => {
  let signal;
  const service = createCbrWarningService({ fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response('unread body', { status: 503 });
  } });
  assert.equal((await service.checkUrl('invest.example')).status, 'unavailable');
  assert.equal(signal.aborted, true);
});

test('declared and streamed body limits apply before parsing', async () => {
  const oversized = () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1000000' } });
  const streamed = () => new Response('x'.repeat(33), { headers: { 'content-type': 'application/json' } });
  for (const factory of [oversized, streamed]) {
    const result = await createCbrWarningService({ maxBytes: 32, fetchImpl: async () => factory() }).checkUrl('invest.example');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.errorCode, 'response_too_large');
  }
});

test('timeout also bounds a fetch implementation that never resolves', async () => {
  const service = createCbrWarningService({ timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  const result = await service.checkUrl('invest.example');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'timeout');
});

test('timeout bounds a stalled stream and signals cancellation', async () => {
  let signal;
  const service = createCbrWarningService({ timeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
  } });
  const result = await service.checkUrl('invest.example');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'timeout');
  assert.equal(signal.aborted, true);
});

test('outage backoff avoids repeated downloads and an expired snapshot never produces a negative verdict', async () => {
  let clock = 1000;
  let calls = 0;
  const service = createCbrWarningService({ now: () => clock, cacheTtlMs: 100, failureBackoffMs: 50, fetchImpl: async () => { calls += 1; if (calls > 1) throw new Error('outage'); return jsonResponse(payload()); } });
  assert.equal((await service.checkUrl('invest.example')).status, 'matched');
  clock += 101;
  const failed = await service.checkUrl('other.example');
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.dataFetchedAt, '1970-01-01T00:00:01.000Z');
  assert.equal((await service.checkUrl('invest.example')).status, 'unavailable');
  assert.equal(calls, 2);
  clock += 51;
  await service.checkUrl('other.example');
  assert.equal(calls, 3);
});

test('result limits repeated record domains and total matches without mutating cache', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => row({ Id: i + 1 }));
  const result = await createCbrWarningService({ fetchImpl: async () => jsonResponse(payload(rows)) }).checkUrl('invest.example');
  assert.equal(result.matchCount, 12);
  assert.equal(result.matches.length, 10);
});
