import assert from 'node:assert/strict';
import test from 'node:test';
import { groqTransport } from '../lib/groq-transport.mjs';

test('Groq transport defaults to the direct provider endpoint', () => {
  const result = groqTransport({ GROQ_API_KEY: 'gsk_test' });
  assert.equal(result.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(result.headers.Authorization, 'Bearer gsk_test');
  assert.equal('X-VTB-Relay-Token' in result.headers, false);
});

test('Groq transport supports an authenticated HTTPS relay', () => {
  const result = groqTransport({ GROQ_API_KEY: 'gsk_test', GROQ_API_URL: 'https://relay.example/openai/v1/chat/completions', GROQ_RELAY_TOKEN: 'relay-secret' });
  assert.equal(result.url, 'https://relay.example/openai/v1/chat/completions');
  assert.equal(result.headers['X-VTB-Relay-Token'], 'relay-secret');
});

test('Groq transport refuses insecure relay URLs', () => {
  assert.throws(() => groqTransport({ GROQ_API_KEY: 'gsk_test', GROQ_API_URL: 'http://relay.example/' }), /Invalid Groq API URL/);
});
