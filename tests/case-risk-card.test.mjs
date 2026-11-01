import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCaseRiskCard } from '../public/case-risk-card.mjs';

const helpers = { money: value => `${value / 100} ₽`, date: value => `time-${value}` };
const operation = {
  id: 'OP-1001', kind: 'transfer', recipientId: 'DEMO-SHOP-001', recipientName: 'Учебный магазин',
  amount: 300000, createdAt: 1234, status: 'pending', code: 'MODEL_REVIEW', reason: 'Нужна проверка',
  classification: { class: 'review', source: 'mock', model_version: 'mock-v1' }, review: { status: 'pending' },
};

test('case card keeps mock classification, policy, Qwen and employee decision separate', () => {
  const html = renderCaseRiskCard(operation, {}, helpers);
  assert.match(html, /Демо-заглушка — не обученная ML-модель/);
  assert.match(html, /Решение серверной защиты/);
  assert.match(html, /Код решения: MODEL_REVIEW/);
  assert.match(html, /Ожидает решения сотрудника/);
  assert.match(html, /Оценка Qwen по этой операции отсутствует/);
  assert.match(html, /Сводка общего реестра по получателю не передана/);
  assert.doesNotMatch(html, /получатель безопасен|QR проверен|вероятность мошенничества/i);
});

test('only bound operation conversations are shown and their text is escaped', () => {
  const state = { aiConversations: [
    { operationId: 'OTHER-OP', turns: [{ message: 'OTHER-OP-SECRET' }], assessment: { class: 'block' } },
    { operationId: null, turns: [{ message: 'GENERAL-SECRET' }] },
    { operationId: operation.id, createdAt: 5678, assessment: { class: 'review', scenario: 'unknown', explanation: 'Нужно уточнение' }, turns: [
      { message: '<img src=x onerror=alert(1)>', status: 'done', response: { class: 'review', explanation: '<script>alert(2)</script>', evidence: ['<svg onload=alert(3)>'], next_question: 'Кто предложил <перевод>?' } },
      { message: 'Второй ответ', status: 'error', error: '<b>Ошибка сервиса</b>' },
    ] },
  ] };
  const html = renderCaseRiskCard({ ...operation, recipientName: '<iframe>' }, state, helpers);
  assert.doesNotMatch(html, /OTHER-OP-SECRET|GENERAL-SECRET|<img|<script|<iframe|<svg/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /Кто предложил &lt;перевод&gt;/);
  assert.match(html, /&lt;b&gt;Ошибка сервиса&lt;\/b&gt;/);
});

test('recognized QR source uses only the adapter metadata, never the raw payment URL', () => {
  const html = renderCaseRiskCard({ ...operation, paymentContext: { source: 'demo_qr_adapter', recipientId: operation.recipientId, fixtureId: 'shop-qr', fixtureVersion: 'v1', url: 'https://pay.example/?token=SECRET', rawUrl: 'QR-PAYMENT-SECRET', payload: 'QR-PAYLOAD-SECRET' } }, {}, helpers);
  assert.match(html, /Учебный QR-адаптер · shop-qr · v1/);
  assert.match(html, /не подключение к СБП/);
  assert.doesNotMatch(html, /SECRET|pay\.example|подлинность подтверждена/i);
  const mismatch = renderCaseRiskCard({ ...operation, paymentContext: { source: 'demo_qr_adapter', recipientId: 'DIFFERENT', fixtureId: 'shop-qr' } }, {}, helpers);
  assert.match(mismatch, /не подтверждён учебным адаптером/);
  assert.doesNotMatch(mismatch, /Получатель сопоставлен/);
});

