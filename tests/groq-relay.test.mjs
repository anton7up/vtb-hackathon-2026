import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRelayServer } from '../groq-relay/server.mjs';

let server;
let base;
let upstream;

before(async () => {
  server = createRelayServer({
    groqApiKey: 'gsk_test_only',
    relayToken: 'relay_test_only',
    fetcher: async (url, init) => {
      upstream = { url, init };
      return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise(resolve => server.close(resolve)));

test('relay exposes a health check without secrets', async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('relay rejects requests without its independent token', async () => {
  const response = await fetch(`${base}/openai/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
});

test('relay forwards only an authenticated JSON request with the server-side Groq key', async () => {
  const response = await fetch(`${base}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-VTB-Relay-Token': 'relay_test_only' },
    body: JSON.stringify({ model: 'test-model' }),
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(upstream.init.headers.Authorization, 'Bearer gsk_test_only');
  assert.deepEqual(JSON.parse(upstream.init.body), { model: 'test-model' });
});
