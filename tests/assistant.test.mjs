import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, validateAssessment, assessConversation, ASSISTANT_MODEL } from '../lib/anti-scam-model.mjs';

test('model result parser rejects invented classes, oversized explanations and ungrounded evidence', () => {
  const valid = { class: 'block', scenario: 'safe_account', explanation: 'Есть риск.', evidence: ['безопасный счёт'], next_question: null };
  assert.equal(validateAssessment(valid, ['Просят безопасный счёт'], 1).class, 'block');
  for (const value of [{ ...valid, class: 'approved' }, { ...valid, evidence: ['выдуманная цитата'] }, { ...valid, evidence: [] }, { ...valid, next_question: 'Отправить деньги?' }, { ...valid, explanation: 'x'.repeat(1401) }]) assert.throws(() => validateAssessment(value, ['Просят безопасный счёт'], 1));
});
test('intermediate question is always review and conversation ends after four answers', () => {
  const raw = { class: 'normal', scenario: 'unknown', explanation: 'Нужно уточнить.', evidence: [], next_question: 'Кто просит?' };
  assert.equal(validateAssessment(raw, ['Друг'], 1).class, 'review');
  assert.equal(validateAssessment(raw, ['Друг'], 4).next_question, null);
});
test('adapter sends only model context and dialogue, not its secret or arbitrary runtime fields', async () => {
  let packet;
  const c = { context: null, privatePhone: '+7 900 1234567', turns: [{ message: redact('Код 987654, карта 4111111111111111'), status: 'processing' }] };
  const result = await assessConversation(c, { GROQ_API_KEY: 'gsk_secret_for_unit_test', phone: 'private', fetcher: async (url, init) => {
    packet = JSON.parse(init.body);
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ class: 'review', scenario: 'unknown', explanation: 'Не хватает контекста.', evidence: [], next_question: null }) } }] }));
  } });
  assert.equal(result.source, 'groq'); assert.equal(result.model_version, ASSISTANT_MODEL);
  assert.equal(packet.response_format.json_schema.strict, true);
  for (const secret of ['gsk_secret_for_unit_test', 'privatePhone', '987654', '4111111111111111']) assert.equal(JSON.stringify(packet).includes(secret), false);
});
test('adapter rejects truncated JSON and refuses missing key without a request', async () => {
  const c = { context: null, turns: [{ message: 'Тест', status: 'processing' }] };
  await assert.rejects(assessConversation(c, {}), e => e.code === 'not_configured');
  await assert.rejects(assessConversation(c, { GROQ_API_KEY: 'fake', fetcher: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })) }), e => e.code === 'invalid_response');
});
