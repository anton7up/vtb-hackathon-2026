import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUrlScorer, scoreUrlText, normalizeCheckUrl, checkPhishingUrl } from '../lib/url-phishing-model.mjs';
import artifact from '../lib/phishing-model.json' with { type: 'json' };

const synthetic = JSON.parse(readFileSync(new URL('./fixtures/phishing-synthetic-parity.json', import.meta.url), 'utf8'));
test('exported model reproduces Python predictions for synthetic/Unicode cases', () => {
  for (const example of synthetic) {
    const actual = scoreUrlText(example.url);
    assert.equal(actual.label, example.label);
    assert.ok(Math.abs(actual.phishing_score - example.phishing_score) < 1e-10);
    assert.equal(actual.source, 'ml');
  }
});
test('invalid URLs and credentials are rejected without network access', () => {
  for (const value of [null, {}, '', 'example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com/', 'https://example.com/\nlogin', 'https://example.com/' + 'a'.repeat(2049), 'https://example.com/\ud800']) assert.throws(() => normalizeCheckUrl(value), e => e.code === 'invalid_url');
  assert.equal(normalizeCheckUrl('  https://EXAMPLE.com/Путь?q=A  '), 'https://EXAMPLE.com/Путь?q=A');
});
test('classification performs no target fetch and returns finite score, not a payment decision', () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network access forbidden'); };
  try {
    const result = checkPhishingUrl('https://shop.example/');
    assert.ok(result.phishing_score >= 0 && result.phishing_score <= 1);
    assert.equal(result.input_type, 'url_only');
    assert.equal('allowed' in result, false);
    assert.equal('url' in result, false);
  } finally { globalThis.fetch = original; }
});
test('incompatible model data is rejected rather than returning safe', () => {
  for (const bad of [{ ...artifact, classes: [1, 0] }, { ...artifact, intercept: NaN }, { ...artifact, idf: [] }, { ...artifact, parameters: { ...artifact.parameters, norm: 'l1' } }]) assert.throws(() => createUrlScorer(bad), e => e.code === 'model_unavailable');
});
