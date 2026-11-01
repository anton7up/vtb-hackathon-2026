import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComplaints, renderFraudStaff, reportStatus } from '../public/complaints-view.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const helpers = { esc, money: amount => `${amount / 100} ₽`, date: value => `date:${value}` };
const ui = overrides => ({ complaintId: 'REPORT-001', complaintDraft: '', complaintNote: '', complaintConsent: false, complaintBusy: false, complaintError: '', complaintConfigured: true, ...overrides });
const report = overrides => ({ id: 'REPORT-001', operationId: 'OP-001', recipientId: 'DEMO-RECIPIENT-001', recipientName: 'ООО Учебный получатель', amount: 300000, createdAt: 1000, updatedAt: 2000, status: 'draft', note: '', turns: [], assessment: null, review: null, ...overrides });
const renderClient = (item = report(), overrides = {}) => renderComplaints(ui(overrides), { fraudReports: [item] }, helpers);

test('saved answers need not be retyped and completed intake has no further chat form', () => {
  const html = renderClient(report({ turns: [{ status: 'done', message: 'Оплатил учебную покупку.', response: { summary: 'По словам клиента, заказ не пришёл.', next_question: null } }], assessment: { summary: 'По словам клиента, заказ не пришёл.', next_question: null } }));
  assert.match(html, /Опрос завершён/);
  assert.equal(html.includes('id="complaint-chat-form"'), false);
  assert.match(html, /Передать жалобу сотруднику/);
  assert.equal(/<textarea\b[^>]*id="complaint-note"[^>]*\brequired/.test(html), false);
});

test('fresh processing uses real startedAt rather than demo clock and expired work permits fallback', () => {
  const fresh = renderClient(report({ turns: [{ status: 'processing', startedAt: Date.now(), message: 'Учебная ситуация.' }] }));
  assert.match(fresh, /id="complaint-note"[^>]*disabled/);
  const expired = renderClient(report({ turns: [{ status: 'processing', startedAt: Date.now() - 46000, message: 'Учебная ситуация.' }] }));
  assert.equal(/id="complaint-note"[^>]*disabled/.test(expired), false);
});

test('client draft is attached to a read-only operation and has no staff moderation controls', () => {
  const html = renderClient();
  assert.match(html, /Получатель из операции/);
  assert.match(html, /ООО Учебный получатель/);
  assert.match(html, /3000 ₽/);
  assert.match(html, /OP-001/);
  assert.match(html, /Реквизиты уже привязаны к операции/);
  assert.match(html, /data-complaint-open="REPORT-001"/);
  assert.match(html, /data-complaint-withdraw="REPORT-001"/);
  assert.match(html, /data-page="history"/);
  assert.equal(/data-complaint-review|name="verdict"|name="comment"|data-report-registry-clear/.test(html), false);
  assert.equal(/<(?:input|textarea|select)[^>]*(?:name|id)="(?:recipientId|recipientName|amount|operationId)"/.test(html), false);
});

test('AI consent starts unchecked and the AI button remains disabled until consent', () => {
  const html = renderClient();
  const consent = html.match(/<input\b[^>]*id="complaint-consent"[^>]*>/)?.[0];
  assert.ok(consent);
  assert.match(consent, /type="checkbox"/);
  assert.equal(/\bchecked\b/.test(consent), false);
  assert.match(html, /внешний сервис Groq\/Qwen/);
  assert.match(html, /Автоматическое скрытие данных не гарантирует полной анонимности/);
  assert.match(html, /<button\b(?=[^>]*type="submit")(?=[^>]*disabled)[^>]*>Ответить помощнику/);
  const approved = renderClient(report(), { complaintConsent: true });
  assert.match(approved, /id="complaint-consent"[^>]*checked/);
  assert.match(approved, /<button type="submit" class="button"\s*>Ответить помощнику/);
});

