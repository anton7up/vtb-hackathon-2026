const INITIAL_QUESTION = 'Расскажите, что вы оплачивали, кто предложил перевод и почему вы считаете, что вас обманули. Реквизиты уже привязаны к операции — вводить их не нужно.';
const STATUSES = {
  draft: { label: 'Черновик жалобы', tone: 'blue' },
  submitted: { label: 'У сотрудника на проверке', tone: 'blue' },
  watch: { label: 'Назначена дополнительная проверка', tone: 'amber' },
  blocked: { label: 'Реквизиты в стоп-листе демо', tone: 'red' },
  dismissed: { label: 'Рассмотрено · отметка не установлена', tone: '' },
  withdrawn: { label: 'Жалоба отозвана', tone: '' },
};

export function reportStatus(report) {
  return STATUSES[report?.status]?.label || 'Статус неизвестен';
}

const reportsOf = state => Array.isArray(state?.fraudReports) ? state.fraudReports : [];
const turnsOf = report => Array.isArray(report?.turns) ? report.turns : [];
const disabled = value => value ? 'disabled' : '';
const hasSavedExplanation = report => turnsOf(report).some(turn => typeof turn.message === 'string' && turn.message.trim().length >= 5);
const isProcessing = (report, now) => turnsOf(report).some(turn => {
  const startedAt = turn.startedAt;
  return turn.status === 'processing' && (!Number.isFinite(startedAt) || now - startedAt < 45_000);
});

function statusPill(report, { esc }) {
  const tone = STATUSES[report?.status]?.tone || '';
  return `<span class="pill ${tone}">${esc(reportStatus(report))}</span>`;
}

function timestamp(value, { date, esc }) {
  return Number.isFinite(value) ? esc(date(value)) : '—';
}

function facts(report, helpers) {
  const { esc, money } = helpers;
  return `<dl class="complaint-facts"><div><dt>Получатель из операции</dt><dd>${esc(report.recipientName || report.recipientId)}</dd></div><div><dt>Сумма операции</dt><dd>${Number.isSafeInteger(report.amount) ? esc(money(report.amount)) : '—'}</dd></div><div><dt>Номер операции</dt><dd>${esc(report.operationId)}</dd></div><div><dt>Жалоба создана</dt><dd>${timestamp(report.createdAt, helpers)}</dd></div></dl>`;
}

function conversation(report, helpers) {
  const { esc } = helpers;
  const turns = turnsOf(report);
  return `<div class="complaint-conversation"><div class="ai-message bot"><b>Помощник по обращению</b><p>${INITIAL_QUESTION}</p></div>${turns.map(turn => `<div class="ai-message user"><b>Клиент</b><p>${esc(turn.message)}</p></div>${turn.status === 'processing' ? '<div class="ai-message bot" role="status"><b>Помощник</b><p>Готовим уточняющий вопрос…</p></div>' : turn.status === 'error' ? `<div class="notice error"><b>Помощник недоступен</b><p>${esc(turn.error || 'Не удалось получить ответ модели. Можно передать жалобу сотруднику без ИИ.')}</p></div>` : turn.response ? `<div class="ai-message bot"><b>ИИ-помощник · не решение банка</b>${turn.response.summary ? `<p>${esc(turn.response.summary)}</p>` : ''}${turn.response.next_question ? `<p class="ai-question">${esc(turn.response.next_question)}</p>` : ''}</div>` : ''}`).join('')}</div>`;
}

function assessment(report, { esc }) {
  if (!report.assessment?.summary) return '';
  return `<section class="complaint-assessment"><h3>Предварительное резюме ИИ</h3><p>${esc(report.assessment.summary)}</p><small>Это помощь сотруднику, а не подтверждение мошенничества и не решение о блокировке.</small></section>`;
}

function review(report, helpers, staff = false) {
  if (!report.review) return '';
  const { esc } = helpers;
  return `<section class="complaint-review-note"><h3>Комментарий сотрудника</h3><p>${esc(report.review.comment || 'Комментарий не указан.')}</p><small>${timestamp(report.review.decidedAt, helpers)}${staff && report.review.decidedBy ? ` · ${esc(report.review.decidedBy)}` : ''}</small></section>`;
}

