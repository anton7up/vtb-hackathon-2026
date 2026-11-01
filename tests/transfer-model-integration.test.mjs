import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransfer, transferModelPayload, TRANSFER_MODEL_FEATURES } from '../lib/transfer-classifier.mjs';

const now = Date.parse('2026-11-01T15:00:00Z');
const state = { balance: 24830000, operations: [
  { id: 'OLD', kind: 'transfer', recipientId: 'DEMO-OLD-001', amount: 300000, createdAt: now - 10000, status: 'completed' },
  { id: 'CURRENT', requestId: 'same-request', kind: 'transfer', recipientId: 'DEMO-NEW-001', amount: 500000, createdAt: now - 1000, status: 'pending' },
] };
const request = { id: 'CURRENT', requestId: 'same-request', kind: 'transfer', recipientId: 'DEMO-NEW-001', amount: 500000 };

test('model payload uses rubles, stable account identity and excludes the current retry', () => {
  const payload = transferModelPayload(state, request, now, 'client-demo-2');
  assert.deepEqual(payload.operation, { timestamp: '2026-11-01T15:00:00.000Z', sender_id: 'client-demo-2', sender_balance: 248300, amount: 5000, receiver_id: 'DEMO-NEW-001' });
  assert.equal(payload.history.length, 1);
  assert.equal(payload.history[0].amount, 3000);
});

test('trained service decision maps 0/1/2 to normal/review/block with ML metadata', async () => {
  for (const [decision, expected] of [[0, 'normal'], [1, 'review'], [2, 'block']]) {
    let sent;
    const runtime = { TRANSFER_MODEL_URL: 'http://127.0.0.1:8101/v1/classify', transferModelFetch: async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ decision, p_fraud: decision / 2, model_version: 'fraud-hgb-test', thresholds: { review: 0.14, block: 0.46 }, features: Object.fromEntries(TRANSFER_MODEL_FEATURES.map((name, index) => [name, index])) }), { status: 200 });
    } };
    const result = await classifyTransfer(state, request, now, runtime, 'client-demo-2');
    assert.equal(result.class, expected); assert.equal(result.source, 'ml'); assert.equal(result.model_version, 'fraud-hgb-test');
    assert.equal(result.model_features.receiver_tx_before, 11); assert.deepEqual(result.thresholds, { review: 0.14, block: 0.46 });
    assert.equal(sent.url, runtime.TRANSFER_MODEL_URL); assert.equal(sent.body.operation.sender_id, 'client-demo-2');
  }
});

test('configured model fails closed and never falls back to the demo classifier', async () => {
  const runtime = { TRANSFER_MODEL_URL: 'http://127.0.0.1:8101/v1/classify', transferModelFetch: async () => { throw new Error('offline'); } };
  assert.equal(await classifyTransfer(state, request, now, runtime), null);
  assert.equal(await classifyTransfer(state, request, now, { TRANSFER_MODEL_URL: 'https://remote.example/v1/classify', transferModelFetch: async () => new Response('{}') }), null);
});