test('manual submission is a separate form and does not require AI consent', () => {
  const html = renderClient();
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) || [];
  assert.equal(forms.length, 2);
  assert.match(forms[0], /id="complaint-chat-form"/);
  assert.match(forms[0], /id="complaint-message"[^>]*maxlength="1200"[^>]*required/);
  assert.match(forms[1], /id="complaint-submit-form"/);
  assert.match(forms[1], /id="complaint-note"[^>]*maxlength="1200"[^>]*required/);
  assert.equal(forms[1].includes('complaint-consent'), false);
  assert.equal(/<button\b[^>]*disabled/.test(forms[1]), false);
  assert.match(forms[1], /Передать сотруднику без ИИ/);
  assert.match(html, /не обращается к внешнему ИИ/);
  for (const form of forms) assert.equal(/\b(?:action|method|enctype|formaction)\s*=/i.test(form), false);
});

test('missing model configuration and a model failure preserve the non-AI path', () => {
  const item = report({ turns: [{ message: 'Мне обещали товар', status: 'error', error: 'Сервис временно недоступен' }] });
  const html = renderClient(item, { complaintConfigured: false, complaintConsent: true });
  assert.match(html, /ИИ-помощник сейчас не подключён/);
  assert.match(html, /Помощник недоступен/);
  assert.match(html, /Сервис временно недоступен/);
  assert.match(html, /<button\b(?=[^>]*type="submit")(?=[^>]*disabled)[^>]*>Ответить помощнику/);
  const fallback = html.match(/<form id="complaint-submit-form">[\s\S]*?<\/form>/)?.[0];
  assert.ok(fallback);
  assert.equal(/<button\b[^>]*disabled/.test(fallback), false);
  assert.match(fallback, /Передать сотруднику без ИИ/);
});

