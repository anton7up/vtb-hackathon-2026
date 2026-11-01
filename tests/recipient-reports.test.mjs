import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../lib/bank-engine.mjs';
import {
  createFraudReport, reserveReportTurn, finishReportTurn, submitFraudReport,
  withdrawFraudReport, reviewFraudReport, REPORT_PENDING_MS, REPORT_LIMITS,
} from '../lib/recipient-reports.mjs';

const NOW = 1000000;
const setup = () => {
  const state = initialState(NOW);
  const report = createFraudReport(state, 'HISTORY-1', NOW);
  return { state, report };
};
const assessment = { summary: 'Клиент сообщил о возможном обмане.', category: 'qr_substitution', next_question: 'Кто предоставил QR?', source: 'groq', model_version: 'qwen/test', prompt_version: 'report-1' };
const body = (report, suffix = '01', message = 'Оплатил товар, но его не получил') => ({ reportId: report.id, message, consent: true, requestId: `report-request-${suffix}` });

test('report copies the own completed operation, ignoring any spoofed payee or amount', () => {
  const state = initialState(NOW);
  const report = createFraudReport(state, 'HISTORY-1', NOW, { recipientId: 'FAKE', recipientName: 'Fake', amount: 1 });
  assert.match(report.id, /^FRAUD-[0-9a-f-]{36}$/);
  assert.equal(report.recipientId, 'DEMO-FAMILY-001');
  assert.equal(report.recipientName, 'Мама');
  assert.equal(report.amount, 300000);
  assert.equal(report.status, 'draft');
  assert.equal(report.review, null);
  assert.equal(report.assessment, null);
  assert.equal(state.balance, initialState(NOW).balance);
});

test('one report per operation is idempotent in all lifecycle states', () => {
  const { state, report } = setup();
  assert.equal(createFraudReport(state, 'HISTORY-1', NOW + 1), report);
  submitFraudReport(state, report.id, 'Товар не доставлен', NOW + 1);
  reviewFraudReport(state, report.id, 'block', 'Проведена проверка обращения', NOW + 2, 'employee');
  assert.equal(createFraudReport(state, 'HISTORY-1', NOW + 3), report);
  assert.equal(state.fraudReports.length, 1);
});

test('unknown, another-account, cash and unfinished operations cannot be reported', () => {
  const state = initialState(NOW);
  state.operations.push(...['cash', 'pending', 'blocked'].map((kind, index) => ({ id: `bad-${index}`, kind: kind === 'cash' ? 'cash' : 'transfer', status: kind === 'cash' ? 'completed' : kind, recipientId: 'DEMO-X', recipientName: 'Demo', amount: 100 })));
  for (const id of ['MISSING', 'OTHER-ACCOUNT-OP', 'bad-0', 'bad-1', 'bad-2', { id: 'HISTORY-1' }]) assert.throws(() => createFraudReport(state, id, NOW), /^Error: Нет /);
  assert.equal(state.fraudReports, undefined);
});

test('draft and total limits never delete existing reports and still allow duplicate access', () => {
  const { state, report } = setup();
  for (let i = 1; i < REPORT_LIMITS.drafts; i++) state.fraudReports.push({ id: `old-${i}`, operationId: `old-op-${i}`, status: 'draft' });
  assert.throws(() => createFraudReport(state, 'HISTORY-2', NOW), /черновик/);
  assert.equal(createFraudReport(state, 'HISTORY-1', NOW), report);
  state.fraudReports = Array.from({ length: REPORT_LIMITS.reports }, (_, i) => ({ id: `old-${i}`, operationId: `old-op-${i}`, status: 'dismissed' }));
  assert.throws(() => createFraudReport(state, 'HISTORY-2', NOW), /ещё одну жалобу/);
  assert.equal(state.fraudReports.length, REPORT_LIMITS.reports);
});

test('AI reserve validates consent, length, report and request identifier', () => {
  const { state, report } = setup();
  for (const value of [null, { ...body(report), consent: false }, { ...body(report), message: ' ' }, { ...body(report), message: 'x'.repeat(1201) }, { ...body(report), requestId: 'short' }, { ...body(report), message: 42 }]) {
    assert.throws(() => reserveReportTurn(state, value, NOW, NOW), /^Error: Укажите /);
  }
  assert.throws(() => reserveReportTurn(state, { ...body(report), reportId: 'missing' }, NOW, NOW), /^Error: Нет /);
  assert.equal(report.turns.length, 0);
});

