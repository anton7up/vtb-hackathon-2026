import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { parseDnsAnswers, queryDns, createCloudflareResolver } from '../server/scanner/dns-https.mjs';

const host = 'shop.example.com';
const ipv4 = '8.8.8.8', ipv6 = '2606:4700:4700::1111';
const answer = (name = host, type = 1, data = ipv4) => ({ name, type, TTL: 60, data });
const message = (type = 1, answers = [answer(host, type, type === 1 ? ipv4 : ipv6)], extra = {}) => ({ Status: 0, TC: false, Question: [{ name: host, type }], Answer: answers, ...extra });

function transport(options = {}) {
  const record = { calls: [], destroys: 0 };
  const request = (url, requestOptions, callback) => {
    const call = { url: new URL(url), options: requestOptions };
    record.calls.push(call);
    const req = new EventEmitter();
    req.setTimeout = (milliseconds, timeout) => { call.timeout = milliseconds; call.onTimeout = timeout; };
    req.destroy = error => { record.destroys++; req.emit('error', error || new Error('Destroyed')); };
    const abort = () => { const error = new Error('Aborted'); error.code = 'ABORT_ERR'; req.destroy(error); };
    req.end = () => {
      if (requestOptions.signal?.aborted) { queueMicrotask(abort); return; }
      if (options.stall) { requestOptions.signal?.addEventListener('abort', abort, { once: true }); return; }
      queueMicrotask(() => {
        const type = call.url.searchParams.get('type') === 'A' ? 1 : 28;
        const name = call.url.searchParams.get('name');
        const body = typeof options.body === 'function' ? options.body(name, type) : options.body ?? { ...message(type, [answer(name, type, type === 1 ? ipv4 : ipv6)]), Question: [{ name, type }] };
        const chunks = options.chunks ?? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
        const res = Readable.from(chunks);
        res.socket = { remoteAddress: options.remote ?? '1.1.1.1' };
        res.statusCode = options.status ?? 200;
        res.headers = { 'content-type': 'application/dns-json', ...options.headers };
        callback(res);
      });
    };
    return req;
  };
  return { request, record };
}

test('DNS JSON parser handles matching A and AAAA questions and only returns matching reachable records', () => {
  assert.deepEqual(parseDnsAnswers(message(1), host, 1), [{ address: ipv4, family: 4 }]);
  assert.deepEqual(parseDnsAnswers(message(28), host, 28), [{ address: ipv6, family: 6 }]);
  const mixed = message(1, [answer(`${host.toUpperCase()}.`), answer('unrelated.example.com'), answer(host, 28, ipv6)]);
  mixed.Question[0].name = `${host.toUpperCase()}.`;
  assert.deepEqual(parseDnsAnswers(mixed, host, 1), [{ address: ipv4, family: 4 }]);
  assert.deepEqual(parseDnsAnswers(message(1, []), host, 1), []);
});

test('CNAME traversal accepts bounded chains and rejects loops, conflicting targets and forbidden aliases', () => {
  const chain = length => {
    const names = [host, ...Array.from({ length }, (_, i) => `alias${i}.example.com`)];
    return [...names.slice(0, -1).map((name, i) => answer(name, 5, `${names[i + 1]}.`)), answer(names.at(-1))];
  };
  assert.deepEqual(parseDnsAnswers(message(1, chain(8)), host, 1), [{ address: ipv4, family: 4 }]);
  assert.throws(() => parseDnsAnswers(message(1, chain(9)), host, 1), { code: 'dns_failed' });
  assert.throws(() => parseDnsAnswers(message(1, [answer(host, 5, 'alias.example.com'), answer('alias.example.com', 5, host)]), host, 1), { code: 'dns_failed' });
  assert.throws(() => parseDnsAnswers(message(1, [answer(host, 5, 'one.example.com'), answer(host, 5, 'two.example.com')]), host, 1), { code: 'dns_failed' });
  assert.throws(() => parseDnsAnswers(message(1, [answer(host, 5, 'localhost')]), host, 1), { code: 'dns_failed' });
});

test('DNS parser rejects wrong questions, failure/truncation status and excessive or malformed records', () => {
  const invalid = [
    null, {}, message(1, [], { Status: 3 }), message(1, [], { TC: true }),
    message(1, [], { Question: [] }), message(1, [], { Question: [{ name: 'other.example.com', type: 1 }] }),
    message(1, [], { Question: [{ name: host, type: 28 }] }), message(1, [], { Question: [{ name: host, type: 1 }, { name: host, type: 28 }] }),
    message(1, [], { Question: [null] }), message(1, [], { Answer: {} }),
    message(1, Array.from({ length: 65 }, () => answer())), message(1, [null]), message(1, [answer(host, 16, 'text')]),
    message(1, [answer(host, 1, ipv6)]), message(28, [answer(host, 28, ipv4)]),
  ];
  for (const body of invalid) assert.throws(() => parseDnsAnswers(body, host, 1), { code: 'dns_failed' });
  assert.throws(() => parseDnsAnswers(message(28, [answer(host, 28, ipv4)]), host, 28), { code: 'dns_failed' });
});