function clientEditor(ui, report, helpers, now) {
  const { esc } = helpers;
  const processing = Boolean(ui.complaintBusy || isProcessing(report, now));
  const explained = hasSavedExplanation(report);
  const complete = report.assessment?.next_question === null || turnsOf(report).filter(t => t.status === 'done').length >= 4;
  return `<div class="notice warning">Для хакатона описывайте только вымышленные ситуации. Не вводите ФИО, телефоны, номера карт и счетов, пароли или SMS-коды. Автоматическое скрытие данных не гарантирует полной анонимности.</div>
    ${!ui.complaintConfigured ? '<p class="notice">ИИ-помощник сейчас не подключён. Заполните описание ниже и передайте жалобу сотруднику без ИИ.</p>' : ''}
    ${complete ? '<p class="notice">Опрос завершён. Ответы сохранены — передайте жалобу сотруднику кнопкой ниже.</p>' : `<form id="complaint-chat-form"><label class="field-label" for="complaint-message">Ответ помощнику</label><textarea id="complaint-message" rows="4" maxlength="1200" required placeholder="Опишите вымышленную ситуацию своими словами" ${disabled(processing)}>${esc(ui.complaintDraft)}</textarea>
    <label class="ai-consent"><input type="checkbox" id="complaint-consent" ${ui.complaintConsent ? 'checked' : ''} ${disabled(processing)} required><span>Согласен отправить текст после автоматического скрытия данных во внешний сервис Groq/Qwen и сохранить диалог для сотрудника банка. Реальные персональные и банковские данные не ввожу.</span></label>
    <button type="submit" class="button" ${disabled(processing || !ui.complaintConfigured || !ui.complaintConsent)}>${processing ? 'Ждём ответ помощника…' : 'Ответить помощнику'}</button></form>`}
    <div class="complaint-submit"><h3>Передать обращение на проверку</h3><p class="complaint-help">${explained ? 'Ваши ответы уже сохранены и будут переданы сотруднику. Повторять историю не нужно.' : 'Помощник необязателен. Опишите обстоятельства для сотрудника.'} Отправка этой формы не обращается к внешнему ИИ.</p>
    <form id="complaint-submit-form"><label class="field-label" for="complaint-note">${explained ? 'Дополнение к жалобе · необязательно' : 'Что произошло'}</label><textarea id="complaint-note" rows="4" maxlength="1200" ${explained ? '' : 'required'} placeholder="${explained ? 'Можно добавить важные подробности или сразу передать жалобу' : 'Что обещали, как связались с вами и почему вы подозреваете обман'}" ${disabled(processing)}>${esc(ui.complaintNote)}</textarea><button type="submit" class="button secondary" ${disabled(processing)}>${turnsOf(report).some(turn => turn.status === 'done') ? 'Передать жалобу сотруднику' : 'Передать сотруднику без ИИ'}</button></form></div>`;
}

export function renderComplaints(ui, state, helpers) {
  const { esc, money } = helpers;
  const reports = reportsOf(state);
  const report = reports.find(item => item.id === ui.complaintId) || reports[0];
  const now = Date.now();
  return `<div class="complaints-layout"><section class="panel complaints-list"><h2>Мои жалобы</h2><p class="complaint-help">Начните с кнопки «Сообщить об обмане» рядом с переводом в истории.</p><button type="button" class="link-button" data-page="history">Перейти в историю операций →</button>
    <div class="complaints-items">${reports.map(item => `<button type="button" class="complaint-list-item ${item.id === report?.id ? 'selected' : ''}" data-complaint-open="${esc(item.id)}" ${disabled(ui.complaintBusy)}><b>${esc(item.recipientName || item.recipientId)}</b><span>${Number.isSafeInteger(item.amount) ? esc(money(item.amount)) : '—'} · ${timestamp(item.createdAt, helpers)}</span>${statusPill(item, helpers)}</button>`).join('') || '<p class="empty">Жалоб пока нет.</p>'}</div></section>
    <section class="panel complaint-detail" aria-label="Содержание жалобы">${report ? `<div class="section-head"><h2>Обращение по переводу</h2>${statusPill(report, helpers)}</div>${facts(report, helpers)}<p class="complaint-help">Получатель и сумма привязаны к операции на сервере. Вводить или менять реквизиты здесь не нужно.</p>
    ${ui.complaintError ? `<p class="notice error" role="alert">${esc(ui.complaintError)}</p>` : ''}${conversation(report, helpers)}${assessment(report, helpers)}
    ${report.status === 'draft' ? clientEditor(ui, report, helpers, now) : `${report.note ? `<section class="complaint-submitted-note"><h3>Ваше описание</h3><p>${esc(report.note)}</p></section>` : ''}${review(report, helpers)}<p class="notice">${report.status === 'submitted' ? 'Жалоба передана сотруднику. Диалог и описание доступны для рассмотрения.' : 'Обращение сохранено. Текущий статус указан выше.'}</p>`}
    ${['draft', 'submitted'].includes(report.status) ? `<button type="button" class="link-button complaint-withdraw" data-complaint-withdraw="${esc(report.id)}" ${disabled(ui.complaintBusy || isProcessing(report, now))}>Отозвать жалобу</button>` : ''}<p class="complaint-disclaimer">Жалоба сама по себе не блокирует реквизиты и не гарантирует возврат денег. Отметку риска устанавливает сотрудник после проверки.</p>` : '<div class="complaint-empty"><h2>Поможем описать ситуацию</h2><p>Выберите перевод в истории и сообщите о возможном обмане. Сначала создаётся черновик — другим клиентам он не виден.</p></div>'}</section></div>`;
}

