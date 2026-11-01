import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, evaluate, attempt, changeAccess, DAY } from '../lib/bank-engine.mjs';
import { decideReview, confirmReviewed } from '../lib/transfer-review.mjs';
import { reviewStatus } from '../public/review-assistant.mjs';

const now = 1800000000000;
const normal = { class: 'normal', source: 'mock', model_version: 'mock-v1' };
const request = { kind: 'transfer', recipientId: 'DEMO-NEW-001', recipientName: 'Учебный продавец', amount: 10000, classification: normal };
const watch = { recipient_id: request.recipientId, status: 'watch', reason: 'Рассмотрено обращение', reason_code: 'DEMO_COMPLAINT_WATCH', source: 'synthetic_complaint_review' };

test('a reviewed complaint invokes policy review, not a model prediction or automatic debit', () => {
  const state = initialState(now), balance = state.balance;
  const result = attempt(state, request, [watch], now);
  assert.equal(result.decision.code, 'MODEL_REVIEW');
  assert.equal(result.decision.classification.class, 'review');
  assert.equal(result.operation.classification.source, 'policy');
  assert.equal(result.operation.status, 'pending'); assert.equal(state.balance, balance);
  assert.match(reviewStatus(result.operation).title, /поступали жалобы/);
  assert.match(reviewStatus(result.operation).text, /не доказательство мошенничества/);
  assert.equal(evaluate(state, { ...request, kind: 'cash' }, [watch], now).allowed, true);
});

test('watch does not override the security lock, 24h pause, active stop-list or classifier failure/block', () => {
  const state = initialState(now);
  changeAccess(state, 'recovery', now);
  assert.equal(evaluate(state, request, [watch], now + 1).code, 'NEW_RECIPIENT_HOLD');
  state.securityLock = { at: now };
  assert.equal(evaluate(state, request, [watch], now + DAY).code, 'ACCOUNT_SECURITY_LOCK');
  state.securityLock = null;
  assert.equal(evaluate(state, request, [{ ...watch, status: 'active' }], now + DAY).code, 'RISK_REGISTRY');
  assert.equal(evaluate(state, { ...request, classification: null }, [watch], now + DAY).code, 'MODEL_UNAVAILABLE');
  assert.equal(evaluate(state, { ...request, classification: { ...normal, class: 'block' } }, [watch], now + DAY).code, 'MODEL_BLOCK');
});

test('staff may review a watched recipient, but only separate client confirmation debits once', () => {
  const state = initialState(now), balance = state.balance;
  const op = attempt(state, request, [watch], now).operation;
  decideReview(state, op.id, 'approve', 'Обстоятельства независимо проверены.', [watch], normal, now, now, 'Сотрудник');
  assert.equal(state.balance, balance);
  assert.equal(confirmReviewed(state, op.id, [watch], normal, now, now).decision.allowed, true);
  assert.equal(state.balance, balance - request.amount);
  assert.equal(confirmReviewed(state, op.id, [watch], normal, now, now).duplicate, true);
  assert.equal(state.balance, balance - request.amount);
});

test('a new or revised registry mark invalidates a previously obtained staff approval', () => {
  for (const initialEntries of [[], [watch]]) {
    const state = initialState(now), balance = state.balance;
    const op = attempt(state, { ...request, classification: { ...normal, class: 'review' } }, initialEntries, now).operation;
    decideReview(state, op.id, 'approve', 'Данные проверены сотрудником.', initialEntries, normal, now, now, 'Сотрудник');
    const changed = [{ ...watch, reason: 'Появились новые обстоятельства.' }];
    const result = confirmReviewed(state, op.id, changed, normal, now + 1, now + 1);
    assert.equal(result.decision.allowed, false); assert.equal(op.review.status, 'pending');
    assert.equal(state.balance, balance);
  }
});

test('invalid classifier output can never authorize a reviewed transfer', () => {
  const state = initialState(now);
  const op = attempt(state, { ...request, classification: { ...normal, class: 'review' } }, [], now).operation;
  assert.throws(() => decideReview(state, op.id, 'approve', 'Результат ещё не проверен.', [], { class: 'bogus' }, now, now, 'Сотрудник'));
});