test('every DNS address must be public, including unrelated or mixed-family answers', () => {
  for (const data of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '198.18.1.2', '::1', 'fc00::1']) {
    const type = data.includes(':') ? 28 : 1;
    assert.throws(() => parseDnsAnswers(message(1, [answer(), answer('unrelated.example.com', type, data)]), host, 1), { code: 'non_public_dns' }, data);
  }
});

test('DNS transport pins the fixed HTTPS endpoint and bootstrap, keeps certificate validation and sends no user headers', async () => {
  const mock = transport({ remote: '::ffff:1.1.1.1' });
  assert.deepEqual(await queryDns(host, 1, undefined, mock.request), [{ address: ipv4, family: 4 }]);
  const { url, options, timeout } = mock.record.calls[0];
  assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'cloudflare-dns.com'); assert.equal(url.pathname, '/dns-query');
  assert.equal(url.searchParams.get('name'), host); assert.equal(url.searchParams.get('type'), 'A');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['name', 'type']);
  assert.equal(options.method, 'GET'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.maxHeaderSize, 8192); assert.equal(timeout, 4000);
  assert.deepEqual(options.headers, { Accept: 'application/dns-json', 'Accept-Encoding': 'identity' });
  options.lookup('cloudflare-dns.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4); });
  options.lookup('cloudflare-dns.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]); });
});

test('DNS transport never follows redirects and rejects wrong peers, compression, content types and oversized/invalid bodies', async () => {
  for (const options of [
    { status: 302, headers: { location: 'http://127.0.0.1/private' } }, { status: 403 },
    { remote: '127.0.0.1' }, { remote: '8.8.8.8' }, { remote: 'malformed' },
    { headers: { 'content-type': 'text/html' } }, { headers: { 'content-encoding': 'gzip' } },
    { headers: { 'content-length': '32769' } }, { chunks: [Buffer.alloc(16384), Buffer.alloc(16385)] },
    { body: '{not JSON}' },
  ]) {
    const mock = transport(options);
    await assert.rejects(queryDns(host, 1, undefined, mock.request), { code: 'dns_failed' });
    assert.equal(mock.record.calls.length, 1);
  }
});

test('DNS transport passes cancellation to HTTPS and maps abort/socket timeout to timeout', async () => {
  const preAborted = new AbortController(), early = transport();
  preAborted.abort();
  await assert.rejects(queryDns(host, 1, preAborted.signal, early.request), { code: 'timeout' });
  assert.equal(early.record.calls.length, 0);
  const controller = new AbortController(), mock = transport({ stall: true });
  const pending = queryDns(host, 1, controller.signal, mock.request);
  assert.equal(mock.record.calls[0].options.signal, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'timeout' });
  assert.equal(mock.record.destroys, 1);
  const timeout = transport({ stall: true });
  const stalled = queryDns(host, 1, undefined, timeout.request);
  timeout.record.calls[0].onTimeout();
  await assert.rejects(stalled, { code: 'timeout' });
});

test('Cloudflare resolver asks for both families once per hostname, caches concurrent calls and checks cancellation before cache', async () => {
  const controller = new AbortController(), mock = transport();
  const resolver = createCloudflareResolver(controller.signal, mock);
  const [first, second] = await Promise.all([resolver(host), resolver(host)]);
  assert.deepEqual(first, [{ address: ipv4, family: 4 }, { address: ipv6, family: 6 }]);
  assert.deepEqual(second, first); assert.equal(mock.record.calls.length, 2);
  assert.deepEqual(mock.record.calls.map(c => c.url.searchParams.get('type')).sort(), ['A', 'AAAA']);
  assert.deepEqual(await resolver(host), first); assert.equal(mock.record.calls.length, 2);
  await resolver('other.example.com'); assert.equal(mock.record.calls.length, 4);
  controller.abort();
  await assert.rejects(resolver(host), { code: 'timeout' }); assert.equal(mock.record.calls.length, 4);
});

test('resolver rejects empty dual-family results, private family answers and invalid hostname targets', async () => {
  const empty = transport({ body: (name, type) => ({ ...message(type, []), Question: [{ name, type }] }) });
  await assert.rejects(createCloudflareResolver(undefined, empty)(host), { code: 'dns_failed' });
  const mixed = transport({ body: (name, type) => ({ ...message(type, [answer(name, type, type === 1 ? '198.18.3.4' : ipv6)]), Question: [{ name, type }] }) });
  await assert.rejects(createCloudflareResolver(undefined, mixed)(host), { code: 'non_public_dns' });
  const mock = transport(), resolver = createCloudflareResolver(undefined, mock);
  for (const name of ['localhost', 'box.local', 'user:secret@example.com', 'example.com/path']) await assert.rejects(resolver(name));
  assert.equal(mock.record.calls.length, 0);
});

test('resolver cancellation interrupts both in-flight family requests', async () => {
  const controller = new AbortController(), mock = transport({ stall: true });
  const pending = createCloudflareResolver(controller.signal, mock)(host);
  assert.equal(mock.record.calls.length, 2);
  controller.abort();
  await assert.rejects(pending, { code: 'timeout' });
  assert.equal(mock.record.destroys, 2);
});
