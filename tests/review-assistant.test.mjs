import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needsAssistantReview, reviewGreeting, reviewStatus } from '../public/review-assistant.mjs';

const pending = { kind: 'transfer', status: 'pending', code: 'MODEL_REVIEW', review: { status: 'pending' } };
test('assistant entry applies only to a transfer awaiting model review', () => {
  assert.equal(needsAssistantReview(pending), true);
  for (const op of [null, { ...pending, kind: 'cash' }, { ...pending, status: 'blocked' }, { ...pending, code: 'NEW_RECIPIENT_HOLD' }, { ...pending, code: 'MODEL_BLOCK' }]) assert.equal(!!needsAssistantReview(op), false);
});
test('official greeting explains suspicion without accusing recipient or authorizing payment', () => {
  const text = reviewGreeting('Анна Ковалёва');
  assert.match(text, /Здравствуйте, Анна Ковалёва/);
  assert.match(text, /предварительное подозрение/);
  assert.match(text, /Кто предложил перевод/);
});
test('review modal follows current operation state without lifting holds or paying', () => {
  assert.equal(reviewStatus(pending).canChat, true);
  assert.match(reviewStatus(pending).text, /Деньги не списаны/);
  for (const op of [null, { ...pending, status: 'blocked' }, { ...pending, status: 'completed' }, { ...pending, review: { status: 'approved' } }, { ...pending, code: 'AI_SCAM_BLOCK' }]) assert.equal(reviewStatus(op).canChat, false);
  assert.match(reviewStatus({ ...pending, review: { status: 'approved' } }).text, /отдельное подтверждение/);
});
test('review result offers an explicit AI action without opening the chat automatically', () => {
  const source = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /needsAssistantReview\(operation\)[^\n]+openAssistantDialog\(operation\)/);
  assert.match(source, /Перейти к проверке с ИИ/);
  assert.match(source, /Переводы на дополнительной проверке/);
  assert.match(source, /data-ai-operation=/);
});