test('AI text is redacted before storage and request retry never creates another turn', () => {
  const { state, report } = setup();
  const request = body(report, '01', 'Связь test@example.com, +7 999 123-45-67, карта 4444 3333 2222 1111, код 123456, https://bad.example/secret');
  const first = reserveReportTurn(state, request, NOW, NOW);
  assert.equal(first.cached, false);
  assert.doesNotMatch(first.turn.message, /test@example|999 123|4444|123456|https:/);
  assert.match(first.turn.message, /скрыт/);
  assert.equal(reserveReportTurn(state, request, NOW + 1, NOW + 1).cached, true);
  assert.equal(report.turns.length, 1);
  assert.throws(() => reserveReportTurn(state, { ...request, message: 'Другой ответ' }, NOW + 1, NOW + 1), /новый идентификатор/);
});

test('pending blocks concurrent turns, submit and withdraw, but expires at 45 seconds', () => {
  const { state, report } = setup();
  reserveReportTurn(state, body(report), NOW, NOW);
  assert.throws(() => reserveReportTurn(state, body(report, '02'), NOW + 1, NOW + 1), /^Error: Дождитесь /);
  assert.throws(() => submitFraudReport(state, report.id, 'Описание', NOW + 1), /^Error: Дождитесь /);
  assert.throws(() => withdrawFraudReport(state, report.id, NOW + 1), /^Error: Дождитесь /);
  const next = reserveReportTurn(state, body(report, '02'), NOW + REPORT_PENDING_MS, NOW + REPORT_PENDING_MS);
  assert.equal(report.turns[0].status, 'error');
  assert.equal(next.turn.status, 'processing');
});

test('accelerating the demo clock does not bypass a live AI pending guard', () => {
  const { state, report } = setup();
  reserveReportTurn(state, body(report), NOW, NOW);
  state.offsetMs = 24 * 60 * 60 * 1000;
  assert.throws(() => submitFraudReport(state, report.id, 'Описание', NOW + state.offsetMs + 1), /Дождитесь/);
  assert.throws(() => withdrawFraudReport(state, report.id, NOW + state.offsetMs + 1), /Дождитесь/);
});

test('cached stale request is marked timed out and is not retried with the old identifier', () => {
  const { state, report } = setup();
  reserveReportTurn(state, body(report), NOW, NOW);
  const retry = reserveReportTurn(state, body(report), NOW + REPORT_PENDING_MS, NOW + REPORT_PENDING_MS);
  assert.equal(retry.cached, true);
  assert.equal(retry.turn.status, 'error');
  assert.equal(report.turns.length, 1);
});

test('Qwen summary is redacted and cannot moderate the report or alter registry/balance', () => {
  const { state, report } = setup();
  const before = JSON.stringify({ registry: state.registryAdditions, balance: state.balance, operations: state.operations });
  reserveReportTurn(state, body(report), NOW, NOW);
  finishReportTurn(state, report.id, body(report).requestId, { ...assessment, summary: 'Пишите test@example.com', next_question: 'Код 123456?', status: 'blocked', class: 'block', registryAdditions: [{ recipient_id: 'DEMO-FAMILY-001' }] }, null, NOW + 1);
  assert.equal(report.status, 'draft');
  assert.equal(report.turns[0].status, 'done');
  assert.match(report.assessment.summary, /email скрыт/);
  assert.doesNotMatch(report.assessment.next_question, /123456/);
  assert.equal(report.assessment.class, undefined);
  assert.equal(report.assessment.status, undefined);
  assert.equal(report.review, null);
  assert.equal(JSON.stringify({ registry: state.registryAdditions, balance: state.balance, operations: state.operations }), before);
  assert.doesNotMatch(JSON.stringify(state.events), /test@example|123456|Оплатил товар/);
});