test('recipient aggregate is separate from selected client reports and excludes drafts or foreign reports', () => {
  const state = {
    client: { id: 'client-a', name: '<Клиент А>' },
    recipientRiskSummary: [{ recipientId: operation.recipientId, status: 'watch', reportCount: 4, uniqueReporters: 3, submittedCount: 2, watchCount: 1, blockCount: 0, dismissedCount: 1, source: 'synthetic_complaint_review' }],
    fraudReports: [
      { id: 'OWN-REPORT', clientId: 'client-a', recipientId: operation.recipientId, operationId: operation.id, status: 'watch', note: '<own-note>', review: { comment: '<employee-note>' }, assessment: { summary: '<AI-summary>' } },
      { id: 'FOREIGN-REPORT', clientId: 'client-b', recipientId: operation.recipientId, status: 'watch', note: 'FOREIGN-SECRET' },
      { id: 'DRAFT-REPORT', recipientId: operation.recipientId, status: 'draft', note: 'DRAFT-SECRET' },
      { id: 'WITHDRAWN-REPORT', recipientId: operation.recipientId, status: 'withdrawn', note: 'WITHDRAWN-SECRET' },
      { id: 'OTHER-PAYEE', recipientId: 'OTHER', status: 'submitted', note: 'OTHER-PAYEE-SECRET' },
    ],
  };
  const html = renderCaseRiskCard(operation, state, helpers);
  assert.match(html, /назначена дополнительная проверка/);
  assert.match(html, /Всего обращений<\/dt><dd>4/);
  assert.match(html, /Разных заявителей<\/dt><dd>3/);
  assert.match(html, /OWN-REPORT/);
  assert.match(html, /&lt;own-note&gt;/);
  assert.match(html, /&lt;employee-note&gt;/);
  assert.match(html, /&lt;AI-summary&gt;/);
  assert.match(html, /Выбранный клиент: &lt;Клиент А&gt;/);
  assert.doesNotMatch(html, /FOREIGN-SECRET|DRAFT-SECRET|WITHDRAWN-SECRET|OTHER-PAYEE-SECRET/);
});

test('no entry does not imply safe, bad counts are omitted and unknown sources do not become ML', () => {
  const html = renderCaseRiskCard({ ...operation, classification: { class: 'normal', source: 'unexpected', model_version: '<version>' } }, {
    recipientRiskSummary: [{ recipientId: operation.recipientId, status: 'none', reportCount: -1, uniqueReporters: '<img>', source: '<source>' }],
  }, helpers);
  assert.match(html, /Источник классификации не подтверждён как обученная ML-модель/);
  assert.match(html, /&lt;version&gt;/);
  assert.match(html, /Отсутствие отметки не означает безопасность/);
  assert.match(html, /&lt;source&gt;/);
  assert.doesNotMatch(html, /Всего обращений|Разных заявителей|<img/);
});

test('approved does not claim money already sent, and absent/invalid data does not invent evidence', () => {
  const html = renderCaseRiskCard({ ...operation, review: { status: 'approved', comment: '<comment>', decidedAt: 6789, decidedBy: '<staff>' } }, null, helpers);
  assert.match(html, /требуется подтверждение клиента/);
  assert.match(html, /&lt;comment&gt;/);
  assert.match(html, /&lt;staff&gt;/);
  const absent = renderCaseRiskCard({ id: 'UNKNOWN' }, {}, helpers);
  assert.match(absent, /Источник операции не указан/);
  assert.match(absent, /Основание решения не сохранено/);
  assert.match(absent, /Статус<\/dt><dd>Не указан/);
  assert.equal(renderCaseRiskCard(null), '<p class="case-risk-empty">Операция не найдена.</p>');
});

test('cash card shows only existing facts and no invented cash screening', () => {
  const html = renderCaseRiskCard({ ...operation, kind: 'cash', classification: null }, {}, helpers);
  assert.match(html, /Демонстрационное снятие наличных/);
  assert.match(html, /Классификатор переводов к этой операции не применяется/);
  assert.doesNotMatch(html, /Необычная сумма|Серия снятий|Проверка снятия наличных завершена/);
});

test('policy origin identifies recipient rule only when its version actually matches', () => {
  const reportRule = renderCaseRiskCard({ ...operation, classification: { class: 'review', source: 'policy', model_version: 'recipient-reports-v1' } }, {}, helpers);
  assert.match(reportRule, /Серверное правило реестра жалоб/);
  const unknownRule = renderCaseRiskCard({ ...operation, classification: { class: 'review', source: 'policy', model_version: 'another-rule' } }, {}, helpers);
  assert.match(unknownRule, /Серверное правило; это не прогноз ML-модели/);
  assert.doesNotMatch(unknownRule, /Серверное правило реестра жалоб/);
});

test('saved recipient snapshot is labelled historical and wrong-recipient snapshot is ignored', () => {
  const snapshot = { recipientId: operation.recipientId, status: 'active', reportCount: 2 };
  const html = renderCaseRiskCard({ ...operation, registrySnapshot: snapshot }, {}, helpers);
  assert.match(html, /Сохранённый снимок реестра, не обязательно его текущее состояние/);
  assert.match(html, /действует блокировка/);
  const ignored = renderCaseRiskCard({ ...operation, registrySnapshot: { ...snapshot, recipientId: 'OTHER' } }, {}, helpers);
  assert.match(ignored, /Сводка общего реестра по получателю не передана/);
  assert.doesNotMatch(ignored, /действует блокировка/);
});
