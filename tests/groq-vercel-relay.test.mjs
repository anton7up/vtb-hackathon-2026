import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRelay } from '../groq-relay/api/groq.mjs';

const endpoint = 'https://relay.example/api/groq';
const runtime = { GROQ_API_KEY: 'gsk_test_only', RELAY_TOKEN: 'relay_test_only' };

test('Vercel relay health check never exposes configuration', async () => {
  const response = await handleRelay(new Request(endpoint), runtime);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('Vercel relay requires its independent token', async () => {
  const response = await handleRelay(new Request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), runtime);
  assert.equal(response.status, 401);
});

test('Vercel relay forwards authenticated JSON using only its server-side Groq key', async () => {
  let upstream;
  const response = await handleRelay(new Request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-VTB-Relay-Token': 'relay_test_only' },
    body: JSON.stringify({ model: 'test-model' }),
  }), runtime, async (url, init) => {
    upstream = { url, init };
    return new Response('{"choices":[]}', { status: 200 });
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(upstream.init.headers.Authorization, 'Bearer gsk_test_only');
  assert.deepEqual(JSON.parse(upstream.init.body), { model: 'test-model' });
});