test('all client-controlled text is escaped, including responses, notes and status errors', () => {
  const attack = '"><img src=x onerror=alert(1)></textarea><script>alert(2)</script>';
  const item = report({ id: attack, operationId: attack, recipientId: attack, recipientName: attack, turns: [{ message: attack, status: 'done', response: { summary: attack, next_question: attack, category: attack } }, { message: attack, status: 'error', error: attack }], assessment: { summary: attack, next_question: attack, category: attack } });
  const html = renderClient(item, { complaintId: attack, complaintDraft: attack, complaintNote: attack, complaintError: attack });
  assert.equal(/<(?:script|img|svg|iframe)\b/i.test(html), false);
  assert.equal(html.includes('data-complaint-open=""><img'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;\/textarea&gt;/);
  const submitted = renderClient(report({ status: 'submitted', note: attack, review: { comment: attack, decidedBy: 'STAFF_SECRET', decidedAt: 2000 } }));
  assert.equal(/<(?:script|img|svg|iframe)\b/i.test(submitted), false);
  assert.match(submitted, /&lt;script&gt;/);
  assert.equal(submitted.includes('STAFF_SECRET'), false);
});

test('submitted and resolved reports show read-only conversations and a human decision', () => {
  for (const status of ['submitted', 'watch', 'blocked', 'dismissed', 'withdrawn']) {
    const html = renderClient(report({ status, note: 'Описание для сотрудника', turns: [{ message: 'CLIENT_ANSWER', status: 'done', response: { summary: 'AI_SUMMARY', next_question: 'AI_QUESTION' } }], assessment: { summary: 'AI_ASSESSMENT' }, review: { comment: 'HUMAN_REVIEW', decidedAt: 2000 } }));
    assert.match(html, /CLIENT_ANSWER/);
    assert.match(html, /AI_SUMMARY/);
    assert.match(html, /AI_QUESTION/);
    assert.match(html, /AI_ASSESSMENT/);
    assert.match(html, /HUMAN_REVIEW/);
    assert.match(html, /не решение банка/);
    assert.match(html, /не подтверждение мошенничества/);
    assert.equal(/<form\b|id="complaint-consent"|id="complaint-message"|id="complaint-note"/.test(html), false);
    assert.equal(/data-complaint-withdraw/.test(html), status === 'submitted');
  }
});

test('busy or server-processing dialogue disables conflicting client writes', () => {
  for (const [item, overrides] of [[report(), { complaintBusy: true }], [report({ turns: [{ message: 'Ответ', status: 'processing' }] }), {}]]) {
    const html = renderClient(item, overrides);
    for (const id of ['complaint-message', 'complaint-consent', 'complaint-note']) {
      const tag = html.match(new RegExp(`<(?:textarea|input)\\b[^>]*id="${id}"[^>]*>`))?.[0];
      assert.ok(tag); assert.match(tag, /disabled/);
    }
    for (const button of html.match(/<button\b[^>]*type="submit"[^>]*>/g) || []) assert.match(button, /disabled/);
    assert.match(html, /data-complaint-withdraw="REPORT-001"[^>]*disabled/);
  }
});

test('staff sees submitted cases, human moderation and audit identity, but not drafts or withdrawn reports', () => {
  const reports = [report({ id: 'DRAFT_SECRET', recipientName: 'HIDDEN_DRAFT' }), report({ id: 'WITHDRAWN_SECRET', status: 'withdrawn' }), report({ id: 'SUBMITTED', status: 'submitted', note: 'CLIENT_CONTEXT', assessment: { summary: 'AI_ONLY_ADVICE' }, review: { comment: 'DECISION_REASON', decidedAt: 2000, decidedBy: 'EMPLOYEE_AUDIT' } }), report({ id: 'WATCH', status: 'watch' }), report({ id: 'BLOCK', status: 'blocked' }), report({ id: 'DISMISS', status: 'dismissed' })];
  const html = renderFraudStaff(ui(), { fraudReports: reports }, helpers);
  assert.equal(/DRAFT_SECRET|HIDDEN_DRAFT|WITHDRAWN_SECRET/.test(html), false);
  assert.match(html, /На проверке: 1/);
  assert.match(html, /CLIENT_CONTEXT/);
  assert.match(html, /AI_ONLY_ADVICE/);
  assert.match(html, /DECISION_REASON/);
  assert.match(html, /EMPLOYEE_AUDIT/);
  assert.equal((html.match(/data-complaint-review=/g) || []).length, 3);
  assert.equal(/data-complaint-open|data-complaint-withdraw|id="complaint-chat-form"|id="complaint-submit-form"/.test(html), false);
  assert.match(html, /name="verdict"/);
  for (const value of ['watch', 'block', 'dismiss']) assert.match(html, new RegExp(`value="${value}"`));
  assert.match(html, /name="comment" minlength="5" maxlength="1000"[^>]*required/);
  assert.match(html, /Непроверенная жалоба не блокирует переводы/);
  assert.match(html, /не база Банка России/);
});

test('staff controls escape report IDs, all content and errors and use fixed decisions', () => {
  const attack = '"><svg onload=alert(1)></textarea><script>bad()</script>';
  const html = renderFraudStaff(ui({ complaintError: attack }), { fraudReports: [report({ id: attack, status: 'submitted', operationId: attack, recipientId: attack, recipientName: attack, note: attack, assessment: { summary: attack }, review: { comment: attack, decidedAt: 2000, decidedBy: attack }, turns: [{ message: attack, status: 'done', response: { summary: attack, next_question: attack } }] })] }, helpers);
  assert.equal(/<(?:script|img|svg|iframe)\b/i.test(html), false);
  assert.match(html, /&lt;svg/);
  assert.equal(html.includes('data-complaint-review=""><svg'), false);
  const values = [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(values, ['watch', 'block', 'dismiss']);
  assert.equal(/\b(?:action|formaction|href|src)\s*=/i.test(html), false);
});

test('empty and missing report states remain usable and unknown statuses cannot inject markup', () => {
  for (const state of [{}, { fraudReports: [] }, { fraudReports: null }]) {
    assert.match(renderComplaints(ui(), state, helpers), /Жалоб пока нет/);
    assert.match(renderFraudStaff(ui(), state, helpers), /Переданных на проверку жалоб пока нет/);
  }
  assert.equal(reportStatus({ status: '<script>attack</script>' }), 'Статус неизвестен');
  assert.equal(reportStatus(null), 'Статус неизвестен');
  const html = renderClient(report({ status: '"><script>attack</script>' }));
  assert.equal(/<script\b/i.test(html), false);
  assert.match(html, /Статус неизвестен/);
});