test('invalid or failed model responses record a bounded safe error and preserve report status', () => {
  const { state, report } = setup();
  reserveReportTurn(state, body(report), NOW, NOW);
  finishReportTurn(state, report.id, body(report).requestId, { category: 'bad', summary: 'Bad', next_question: null }, null, NOW + 1);
  assert.equal(report.turns[0].status, 'error');
  assert.equal(report.assessment, null);
  assert.equal(report.status, 'draft');
  reserveReportTurn(state, body(report, '02'), NOW + 2, NOW + 2);
  finishReportTurn(state, report.id, body(report, '02').requestId, null, 'provider-secret-raw-error', NOW + 3);
  assert.doesNotMatch(JSON.stringify(report), /provider-secret/);
  submitFraudReport(state, report.id, '', NOW + 4);
  assert.equal(report.status, 'submitted');
});

test('four successful answers end questions and six attempts cap repeated model errors', () => {
  const { state, report } = setup();
  for (let i = 0; i < REPORT_LIMITS.validTurns; i++) {
    const request = body(report, `${i}`);
    reserveReportTurn(state, request, NOW + i * 2, NOW + i * 2);
    finishReportTurn(state, report.id, request.requestId, assessment, null, NOW + i * 2 + 1);
  }
  assert.equal(report.assessment.next_question, null);
  assert.throws(() => reserveReportTurn(state, body(report, 'last'), NOW + 100, NOW + 100), /Нет возможности/);
  const failed = setup();
  for (let i = 0; i < REPORT_LIMITS.attempts; i++) {
    const request = body(failed.report, `${i}`);
    reserveReportTurn(failed.state, request, NOW + i * 2, NOW + i * 2);
    finishReportTurn(failed.state, failed.report.id, request.requestId, null, 'timeout', NOW + i * 2 + 1);
  }
  assert.throws(() => reserveReportTurn(failed.state, body(failed.report, 'last'), NOW + 100, NOW + 100), /Нет возможности/);
});

test('late or repeated model finish never overwrites a newer result, reset, submitted or withdrawn report', () => {
  const { state, report } = setup();
  const old = body(report, 'old');
  const fresh = body(report, 'fresh');
  reserveReportTurn(state, old, NOW, NOW);
  reserveReportTurn(state, fresh, NOW + REPORT_PENDING_MS, NOW + REPORT_PENDING_MS);
  finishReportTurn(state, report.id, fresh.requestId, { ...assessment, summary: 'Новый ответ' }, null, NOW + REPORT_PENDING_MS + 1);
  finishReportTurn(state, report.id, old.requestId, { ...assessment, summary: 'Поздний ответ' }, null, NOW + REPORT_PENDING_MS + 2);
  assert.equal(report.assessment.summary, 'Новый ответ');
  const serialized = JSON.stringify(report);
  finishReportTurn(state, report.id, fresh.requestId, { ...assessment, summary: 'Повтор' }, null, NOW + REPORT_PENDING_MS + 3);
  assert.equal(JSON.stringify(report), serialized);
  submitFraudReport(state, report.id, '', NOW + REPORT_PENDING_MS + 4);
  const closed = JSON.stringify(report);
  finishReportTurn(state, report.id, old.requestId, assessment, null, NOW + REPORT_PENDING_MS + 5);
  assert.equal(JSON.stringify(report), closed);
  state.fraudReports = [];
  assert.equal(finishReportTurn(state, report.id, old.requestId, assessment, null, NOW + REPORT_PENDING_MS + 6), null);
  const withdrawn = setup();
  reserveReportTurn(withdrawn.state, body(withdrawn.report), NOW, NOW);
  withdrawFraudReport(withdrawn.state, withdrawn.report.id, NOW + REPORT_PENDING_MS);
  finishReportTurn(withdrawn.state, withdrawn.report.id, body(withdrawn.report).requestId, assessment, null, NOW + REPORT_PENDING_MS + 1);
  assert.equal(withdrawn.report.status, 'withdrawn');
  assert.equal(withdrawn.report.assessment, null);
});

test('a response arriving after timeout cannot complete even if no newer turn was reserved', () => {
  const { state, report } = setup();
  reserveReportTurn(state, body(report), NOW, NOW);
  finishReportTurn(state, report.id, body(report).requestId, assessment, null, NOW + REPORT_PENDING_MS);
  assert.equal(report.turns[0].status, 'error');
  assert.equal(report.assessment, null);
});

