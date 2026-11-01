import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestId } from '../public/request-id.mjs';

test('uses native randomUUID when the secure-context API is available', () => {
  const expected = '912be112-4f5e-46ce-97ad-0ce1e68c9901';
  assert.equal(createRequestId({ randomUUID: () => expected }), expected);
});

test('creates a UUID v4 with getRandomValues when randomUUID is unavailable on HTTP', () => {
  const cryptoApi = { getRandomValues(bytes) { bytes.fill(0xab); return bytes; } };
  const id = createRequestId(cryptoApi);
  assert.equal(id, 'abababab-abab-4bab-abab-abababababab');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('fails explicitly when the browser has no cryptographic random source', () => {
  assert.throws(() => createRequestId({}), /Безопасный генератор/);
});