export function renderFraudStaff(ui, state, helpers) {
  const { esc } = helpers;
  const reports = reportsOf(state).filter(report => !['draft', 'withdrawn'].includes(report.status));
  const pending = reports.filter(report => report.status === 'submitted').length;
  return `<div class="fraud-staff-view"><section class="panel"><div class="section-head"><h2>Жалобы на получателей</h2><span class="pill blue">На проверке: ${pending}</span></div><p class="complaint-help">Непроверенная жалоба не блокирует переводы. ИИ только собирает обстоятельства; решение принимает сотрудник.</p><p class="notice warning">Учебный реестр, не база Банка России. «Дополнительная проверка» предупреждает о риске следующих переводов; «Стоп-лист» запрещает их по правилам прототипа. Отсутствие жалоб не означает безопасность.</p>${ui.complaintError ? `<p class="notice error" role="alert">${esc(ui.complaintError)}</p>` : ''}</section>
    <div class="fraud-report-list">${reports.map(report => `<article class="panel fraud-report-card"><div class="section-head"><h2>${esc(report.recipientName || report.recipientId)}</h2>${statusPill(report, helpers)}</div>${facts(report, helpers)}<p class="complaint-id">Жалоба ${esc(report.id)} · получатель ${esc(report.recipientId)}</p>
    <section class="complaint-submitted-note"><h3>Описание клиента</h3><p>${esc(report.note || 'Отдельное описание не указано.')}</p></section>${assessment(report, helpers)}<details class="complaint-dialog-details"><summary>Диалог с помощником · ${turnsOf(report).length} ответов клиента</summary>${conversation(report, helpers)}</details>${review(report, helpers, true)}
    ${report.status === 'dismissed' ? '<p class="notice">Жалоба закрыта. Решение и его обоснование сохранены выше.</p>' : `<form class="complaint-moderation" data-complaint-review="${esc(report.id)}"><h3>Решение сотрудника</h3><label class="field-label" for="complaint-verdict-${esc(report.id)}">Отметка по результатам проверки</label><select id="complaint-verdict-${esc(report.id)}" name="verdict" required ${disabled(ui.complaintBusy)}><option value="watch" ${report.status === 'watch' ? 'selected' : ''}>Нужна дополнительная проверка переводов</option><option value="block" ${report.status === 'blocked' ? 'selected' : ''}>Внести реквизиты в стоп-лист демо</option><option value="dismiss">Закрыть жалобу без отметки риска</option></select><label class="field-label" for="complaint-comment-${esc(report.id)}">Обоснование решения</label><textarea id="complaint-comment-${esc(report.id)}" name="comment" minlength="5" maxlength="1000" rows="3" required ${disabled(ui.complaintBusy)} placeholder="Укажите, что проверено и почему принято решение"></textarea><button type="submit" class="button secondary" ${disabled(ui.complaintBusy)}>Сохранить решение</button></form>`}</article>`).join('') || '<section class="panel"><p class="empty">Переданных на проверку жалоб пока нет.</p></section>'}</div></div>`;
}
