// Read-only employee presentation. Authorization and selected-client scoping belong
// to the server; never pass an unscoped collection of customer reports here.
import { renderTrustedOperation } from './trusted-view.mjs';
const CLASSES = { normal: 'Нормальный', review: 'Нужно проверить', block: 'Блокировка' };
const STATUSES = { completed: 'Выполнено', pending: 'Ожидает проверки', blocked: 'Остановлено' };
const REVIEW = { pending: 'Ожидает решения сотрудника', approved: 'Разрешено отдельное подтверждение клиента', rejected: 'Перевод отклонён', invalidated: 'Предыдущее разрешение недействительно' };
const SCENARIOS = {
  none: 'Явная схема в описании не выявлена', unknown: 'Недостаточно данных',
  safe_account: '«Безопасный счёт»', law_enforcement: 'Требование от имени госоргана',
  phishing: 'Фишинг', remote_access: 'Удалённый доступ', impersonation: 'Подмена знакомого',
  investment: 'Лжеинвестиции', loan_pressure: 'Кредит под давлением', cash_courier: 'Наличные для курьера',
};
const REPORTS = { submitted: 'Передано на рассмотрение', watch: 'Назначена дополнительная проверка', blocked: 'Установлена блокировка', dismissed: 'Закрыто без отметки риска' };
const list = value => Array.isArray(value) ? value : [];
const present = value => typeof value === 'string' && value.trim().length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const defaultEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function helpersOf(helpers) {
  return {
    esc: typeof helpers?.esc === 'function' ? helpers.esc : defaultEscape,
    money: typeof helpers?.money === 'function' ? helpers.money : amount => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(amount / 100),
    date: typeof helpers?.date === 'function' ? helpers.date : at => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(at),
  };
}
function timestamp(value, { esc, date }) {
  if (!Number.isFinite(value)) return 'Не указано';
  try { return esc(date(value)); } catch { return 'Не указано'; }
}
function fact(label, value, { esc }) {
  return `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}
function section(title, body, { esc }) {
  return `<section class="case-risk-section"><h4>${esc(title)}</h4>${body}</section>`;
}
function paymentSource(operation, helpers) {
  const { esc } = helpers;
  const context = operation.paymentContext;
  if (context?.source === 'demo_qr_adapter' && context.recipientId === operation.recipientId && present(context.fixtureId)) {
    return `<p>Учебный QR-адаптер · ${esc(context.fixtureId)}${present(context.fixtureVersion) ? ` · ${esc(context.fixtureVersion)}` : ''}</p><p class="case-risk-note">Получатель сопоставлен сервером по учебному справочнику. Это не подключение к СБП и не подтверждение подлинности магазина.</p>`;
  }
  if (context) return '<p>Источник платёжного контекста не подтверждён учебным адаптером.</p>';
  if (operation.seeded) return '<p>Учебная история операций. Новая проверка для этой записи не проводилась.</p>';
  if (operation.kind === 'transfer') return '<p>Демонстрационный перевод из банковской формы.</p>';
  if (operation.kind === 'cash') return '<p>Демонстрационное снятие наличных.</p>';
  return '<p>Источник операции не указан.</p>';
}
function classifier(operation, { esc }) {
  if (operation.kind !== 'transfer') return '<p>Классификатор переводов к этой операции не применяется.</p>';
  const result = operation.classification;
  if (!result) return '<p>Ответ классификатора не сохранён. Это не означает, что операция безопасна.</p>';
  const source = result.source === 'mock' ? 'Демо-заглушка — не обученная ML-модель' : result.source === 'ml' ? 'Обученная транзакционная ML-модель' : result.source === 'policy' ? result.model_version === 'recipient-reports-v1' ? 'Серверное правило реестра жалоб' : 'Серверное правило; это не прогноз ML-модели' : 'Источник классификации не подтверждён как обученная ML-модель';
  const probability = result.source === 'ml' && Number.isFinite(result.p_fraud) ? ` · оценка риска ${(result.p_fraud * 100).toFixed(1)}%` : '';
  return `<p><b>${esc(CLASSES[result.class] || 'Класс не распознан')}</b></p><p>${esc(source)}${present(result.model_version) ? ` · ${esc(result.model_version)}` : ''}${probability}</p>`;
}
function staffDecision(operation, helpers) {
  const { esc } = helpers;
  const review = operation.review;
  if (!review) return '<p>Отдельное решение сотрудника по переводу не сохранено.</p>';
  return `<p>${esc(REVIEW[review.status] || 'Статус решения не распознан')}</p>${present(review.comment) ? `<p class="case-risk-text">${esc(review.comment)}</p>` : ''}${Number.isFinite(review.decidedAt) ? `<p class="case-risk-note">${timestamp(review.decidedAt, helpers)}${present(review.decidedBy) ? ` · ${esc(review.decidedBy)}` : ''}</p>` : ''}<p class="case-risk-note">Решение сотрудника не отменяет серверные ограничения.${review.status === 'approved' && operation.status === 'pending' ? ' Деньги ещё не списаны: требуется подтверждение клиента.' : ''}</p>`;
}
function renderAssessment(assessment, { esc }) {
  if (!assessment || typeof assessment !== 'object') return '';
  return `<div class="case-risk-assessment"><p><b>Рекомендация Qwen: ${esc(CLASSES[assessment.class] || 'Не указана')}</b>${present(assessment.model_version) ? ` · ${esc(assessment.model_version)}` : ''}</p>${SCENARIOS[assessment.scenario] ? `<p>${esc(SCENARIOS[assessment.scenario])}</p>` : ''}${present(assessment.explanation) ? `<p class="case-risk-text">${esc(assessment.explanation)}</p>` : ''}${list(assessment.evidence).length ? `<ul>${list(assessment.evidence).map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}</div>`;
}
function assistant(operation, state, helpers) {
  const { esc } = helpers;
  const clientId = state.clientId ?? state.client?.id;
  const conversations = list(state.aiConversations).filter(item => present(operation.id) && item?.operationId === operation.id && (!item.clientId || (clientId && item.clientId === clientId)));
  const assessment = operation.aiAssessment || conversations.find(item => item.assessment)?.assessment;
  const dialogue = conversations.map(conversation => `<details class="case-risk-dialogue"><summary>Ответы клиента и помощника · ${timestamp(conversation.createdAt, helpers)}</summary>${list(conversation.turns).map(turn => `<div class="case-risk-turn"><b>Клиент</b><p class="case-risk-text">${esc(turn.message)}</p>${turn.status === 'processing' ? '<p role="status">Ответ Qwen ещё не получен.</p>' : turn.error ? `<p class="case-risk-text">Ошибка помощника: ${esc(turn.error)}</p>` : turn.response ? `<b>Qwen · предварительная оценка</b>${renderAssessment(turn.response, helpers)}${present(turn.response.next_question) ? `<p class="case-risk-text">Вопрос: ${esc(turn.response.next_question)}</p>` : ''}` : ''}</div>`).join('') || '<p>Ответов клиента пока нет.</p>'}</details>`).join('');
  return `${assessment ? renderAssessment(assessment, helpers) : '<p>Оценка Qwen по этой операции отсутствует.</p>'}${dialogue}<p class="case-risk-note">ИИ анализирует объяснение клиента, а не подтверждает факты о получателе. Благоприятная оценка не разрешает перевод и не гарантирует безопасность.</p>`;
}
function recipientSummary(operation, state, helpers) {
  const { esc } = helpers;
  const snapshot = operation.registrySnapshot;
  const aggregate = list(state.recipientRiskSummary).find(item => item && (item.recipientId ?? item.recipient_id) === operation.recipientId);
  const summary = aggregate || (snapshot && !Array.isArray(snapshot) && (snapshot.recipientId ?? snapshot.recipient_id) === operation.recipientId ? snapshot : null);
  if (!summary) return '<p>Сводка общего реестра по получателю не передана. Вывод об отсутствии жалоб сделать нельзя.</p>';
  const mark = { active: 'В учебном реестре действует блокировка', watch: 'В учебном реестре назначена дополнительная проверка', none: 'Действующих отметок в учебном реестре нет' }[summary.status] || 'Статус отметки не передан';
  const fields = [['Всего обращений', summary.reportCount], ['Разных заявителей', summary.uniqueReporters], ['Ожидают рассмотрения', summary.submittedCount], ['С дополнительной проверкой', summary.watchCount], ['С блокировкой', summary.blockCount], ['Закрыто без отметки', summary.dismissedCount]];
  return `${aggregate ? '' : '<p class="case-risk-note">Сохранённый снимок реестра, не обязательно его текущее состояние.</p>'}<p><b>${esc(mark)}</b></p><dl class="case-risk-counts">${fields.filter(([, value]) => count(value) !== null).map(([label, value]) => fact(label, String(value), helpers)).join('')}</dl>${present(summary.source) ? `<p class="case-risk-note">Источник сводки: ${esc(summary.source)}</p>` : ''}${Number.isFinite(summary.updatedAt) ? `<p class="case-risk-note">Обновлено: ${timestamp(summary.updatedAt, helpers)}</p>` : ''}<p class="case-risk-note">Общая сводка не раскрывает обращения других клиентов. Это учебный реестр, не база Банка России. Отсутствие отметки не означает безопасность.</p>`;
}
function selectedClientReports(operation, state, helpers) {
  const { esc } = helpers;
  const clientId = state.clientId ?? state.client?.id;
  const reports = list(state.fraudReports).filter(report => report && present(operation.recipientId) && report.recipientId === operation.recipientId && Object.hasOwn(REPORTS, report.status) && (!report.clientId || (clientId && report.clientId === clientId)));
  if (!reports.length) return '<p>Переданных обращений выбранного клиента по этому получателю нет.</p>';
  return `<details class="case-risk-dialogue"><summary>Обращения выбранного клиента по этому получателю · ${reports.length}</summary>${reports.map(report => `<article class="case-risk-report"><p><b>${esc(report.id)}</b> · ${esc(REPORTS[report.status])}</p><p class="case-risk-note">Операция ${esc(report.operationId)} · ${timestamp(report.createdAt, helpers)}</p>${present(report.note) ? `<p class="case-risk-text">Со слов клиента: ${esc(report.note)}</p>` : '<p>Отдельное описание не указано.</p>'}${present(report.assessment?.summary) ? `<p class="case-risk-text">Резюме ИИ, не подтверждение фактов: ${esc(report.assessment.summary)}</p>` : ''}${present(report.review?.comment) ? `<p class="case-risk-text">Комментарий сотрудника: ${esc(report.review.comment)}</p>` : ''}</article>`).join('')}</details>`;
}

/** Employee-only caller; state must already be scoped to the selected customer. */
export function renderCaseRiskCard(operation, state = {}, helpers = {}) {
  const h = helpersOf(helpers);
  const { esc, money } = h;
  if (!operation || typeof operation !== 'object') return '<p class="case-risk-empty">Операция не найдена.</p>';
  const safeState = state && typeof state === 'object' ? state : {};
  const amount = Number.isSafeInteger(operation.amount) && operation.amount > 0 ? esc(money(operation.amount)) : 'Не указана';
  const facts = [
    fact('Операция', esc(operation.id || 'Не указана'), h),
    fact('Статус', esc(STATUSES[operation.status] || 'Не указан'), h),
    fact('Получатель', esc(operation.recipientName || 'Не указан'), h),
    fact('ID получателя', esc(operation.recipientId || 'Не указан'), h),
    fact('Сумма', amount, h),
    fact('Создана', timestamp(operation.createdAt, h), h),
  ].join('');
  const policy = `<p class="case-risk-text">${esc(present(operation.reason) ? operation.reason : 'Основание решения не сохранено.')}</p>${present(operation.code) ? `<p class="case-risk-note">Код решения: ${esc(operation.code)}</p>` : ''}${present(operation.registryReason) ? `<p class="case-risk-text">Основание реестра: ${esc(operation.registryReason)}</p>` : ''}${typeof operation.knownAtDecision === 'boolean' && operation.kind === 'transfer' ? `<p class="case-risk-note">На момент решения: ${operation.knownAtDecision ? 'прежний' : 'новый'} получатель.</p>` : ''}${Number.isFinite(operation.holdEndsAt) ? `<p class="case-risk-note">Сохранённое окончание защитной паузы: ${timestamp(operation.holdEndsAt, h)}. Текущие ограничения перепроверяются сервером.</p>` : ''}`;
  return `<section class="case-risk-card" aria-label="Сведения и основания проверки операции"><h3>Карточка проверки операции</h3>${present(safeState.client?.name) ? `<p class="case-risk-note">Выбранный клиент: ${esc(safeState.client.name)}</p>` : ''}<dl class="case-risk-facts">${facts}</dl>${section('Источник операции', paymentSource(operation, h), h)}${section('Классификация перевода', classifier(operation, h), h)}${section('Решение серверной защиты', policy, h)}${section('Решение сотрудника', staffDecision(operation, h), h)}${operation.guardianApproval ? section('Разрешение доверенных лиц', renderTrustedOperation(operation, h), h) : ''}${section('Объяснение клиента и Qwen', assistant(operation, safeState, h), h)}${section('Общий реестр получателей', recipientSummary(operation, safeState, h), h)}${section('Обращения выбранного клиента', selectedClientReports(operation, safeState, h), h)}</section>`;
}