test('a complaint can be submitted without AI and personal details are redacted', () => {
  const { state, report } = setup();
  assert.throws(() => submitFraudReport(state, report.id, ' ', NOW), /Укажите описание/);
  assert.throws(() => submitFraudReport(state, report.id, 12345, NOW), /Укажите описание/);
  submitFraudReport(state, report.id, 'Обманули, контакт test@example.com', NOW + 1);
  assert.equal(report.status, 'submitted');
  assert.match(report.note, /email скрыт/);
  assert.equal(report.turns.length, 0);
  assert.throws(() => submitFraudReport(state, report.id, 'Повторная жалоба', NOW + 2), /Нет черновика/);
  assert.doesNotMatch(JSON.stringify(state.events), /Обманули|test@example/);
});

test('saved client answers suffice for submission without a successful model result', () => {
  const { state, report } = setup();
  reserveReportTurn(state, body(report), NOW, NOW);
  finishReportTurn(state, report.id, body(report).requestId, null, 'not_configured', NOW + 1);
  submitFraudReport(state, report.id, '', NOW + 2);
  assert.equal(report.note, 'Оплатил товар, но его не получил');
  assert.equal(report.status, 'submitted');
});

test('only submitted complaints are moderated; review is auditable and never mutates registry', () => {
  const { state, report } = setup();
  assert.throws(() => reviewFraudReport(state, report.id, 'watch', 'Есть основания для проверки', NOW, 'employee'), /Нет отправленной/);
  submitFraudReport(state, report.id, 'Описание ситуации', NOW);
  for (const [verdict, status, revision] of [['watch', 'watch', 1], ['block', 'blocked', 2], ['dismiss', 'dismissed', 3]]) {
    reviewFraudReport(state, report.id, verdict, 'Проверено, test@example.com скрывается', NOW + revision, 'employee');
    assert.equal(report.status, status);
    assert.equal(report.review.verdict, verdict);
    assert.equal(report.review.decidedAt, NOW + revision);
    assert.equal(report.review.decidedBy, 'employee');
    assert.equal(report.review.revision, revision);
    assert.equal(report.reviewRevision, revision);
    assert.match(report.review.comment, /email скрыт/);
    assert.deepEqual(state.registryAdditions, []);
  }
  assert.throws(() => reviewFraudReport(state, report.id, 'block', 'Повторное решение', NOW + 4, 'employee'), /Нет отправленной/);
});

test('invalid moderation verdict and missing comments are rejected without changing status', () => {
  const { state, report } = setup();
  submitFraudReport(state, report.id, 'Описание ситуации', NOW);
  assert.throws(() => reviewFraudReport(state, report.id, 'fraudster', 'Комментарий', NOW, 'employee'), /Выберите/);
  for (const comment of [null, ' ', 'ab', 'x'.repeat(1001)]) assert.throws(() => reviewFraudReport(state, report.id, 'block', comment, NOW, 'employee'), /Укажите/);
  assert.equal(report.status, 'submitted');
  assert.equal(report.review, null);
});

test('withdrawal is allowed before moderation but never reverses an employee decision', () => {
  for (const submit of [false, true]) {
    const { state, report } = setup();
    if (submit) submitFraudReport(state, report.id, 'Описание', NOW);
    withdrawFraudReport(state, report.id, NOW + 1);
    assert.equal(report.status, 'withdrawn');
    assert.throws(() => reserveReportTurn(state, body(report), NOW + 2, NOW + 2), /Нет открытого/);
    assert.throws(() => reviewFraudReport(state, report.id, 'block', 'Комментарий', NOW + 2, 'employee'), /Нет отправленной/);
  }
  for (const verdict of ['watch', 'block', 'dismiss']) {
    const { state, report } = setup();
    submitFraudReport(state, report.id, 'Описание', NOW);
    reviewFraudReport(state, report.id, verdict, 'Комментарий', NOW + 1, 'employee');
    const before = JSON.stringify(report);
    assert.throws(() => withdrawFraudReport(state, report.id, NOW + 2), /решение сотрудника/i);
    assert.equal(JSON.stringify(report), before);
  }
});
