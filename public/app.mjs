// Roles, balances, operations and permissions come exclusively from the server.
import { needsAssistantReview, reviewGreeting, reviewStatus } from './review-assistant.mjs';
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (response.status === 401) { location.replace('/login'); throw new Error('Войдите в аккаунт'); }
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос');
  return data;
}
const { user: account } = await api('/api/auth/me');
const landing = account.role === 'employee' ? '/employee' : '/client';
if (location.pathname !== landing) location.replace(landing);
let { state, assistant: assistantConfig } = await api('/api/state');
let receivedAt = Date.now();
const now = () => state.serverNow + Date.now() - receivedAt;
const protectionOf = (_state, at) => { const endsAt = state.protection.endsAt; return { endsAt, active: endsAt !== null && at < endsAt, remainingMs: endsAt === null ? 0 : Math.max(0, endsAt - at) }; };
const isKnown = (_state, id) => state.knownRecipientIds.includes(id);
const parseAmount = value => { const text = String(value).replace(/\s/g, '').replace(',', '.'); if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null; const cents = Math.round(Number(text) * 100); return Number.isSafeInteger(cents) && cents > 0 ? cents : null; };

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const money = cents => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const date = at => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at);
const paths = {
  shield: '<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  transfer: '<path d="M4 7h16m-4-4l4 4-4 4M20 17H4m4-4l-4 4 4 4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3m-4 5v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cash: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M5 9v6m14-6v6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0116 0v2"/>',
  history: '<path d="M3 11a9 9 0 119 10M3 4v7h7m2-4v5l3 2"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  message: '<path d="M21 11.5a8 8 0 01-8 8H5l-3 3V11.5a9.5 9.5 0 0119 0z"/><path d="M7 10h10M7 14h6"/>',
  list: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8m-8 4h8m-8 4h5"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
  alert: '<path d="M10.3 4L2 19h20L13.7 4a2 2 0 00-3.4 0zM12 9v4m0 3h.01"/>',
  arrow: '<path d="M5 12h14m-5-5l5 5-5 5"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.shield}</svg>`;
let wasActive = protectionOf(state, now()).active;
let baseRegistry = null;
let registryStatus = 'loading';
const ui = { role: account.role, page: 'transfer', kind: 'transfer', recipient: 'DEMO-FAMILY-001', amount: '3 000', customId: '', customName: '', answers: {}, filter: 'all' };
Object.assign(ui, { aiConversationId: state.aiConversations?.[0]?.id || null, aiOperationId: '', aiDraft: '', aiConsent: false, aiBusy: false, aiRequestId: null, aiModalOperationId: null });
if (ui.role === 'employee') ui.page = 'cases';
const registry = () => baseRegistry;
const allRecipients = () => state.recipients;
async function action(name, data = {}) {
  const result = await api('/api/action', { ...data, action: name });
  state = result.state; receivedAt = Date.now();
  if (ui.role === 'employee' && ['registry-add', 'reset'].includes(name)) await loadRegistry(false);
  render(); return result;
}
let toastTimer;
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4300); }
function showDialog(title, content, symbol = 'shield', tone = '', assistantMode = false) {
  if (!assistantMode) ui.aiModalOperationId = null;
  $('#dialog').classList.toggle('assistant-dialog', assistantMode);
  $('#dialog-content').innerHTML = `<div class="dialog-inner"><button type="button" class="dialog-close" aria-label="Закрыть окно" data-close>×</button><div class="dialog-symbol ${tone}">${icon(symbol)}</div><h2 id="dialog-title">${esc(title)}</h2>${content}</div>`;
  if (!$('#dialog').open) $('#dialog').showModal();
}
const closeDialog = () => { ui.aiModalOperationId = null; $('#dialog').close(); };
function renderBanner() {
  const hold = protectionOf(state, now());
  const banner = $('#protection-banner');
  renderSecurityAlerts();
  if (state.securityLock) {
    banner.className = 'protection-banner security-locked';
    banner.innerHTML = `<div class="banner-icon">${icon('lock')}</div><div><b>Операции заблокированы: «Это был не я»</b><p>Все переводы, включая прежних получателей, и снятие наличных остановлены. Баланс и история доступны. Эта блокировка не снимается через 24 часа или ответом сотрудника.</p></div>`;
    return;
  }
  banner.className = `protection-banner${hold.active ? ' hold' : ''}`;
  if (hold.active) banner.innerHTML = `<div class="banner-icon">${icon('clock')}</div><div><b>Защитная пауза после изменения данных</b><p>Новым получателям и наличными — после ${esc(date(hold.endsAt))}. Прежним получателям переводить можно.</p></div><div class="countdown"><span id="countdown"></span><small>до окончания паузы</small></div>`;
  else banner.innerHTML = `<div class="banner-icon">${icon('shield')}</div><div><b>${state.lastCriticalChange === null ? 'Счёт под защитой. Ограничений по времени нет' : 'Защитная пауза завершена'}</b><p>${state.lastCriticalChange === null ? 'Проверяем каждого получателя перед отправкой. История и баланс всегда доступны.' : 'Переводы и наличные снова доступны после проверки. Остановленные операции не отправляются автоматически.'}</p></div>`;
  tick();
}
function renderSecurityAlerts() {
  const target = $('#security-alerts');
  const alerts = state.securityAlerts || [];
  target.hidden = !state.securityLock && !alerts.length;
  if (state.securityLock) {
    target.innerHTML = `<article class="security-alert urgent"><div class="security-alert-heading">${icon('alert')}<h2>${ui.role === 'employee' ? 'Срочная тревога: возможный захват аккаунта' : 'Сообщение принято. Деньги под защитой'}</h2></div><p>Клиент не признал событие: <b>${esc(state.securityLock.eventText)}</b>. ${date(state.securityLock.at)} МСК.</p><p>${ui.role === 'employee' ? 'Создано срочное обращение в разделе «Операции». Проверьте события и свяжитесь с клиентом по ранее проверенному каналу. Ответ на обращение не разблокирует счёт.' : 'Другие сессии завершены. В банк отправлено срочное обращение — ответ появится в истории. Свяжитесь с банком по проверенному каналу; не используйте номер из подозрительного сообщения.'}</p></article>`;
    return;
  }
  target.innerHTML = alerts.slice(0, 3).map(a => `<article class="security-alert"><div class="security-alert-heading">${icon('alert')}<h2>${esc(a.text)}</h2></div><p>${date(a.at)} МСК. Если вы не совершали это действие, сообщите банку.</p><p class="old-session-note">Это предупреждение отображается только в старых сессиях — открытых до события. В сессии, где выполнено действие, кнопки нет.</p><button type="button" class="button danger" data-report-security="${esc(a.id)}">Это был не я</button></article>`).join('');
}
function tick() {
  const remaining = protectionOf(state, now()).remainingMs;
  if ($('#countdown')) {
    const secs = Math.ceil(remaining / 1000);
    $('#countdown').textContent = [Math.floor(secs / 3600), Math.floor(secs % 3600 / 60), secs % 60].map(x => String(x).padStart(2, '0')).join(':');
  }
  if ($('#demo-clock')) $('#demo-clock').textContent = `${date(now())} МСК · серверное время демо`;
}
const navItems = {
  client: [['transfer', 'transfer', 'Переводы'], ['assistant', 'message', 'ИИ-помощник'], ['security', 'lock', 'Безопасность'], ['history', 'history', 'История']],
  employee: [['cases', 'shield', 'Операции'], ['registry', 'list', 'Реестр'], ['events', 'history', 'Журнал']]
};
const titles = {
  transfer: ['Переводы и наличные', 'Управляйте деньгами. Мы позаботимся о проверке.'],
  assistant: ['ИИ-помощник по безопасности', 'Разберём ситуацию и заметим признаки известных схем обмана.'],
  security: ['Безопасность аккаунта', 'Данные доступа и защита после их изменения.'],
  history: ['История и обращения', 'Все операции, решения системы и ответы банка.'],
  cases: ['Контроль операций', 'Видно каждое решение: основание, получатель и результат.'],
  registry: ['Подозрительные получатели', 'Демонстрационная база для проверки переводов.'],
  events: ['Журнал событий', 'Хронология изменений данных, проверок и обращений.']
};
function render() {
  wasActive = protectionOf(state, now()).active;
  if (!navItems[account.role].some(([id]) => id === ui.page)) ui.page = account.role === 'employee' ? 'cases' : 'transfer';
  $('#nav-caption').textContent = ui.role === 'client' ? 'МОЙ БАНК' : 'РАБОЧЕЕ МЕСТО';
  $('#eyebrow').textContent = ui.role === 'client' ? 'ЛИЧНЫЙ КАБИНЕТ' : 'АНТИФРОД · ДЕМО СОТРУДНИКА';
  $('#profile-name').textContent = account.name;
  $('#profile-description').textContent = ui.role === 'client' ? 'Демонстрационный клиент' : 'Клиент: Анна Ковалёва';
  $('#navigation').innerHTML = navItems[ui.role].map(([id, symbol, title]) => `<button type="button" data-page="${id}" class="${ui.page === id ? 'active' : ''}" ${ui.page === id ? 'aria-current="page"' : ''}>${icon(symbol)}${title}</button>`).join('');
  $('#page-title').textContent = titles[ui.page][0]; $('#page-description').textContent = titles[ui.page][1];
  renderBanner();
  const views = { transfer: transferView, assistant: assistantView, security: securityView, history: historyView, cases: employeeView, registry: registryView, events: eventsView };
  $('#workspace').innerHTML = views[ui.page]();
  if (ui.role === 'employee' && ui.page === 'cases') $('#workspace').insertAdjacentHTML('afterbegin', classifierControls() + staffReviewQueue() + staffAssistantReports());
  if (ui.role === 'client' && ['transfer', 'history'].includes(ui.page)) $('#workspace').insertAdjacentHTML('afterbegin', clientReviewQueue());
  if (ui.role === 'client') {
    const pending = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW');
    document.querySelectorAll('.review-queue .review-card').forEach((card, i) => { if (pending[i]) card.insertAdjacentHTML('beforeend', `<button class="button secondary small ai-open" type="button" data-ai-operation="${esc(pending[i].id)}">Обсудить перевод с ИИ</button>`); });
  }
  if (state.securityLock && $('.balance-bottom span')) $('.balance-bottom span').textContent = 'Демо-баланс · списания заблокированы';
  if (ui.page === 'security' && !state.securityLock) $('#workspace').insertAdjacentHTML('afterbegin', '<p class="notice">Предупреждение «Это был не я» отображается только в старых сессиях — открытых до нового входа или изменения данных. В сессии, совершившей действие, кнопки нет.</p>');
  updateRecipientInfo();
  if (ui.role === 'client' && ui.page === 'transfer') $('#workspace').insertAdjacentHTML('afterbegin', '<p class="notice">Для быстрой проверки выберите получателя «Тест · Нормальный перевод», «Тест · Нужно проверить · ИИ-помощник» или «Тест · Блокировка перевода». У них фиксированные демонстрационные классы — менять режим у сотрудника не нужно.</p>');
  if (ui.role === 'employee' && ui.page === 'cases') $('#workspace').insertAdjacentHTML('afterbegin', '<p class="notice">Три получателя «Тест · …» имеют фиксированные классы независимо от режима ниже. Для остальных получателей работает выбранный режим заглушки.</p>');
  if (ui.aiModalOperationId && $('#dialog').open) renderAssistantDialog();
}
function balanceCard() { return `<div class="panel balance-card"><div class="balance-top"><span>Мастер-счёт · RUB</span><span class="mini-shield">${icon('shield')} Защищён</span></div><strong id="balance">${money(state.balance)}</strong><div class="balance-bottom"><span>Доступный демо-баланс</span><b>•• 4812</b></div></div>`; }
function policyView() {
  const active = protectionOf(state, now()).active;
  return `<div class="aside-grid"><div class="panel"><div class="policy-title"><h2>Что доступно сейчас</h2>${icon('shield')}</div>${[
    ['user', 'Прежние получатели', 'После проверки по реестру', true], ['transfer', 'Новые получатели', active ? 'Пауза на 24 часа' : 'После проверки по реестру', !active], ['cash', 'Снятие наличных', active ? 'До окончания паузы' : 'После подтверждения', !active], ['history', 'Баланс и история', 'Без ограничений', true]
  ].map(([symbol, title, text, allowed]) => { const locked = state.securityLock && symbol !== 'history'; return `<div class="policy-item"><span class="policy-icon">${icon(symbol)}</span><div><b>${title}</b><p>${locked ? 'Сообщение «Это был не я»' : text}</p></div><span class="availability ${locked || !allowed ? 'closed' : ''}">${locked ? 'Блокировка' : allowed ? 'Доступно' : 'Пауза'}</span></div>`; }).join('')}<p class="aside-note">Старый получатель — тот, кому вы успешно переводили до изменения данных. Совпадение в реестре останавливает любой перевод.</p></div><div class="panel support-card"><h3>${icon('message')} Банк рядом</h3><p>Откройте остановленную операцию и создайте обращение. Ответ сотрудника появится в истории.</p><button class="link-button" data-page="history">История и обращения →</button></div></div>`;
}
function transferView() {
  const options = allRecipients().map(r => `<option value="${esc(r.id)}" ${ui.recipient === r.id ? 'selected' : ''}>${esc(r.name)} · ${isKnown(state, r.id, now()) ? 'прежний' : 'новый'}</option>`).join('');
  return `<div class="grid-main"><div>${balanceCard()}<section class="panel"><h2>Новая операция</h2><div class="segment" role="group" aria-label="Тип операции"><button data-kind="transfer" type="button" class="${ui.kind === 'transfer' ? 'active' : ''}">${icon('transfer')} Перевод</button><button data-kind="cash" type="button" class="${ui.kind === 'cash' ? 'active' : ''}">${icon('cash')} Наличные</button></div><form id="operation-form" novalidate>${ui.kind === 'transfer' ? `<label class="field-label" for="recipient">Кому переводим</label><select id="recipient" name="recipient">${options}<option value="custom" ${ui.recipient === 'custom' ? 'selected' : ''}>Другой получатель по демо-ID</option></select><div id="custom-recipient" ${ui.recipient === 'custom' ? '' : 'hidden'}><label class="field-label" for="custom-id">Демонстрационный ID</label><input id="custom-id" maxlength="50" placeholder="DEMO-NEW-002" value="${esc(ui.customId)}"><label class="field-label" for="custom-name">Имя для истории</label><input id="custom-name" maxlength="80" placeholder="Новый получатель" value="${esc(ui.customName)}"></div><div class="recipient-meta" id="recipient-info"></div>` : `<div class="notice">${icon('cash')} Демонстрация снятия наличных. Банкомат и карта не подключены.</div>`}<label class="field-label" for="amount">Сумма, ₽</label><input class="amount-input" id="amount" inputmode="decimal" autocomplete="off" value="${esc(ui.amount)}" aria-describedby="amount-help"><p class="field-help" id="amount-help">${ui.kind === 'transfer' ? 'Комиссия в демо — 0 ₽' : 'Деньги списываются только после подтверждения'}</p><p id="form-error" class="dialog-error" role="alert"></p><button class="button full" type="submit">Проверить ${ui.kind === 'transfer' ? 'перевод' : 'снятие'} ${icon('arrow')}</button><p class="secure-caption">${icon('lock')} Сначала проверка, затем подтверждение</p></form></section></div><aside>${policyView()}</aside></div>${operationsTable(state.operations.slice(0, 5), false, 'Последние операции')}`;
}
const scenarioNames = { none: 'Явная схема не выявлена', unknown: 'Недостаточно данных', safe_account: 'Безопасный счёт', law_enforcement: 'Требование от имени МВД / госоргана', phishing: 'Фишинг', remote_access: 'Удалённый доступ', impersonation: 'Подмена знакомого', investment: 'Лжеинвестиции', loan_pressure: 'Кредит под давлением', cash_courier: 'Наличные для курьера' };
function aiAssessmentView(a) {
  if (!a) return '';
  return `<div class="ai-assessment ${a.class}"><span class="pill ${a.class === 'block' ? 'red' : a.class === 'normal' ? 'green' : 'amber'}">Рекомендация ИИ: ${esc(classNames[a.class])}</span><h3>${esc(scenarioNames[a.scenario])}</h3><p>${esc(a.explanation)}</p>${a.evidence?.length ? `<p class="ai-evidence">Основания из ваших ответов: ${a.evidence.map(x => `«${esc(x)}»`).join('; ')}</p>` : ''}<small>Предварительная оценка · ${esc(a.model_version)}. Не гарантирует безопасность и не разрешает платёж.</small></div>`;
}
function aiTurnsView(c) {
  return c.turns.map(t => `<div class="ai-message user"><b>Клиент</b><p>${esc(t.message)}</p></div><div class="ai-message bot"><b>ИИ-помощник</b>${t.status === 'processing' ? '<p role="status">Анализируем объяснение… Если ответ не появился, обновите страницу или начните новый диалог через минуту.</p>' : t.error ? `<p class="dialog-error">${esc(t.error)}</p>` : `${aiAssessmentView(t.response)}${t.response?.next_question ? `<p class="ai-question">${esc(t.response.next_question)}</p>` : ''}`}</div>`).join('');
}
function openAssistantDialog(operation) {
  if (account.role !== 'client' || !needsAssistantReview(operation)) return;
  if (ui.aiBusy) { toast('Дождитесь завершения текущей ИИ-проверки'); return; }
  ui.aiModalOperationId = operation.id;
  ui.aiOperationId = operation.id;
  ui.aiConversationId = state.aiConversations?.find(c => c.operationId === operation.id)?.id || null;
  ui.aiDraft = ''; ui.aiRequestId = null; ui.aiConsent = false;
  // Only one chat form may exist: the modal replaces the standalone assistant surface.
  if (ui.page === 'assistant') ui.page = 'transfer';
  render();
  renderAssistantDialog();
}
function renderAssistantDialog() {
  const op = state.operations.find(o => o.id === ui.aiModalOperationId);
  const status = reviewStatus(op);
  const c = state.aiConversations?.find(c => c.id === ui.aiConversationId && c.operationId === ui.aiModalOperationId);
  const finished = c?.status === 'complete', processing = ui.aiBusy || c?.status === 'processing';
  const tone = op?.status === 'blocked' ? 'red' : op?.review?.status === 'approved' ? 'green' : 'amber';
  const form = status.canChat && !finished ? `<form id="ai-chat-form"><label class="field-label" for="ai-message">Ваш ответ помощнику</label><textarea id="ai-message" maxlength="1200" required placeholder="Опишите цель перевода и кто его предложил" ${processing ? 'disabled' : ''}>${esc(ui.aiDraft)}</textarea><label class="ai-consent"><input type="checkbox" id="ai-consent" ${ui.aiConsent ? 'checked' : ''} required ${processing ? 'disabled' : ''}><span>Согласен отправить текст в Groq для анализа и сохранить диалог для сотрудника банка. Использую только вымышленные данные.</span></label><button type="submit" class="button full" ${processing || !assistantConfig?.configured ? 'disabled' : ''}>${processing ? 'Ждём ответ модели…' : 'Отправить ответ'}</button></form>` : '';
  showDialog(status.title, `<p class="review-lead">${esc(status.text)}</p>${op ? `<div class="dialog-facts"><div><span>Операция</span><b>${esc(op.id)}</b></div><div><span>Получатель</span><b>${esc(op.recipientName)}</b></div><div><span>Сумма</span><b>${money(op.amount)}</b></div></div>` : ''}<div class="review-chat"><div class="section-head"><h3>ИИ-помощник службы безопасности</h3><span class="pill blue">Qwen · Groq</span></div><div class="ai-message bot"><b>Проверка обстоятельств перевода</b><p>${esc(reviewGreeting(account.name))}</p></div>${c ? aiTurnsView(c) : ''}</div>${status.canChat && finished ? '<p class="notice">Ответы приняты и доступны сотруднику банка. Ожидайте его решения. Ответ ИИ сам по себе не разрешает перевод и не снимает ограничения.</p>' : ''}${status.canChat && !assistantConfig?.configured ? '<p class="notice error">ИИ-помощник временно недоступен. Обратитесь в банк; перевод не разрешён автоматически.</p>' : ''}${form ? `<details class="review-privacy"><summary>Об обработке данных и ограничениях ИИ</summary><p>Текст будет передан внешнему ИИ-сервису Groq. Модель может ошибаться. Не вводите ФИО, телефоны, реквизиты, пароли или SMS-коды. Скрытие данных не гарантирует полную анонимность. Деньги помощник не отправляет.</p></details>${form}` : ''}<div class="dialog-actions">${op?.review?.status === 'approved' && needsAssistantReview(op) ? `<button type="button" class="button" data-resume-reviewed="${esc(op.id)}">Продолжить подтверждение</button>` : ''}${op && op.status !== 'completed' ? `<button type="button" class="button secondary" data-support="${esc(op.id)}">Обратиться в банк</button>` : ''}<button type="button" class="button subtle" data-close>Закрыть окно</button></div><p class="field-help">Закрытие окна не отменяет проверку и не отправляет деньги. Вернуться к диалогу можно из карточки операции.</p>`, 'lock', tone, true);
}
function assistantView() {
  const c = state.aiConversations?.find(c => c.id === ui.aiConversationId);
  const pending = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW');
  const finished = c?.status === 'complete', processing = ui.aiBusy || c?.status === 'processing';
  return `<div class="assistant-layout"><section class="panel"><div class="section-head"><h2>Проверим обстоятельства перевода</h2><span class="pill blue">Qwen · Groq</span></div><p class="panel-subtitle">Помощник уточняет ситуацию за 1–4 ответа. Для хакатона используйте только вымышленные данные.</p><div class="notice warning">Это внешний ИИ-сервис, он может ошибаться. Не вводите ФИО, телефоны, номера карт, пароли и SMS-коды. Автоматическое скрытие данных не гарантирует полную анонимность.</div>${!assistantConfig?.configured ? '<div class="notice error">Серверный ключ модели не настроен. Обратитесь к сотруднику.</div>' : ''}${c ? `<p class="field-help">${c.operationId ? `Проверка перевода ${esc(c.operationId)}. Опасная рекомендация остановит только этот ожидающий перевод.` : 'Общая проверка ситуации: она не привязана к переводу и не блокирует операции.'}</p>${aiTurnsView(c)}` : `<label class="field-label" for="ai-operation">Какую ситуацию проверяем</label><select id="ai-operation"><option value="">Общая проверка ситуации</option>${pending.map(op => `<option value="${esc(op.id)}" ${ui.aiOperationId === op.id ? 'selected' : ''}>${esc(op.id)} · ${esc(op.recipientName)} · ${money(op.amount)}</option>`).join('')}</select><div class="ai-message bot"><b>ИИ-помощник</b><p>Кому и зачем вы переводите деньги? Кто предложил перевод и знакомы ли вам эти реквизиты?</p></div>`}${finished ? '<p class="notice">Оценка завершена. Результат доступен сотруднику банка; он не заменяет проверку личности и не снимает ограничения.</p>' : `<form id="ai-chat-form"><label class="field-label" for="ai-message">Ваш ответ</label><textarea id="ai-message" maxlength="1200" required placeholder="Опишите вымышленную ситуацию своими словами" ${processing ? 'disabled' : ''}>${esc(ui.aiDraft)}</textarea><label class="ai-consent"><input type="checkbox" id="ai-consent" ${ui.aiConsent ? 'checked' : ''} required ${processing ? 'disabled' : ''}><span>Согласен отправить текст объяснения в Groq для анализа и сохранить диалог для сотрудника банка. Реальные персональные и банковские данные не ввожу.</span></label><button type="submit" class="button" ${processing || !assistantConfig?.configured ? 'disabled' : ''}>${processing ? 'Ждём ответ модели…' : 'Отправить ИИ'}</button></form>`}<button type="button" class="link-button ai-open" id="ai-new" ${ui.aiBusy ? 'disabled' : ''}>Начать новый диалог</button></section><aside class="panel ai-about"><h2>Что проверяем</h2><p>«Безопасный счёт», требования от имени МВД, фишинг, удалённый доступ, подмену близкого, лжеинвестиции, навязанный кредит и передачу наличных.</p><h3>Как действует защита</h3><p>ИИ не отправляет деньги. Благоприятный ответ не отменяет паузу, реестр или решение классификатора переводов.</p><h3>Недавние диалоги</h3>${(state.aiConversations || []).slice(0, 8).map(x => `<button class="link-button ai-history" type="button" data-ai-conversation="${esc(x.id)}">${esc(date(x.createdAt))} · ${esc(x.operationId || 'Общая проверка')}</button>`).join('') || '<p>Диалогов пока нет.</p>'}</aside></div>`;
}
function staffAssistantReports() {
  const conversations = (state.aiConversations || []).filter(c => c.assessment || c.status === 'error');
  return `<section class="panel model-panel"><div class="section-head"><h2>Предварительные проверки ИИ</h2><small>Последние ${Math.min(conversations.length, 5)}</small></div><p class="panel-subtitle">Рекомендация не является проверкой личности или разрешением платежа. Сверяйте её с ответами клиента и независимыми сигналами.</p>${conversations.slice(0, 5).map(c => `<details class="ai-report"><summary>${esc(c.operationId || 'Общая проверка')} · ${esc(date(c.createdAt))} · ${esc(c.assessment ? classNames[c.assessment.class] : 'Ошибка сервиса')}</summary>${c.operationId ? '' : '<p class="field-help">Без привязки к переводу; операций не блокирует.</p>'}${aiTurnsView(c)}</details>`).join('') || '<p class="empty">Клиент ещё не обращался к ИИ-помощнику.</p>'}</section>`;
}
function requestFromForm() {
  const r = allRecipients().find(r => r.id === ui.recipient);
  return { kind: ui.kind, amount: parseAmount(ui.amount), recipientId: ui.kind === 'cash' ? undefined : ui.recipient === 'custom' ? ui.customId.trim().toUpperCase() : ui.recipient, recipientName: ui.kind === 'cash' ? 'Наличные' : r?.name ?? (ui.customName.trim() || ui.customId.trim().toUpperCase()) };
}
function updateRecipientInfo() {
  if (!$('#recipient-info')) return;
  const request = requestFromForm();
  const known = isKnown(state, request.recipientId, now());
  const demoClass = allRecipients().find(r => r.id === request.recipientId)?.demoClass;
  $('#recipient-info').innerHTML = `<span class="pill ${known ? 'green' : 'blue'}">${icon('user')}${known ? 'Прежний получатель' : 'Новый получатель'}</span><span class="pill">${icon('shield')}Проверка перед отправкой</span><span class="pill">${esc(request.recipientId || 'Демо-ID не указан')}</span>`;
  if (demoClass) $('#recipient-info').insertAdjacentHTML('beforeend', `<span class="pill ${demoClass === 'normal' ? 'green' : demoClass === 'block' ? 'red' : 'amber'}">Тестовый класс: ${esc(classNames[demoClass])}</span><p class="field-help demo-recipient-note">Класс задан для демонстрации, не предсказан ML. Есть вымышленная история прежних переводов. Реестр и блокировка аккаунта имеют приоритет.</p>`);
}
function statusPill(op) { return `<span class="pill ${op.status === 'completed' ? 'green' : op.status === 'pending' ? 'amber' : 'red'}">${op.status === 'completed' ? 'Выполнено' : op.status === 'pending' ? 'На проверке' : 'Остановлено'}</span>${classificationPill(op.classification, op.seeded || op.kind !== 'transfer')}`; }
const classNames = { normal: 'Нормальный', review: 'Нужно проверить', block: 'Блокировка' };
function classificationPill(value, hide = false) {
  if (hide) return '';
  return `<span class="model-result pill ${value?.class === 'normal' ? 'green' : value?.class === 'block' ? 'red' : 'amber'}">${value ? `Класс: ${esc(classNames[value.class] || 'Неизвестен')}` : 'Классификатор: нет ответа'}</span>${value ? `<small class="model-source">${value.source === 'mock' ? 'Демо-заглушка' : 'ML-модель'} · ${esc(value.model_version)}</small>` : ''}`;
}
function classifierControls() {
  return `<section class="panel model-panel"><div class="section-head"><h2>Классификатор переводов</h2><span class="pill blue">Демо-заглушка · не ML</span></div><p class="panel-subtitle">Выберите ответ для новых проверок переводов. Клиент не управляет этим режимом. Пауза, реестр и блокировка аккаунта имеют приоритет.</p><form id="model-mode-form" class="model-controls"><div><label class="field-label" for="model-mode">Ответ заглушки</label><select id="model-mode">${[...Object.entries(classNames), ['unavailable', 'Сервис недоступен · проверка ошибки']].map(([value, label]) => `<option value="${value}" ${state.modelMock.mode === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div><button type="submit" class="button secondary">Применить режим</button></form><p class="field-help">Сейчас: ${esc(classNames[state.modelMock.mode] || 'Нет ответа сервиса')}. Изменение режима не отправляет и не разблокирует ранее остановленные переводы.</p></section>`;
}
function staffReviewQueue() {
  const pending = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW');
  return `<section class="panel review-queue"><div class="section-head"><h2>Проверка спорных переводов</h2><small>${pending.length} в очереди</small></div><p class="panel-subtitle">Разрешение сотрудника не списывает деньги. Клиент подтверждает исходную сумму и получателя отдельно; все ограничения проверяются заново.</p>${pending.length ? pending.map(op => `<article class="review-card"><div class="ticket-top"><b>${esc(op.id)}</b>${classificationPill(op.classification)}</div><p><b>${esc(op.recipientName)} · ${money(op.amount)}</b><br>${esc(date(op.createdAt))} МСК</p>${op.review?.status === 'approved' ? `<p class="notice">Разрешено подтверждение клиента в течение 15 минут. Деньги пока не списаны.</p><p>${esc(op.review.comment)}</p>` : `<form data-review-form="${esc(op.id)}"><label class="field-label" for="review-comment-${esc(op.id)}">Комментарий по результату проверки</label><textarea id="review-comment-${esc(op.id)}" name="comment" minlength="5" maxlength="1000" required placeholder="Проверьте обстоятельства и свяжитесь с клиентом по проверенному каналу">${esc(ui.answers['review-' + op.id] || '')}</textarea><div class="review-actions"><button type="submit" class="button" data-verdict="approve">Разрешить подтверждение</button><button type="submit" class="button danger" data-verdict="reject">Отклонить перевод</button></div></form>`}</article>`).join('') : '<p class="empty">Переводов класса «Нужно проверить» пока нет.</p>'}</section>`;
}
function clientReviewQueue() {
  const pending = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW');
  if (!pending.length) return '';
  return `<section class="panel review-queue"><h2>Переводы на дополнительной проверке</h2><p class="panel-subtitle">Деньги остаются на счёте. Результат классификации сейчас имитируется заглушкой.</p>${pending.map(op => `<article class="review-card"><div class="ticket-top"><b>${esc(op.recipientName)} · ${money(op.amount)}</b>${classificationPill(op.classification)}</div><p>${esc(op.reason)}</p>${op.review?.comment ? `<p class="reply">${esc(op.review.comment)}</p>` : ''}${op.review?.status === 'approved' ? `<button type="button" class="button" data-resume-reviewed="${esc(op.id)}">Подтвердить проверенный перевод</button>` : '<span class="pill amber">Ожидает решения сотрудника</span>'}</article>`).join('')}</section>`;
}
function operationsTable(ops, employee = false, title = 'Операции') {
  return `<section class="panel history"><div class="section-head"><h2>${esc(title)}</h2><small>${ops.length} записей</small></div><div class="table-wrap"><table class="${employee ? 'employee-table' : 'client-table'}"><thead><tr><th>Получатель / операция</th><th class="money">Сумма</th>${employee ? '<th>Основание</th>' : ''}<th>Статус</th><th></th></tr></thead><tbody>${ops.length ? ops.map(op => `<tr><td><div class="recipient-cell"><span class="recipient-avatar">${icon(op.kind === 'cash' ? 'cash' : 'user')}</span><div>${esc(op.recipientName)}<small>${esc(date(op.createdAt))}${op.seeded ? ' · демо-история' : ''}</small></div></div></td><td class="money">${money(op.amount)}</td>${employee ? `<td class="reason-column">${esc(op.reason)}<small>${esc(op.code)} · ${op.kind === 'cash' ? 'Наличные' : op.knownAtDecision ? 'Прежний получатель' : 'Новый получатель'}</small></td>` : ''}<td>${statusPill(op)}</td><td><button type="button" class="link-button" data-operation="${esc(op.id)}" aria-label="Подробнее об операции ${esc(op.id)}">Подробнее</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Новых операций пока нет. Создайте перевод в кабинете клиента.</td></tr>'}</tbody></table></div></section>`;
}
function securityView() {
  if (state.securityLock) return `<section class="panel"><h2>Доступ защищён после вашего сообщения</h2><p>Смена номера и восстановление доступа временно недоступны. Все переводы и наличные заблокированы. Сотрудник получил срочное обращение.</p><button type="button" class="button secondary" data-page="history">Открыть обращение</button><p>Предупреждение «Это был не я» отображается только в старых сессиях, открытых до события, и не показывается в сессии, совершившей действие.</p>${eventList(state.events.slice(0, 6))}</section>`;
  return `<div class="security-layout"><section class="panel"><h2>Данные доступа</h2><p class="panel-subtitle">Изменение запускает защитную паузу на 24 часа.</p><div class="setting-row"><span class="policy-icon">${icon('phone')}</span><div><b>Номер телефона</b><p id="current-phone">${esc(state.phone)}</p></div><button type="button" class="button secondary small" data-change-phone>Изменить</button></div><div class="setting-row"><span class="policy-icon">${icon('lock')}</span><div><b>Восстановление доступа</b><p>Смена способа подтверждения</p></div><button type="button" class="button secondary small" id="restore-access">Восстановить</button></div><div class="security-illustration">${icon('shield')}<p>После изменения данных прежние получатели остаются доступны. Новые переводы и наличные — через 24 часа.</p></div><p class="aside-note">При повторном изменении 24 часа отсчитываются заново. Истечение времени не отправляет ранее остановленные операции.</p></section><section class="panel"><h2>Последние события</h2>${eventList(state.events.filter(e => ['phone', 'recovery', 'time'].includes(e.type)).slice(0, 6))}</section></div>`;
}
function ticketView(employee = false) {
  return `<section class="panel"><div class="section-head"><h2>${employee ? 'Обращения клиента' : 'Ваши обращения'}</h2><small>${state.tickets.filter(t => t.status === 'open').length} открыто</small></div>${state.tickets.length ? state.tickets.map(t => {
    const op = state.operations.find(o => o.id === t.operationId);
    return `<article class="ticket ${t.kind === 'security' ? 'security-ticket' : ''}"><div class="ticket-top"><b>${esc(t.id)}</b>${t.kind === 'security' ? '<span class="pill red">Срочно · захват аккаунта</span>' : ''}<span class="pill ${t.status === 'open' ? 'amber' : 'green'}">${t.status === 'open' ? 'Ожидает ответа' : 'Есть ответ'}</span></div>${t.kind === 'security' ? `<p><b>Клиент сообщил «Это был не я»</b><br>${esc(t.eventText)} · ${date(t.eventAt)} МСК.<br>Все переводы и наличные заблокированы. Другие сессии завершены. Ответ не снимает блокировку.</p>` : `<p>${esc(op?.recipientName)} · ${money(op?.amount ?? 0)}<br>${esc(op?.reason)}</p>`}${t.reply ? `<p class="reply">${esc(t.reply)}</p><small class="muted">Сотрудник · ${date(t.answeredAt)}</small>` : employee ? `<form data-ticket="${esc(t.id)}"><label class="field-label" for="reply-${esc(t.id)}">Ответ клиенту</label><textarea id="reply-${esc(t.id)}" maxlength="1000" required placeholder="Объясните причину ограничения и дальнейшие действия">${esc(ui.answers[t.id] || '')}</textarea><button class="button small" type="submit">Отправить ответ</button></form>` : '<small class="muted">Ответ появится здесь после обработки сотрудником.</small>'}</article>`;
  }).join('') : '<p class="empty">Откройте остановленную операцию и нажмите «Обратиться в банк».</p>'}</section>`;
}
function historyView() { return `<div class="stack">${operationsTable(state.operations, false, 'История операций')}${ticketView()}</div>`; }
function employeeView() {
  const live = state.operations.filter(o => !o.seeded);
  const stopped = live.filter(o => o.status === 'blocked' || o.status === 'pending');
  const filtered = ui.filter === 'all' ? live : live.filter(o => o.status === ui.filter);
  return `<div class="stats"><div class="panel stat"><p>Проверено операций</p><strong>${live.length}</strong><small>В текущей демонстрации</small></div><div class="panel stat"><p>Остановлено / на проверке</p><strong>${stopped.length}</strong><small>Не означает подтверждённый фрод</small></div><div class="panel stat"><p>Сумма остановленных попыток</p><strong>${money(stopped.reduce((sum, o) => sum + o.amount, 0))}</strong><small>Повторные попытки учитываются отдельно</small></div></div><div class="panel"><div class="bank-profile"><span class="user-icon">АК</span><div><b>Анна Ковалёва · счёт •• 4812</b><p>${esc(state.phone)} · баланс ${money(state.balance)}</p></div></div><label for="operation-filter" class="field-label">Показать операции</label><select id="operation-filter">${[['all', 'Все решения'], ['blocked', 'Остановленные'], ['pending', 'На проверке'], ['completed', 'Выполненные']].map(([id, label]) => `<option value="${id}" ${ui.filter === id ? 'selected' : ''}>${label}</option>`).join('')}</select><p class="field-help">Пауза действует до указанного срока. Ответ сотрудника не снимает её.</p></div>${operationsTable(filtered, true, 'Решения системы')}<div style="margin-top:22px">${ticketView(true)}</div>`;
}
function registryView() {
  const entries = registry();
  return `<div class="stack"><section class="panel"><div class="section-head"><h2>Демонстрационный реестр</h2><span class="registry-count">${entries?.length ?? 0} записей</span></div><p class="panel-subtitle">Точное совпадение ID останавливает перевод. Это относится и к прежним получателям.</p>${entries === null ? '<div class="notice error">Не удалось завершить загрузку реестра. Переводы остаются на проверке. <button class="link-button" id="retry-registry">Повторить загрузку</button></div>' : `<div class="table-wrap"><table class="registry-table"><thead><tr><th>Получатель</th><th>Причина включения</th><th>Статус</th></tr></thead><tbody>${entries.map(e => `<tr><td>${esc(e.display_name)}<small class="registry-code">${esc(e.recipient_id)}</small></td><td class="reason-column">${esc(e.reason)}</td><td><span class="pill red">Активная запись</span></td></tr>`).join('')}</tbody></table></div>`}<p class="aside-note">Источник: вымышленные сценарии хакатона. Реестр не подключён к базе Банка России.</p></section><section class="panel"><h2>Добавить получателя</h2><p class="panel-subtitle">Новая запись сразу участвует в проверках обеих вкладок.</p><form id="registry-form"><div class="inline-fields"><div><label class="field-label" for="registry-id">Демонстрационный ID</label><input id="registry-id" required pattern="DEMO-[A-Za-z0-9_-]{1,40}" maxlength="45" placeholder="DEMO-NEW-001"></div><div><label class="field-label" for="registry-name">Имя получателя</label><input id="registry-name" required maxlength="80" placeholder="Продавец велосипеда"></div><div class="span-full"><label class="field-label" for="registry-reason">Причина включения</label><input id="registry-reason" required maxlength="300" placeholder="Подозрительная операция в демонстрационном сценарии"></div></div><p class="dialog-error" id="registry-error" role="alert"></p><button type="submit" class="button" ${entries === null ? 'disabled' : ''}>Добавить в демо-реестр</button></form></section></div>`;
}
function eventList(events) { return events.length ? `<ol class="timeline">${events.map(e => `<li><div><p>${esc(e.text)}</p><small>${date(e.at)} МСК · ${esc(e.actor)}</small></div></li>`).join('')}</ol>` : '<p class="empty">Изменений данных пока нет.</p>'; }
function eventsView() { return `<section class="panel"><h2>Действия клиента и сотрудника</h2><p class="panel-subtitle">Общий журнал для обеих ролей. Новые события сверху.</p>${eventList(state.events)}</section>`; }
function phoneDialog() {
  showDialog('Сменить номер телефона', `<p>Переводы новым получателям и снятие наличных будут недоступны 24 часа. Прежние получатели останутся доступны после проверки.</p><form id="phone-form"><label class="field-label" for="new-phone">Новый демонстрационный номер</label><input id="new-phone" required inputmode="tel" maxlength="25" value="${state.phone === '+7 000 000-00-02' ? '+7 000 000-00-03' : '+7 000 000-00-02'}"><p class="field-help">Используйте вымышленные данные. Никаких SMS не отправляется.</p><p id="phone-error" class="dialog-error" role="alert"></p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button class="button" type="submit">Сохранить номер</button></div></form>`, 'phone');
}
function decisionDialog(decision, request, operation, readOnly = false) {
  if (account.role === 'client' && needsAssistantReview(operation)) { openAssistantDialog(operation); return; }
  const completed = operation?.status === 'completed';
  const title = completed ? (request.kind === 'cash' ? 'Наличные выданы в демо' : 'Перевод выполнен') : decision.code === 'RISK_REGISTRY' ? 'Получатель в демо-реестре' : decision.code === 'REGISTRY_UNAVAILABLE' ? 'Проверка не завершена' : 'Операция остановлена';
  showDialog(title, `<p>${esc(completed ? operation.reason : decision.reason)}</p><div class="dialog-facts"><div><span>${request.kind === 'cash' ? 'Операция' : 'Получатель'}</span><b>${esc(request.recipientName)}</b></div><div><span>Сумма</span><b>${money(request.amount)}</b></div>${!completed && decision.endsAt && ['CASH_HOLD', 'NEW_RECIPIENT_HOLD'].includes(decision.code) ? `<div><span>Пауза до</span><b>${date(decision.endsAt)} МСК</b></div>` : ''}${decision.registryReason ? `<div><span>Основание</span><b>${esc(decision.registryReason)}</b></div>` : ''}</div><p>${completed ? `Остаток: ${money(state.balance)}.` : 'Деньги не списаны. Операция не будет выполнена автоматически.'}</p><div class="dialog-actions">${operation && !completed && ui.role === 'client' ? `<button type="button" class="button secondary" data-support="${esc(operation.id)}">Обратиться в банк</button>` : ''}<button type="button" class="button" data-close>${completed ? 'Готово' : readOnly ? 'Закрыть' : 'Понятно'}</button></div>`, completed ? 'check' : 'lock', completed ? 'green' : decision.code === 'RISK_REGISTRY' ? 'red' : 'amber');
  if (request.kind === 'transfer') $('#dialog-title').insertAdjacentHTML('afterend', classificationPill(decision.classification ?? operation?.classification));
  if (!completed && operation?.status === 'pending' && operation.code === 'MODEL_REVIEW') $('#dialog-title').textContent = 'Перевод на проверке сотрудника';
  if (!completed && decision.code === 'MODEL_BLOCK') { $('#dialog-title').textContent = 'Перевод заблокирован'; $('#dialog .dialog-symbol').classList.remove('amber'); $('#dialog .dialog-symbol').classList.add('red'); }
  if (ui.role === 'client' && operation?.status === 'pending' && operation.code === 'MODEL_REVIEW') $('#dialog .dialog-actions').insertAdjacentHTML('afterbegin', `<button type="button" class="button secondary" data-ai-operation="${esc(operation.id)}">Обсудить с ИИ</button>`);
}
let pendingRequest = null;
async function submitOperation() {
  const request = requestFromForm();
  request.requestId = crypto.randomUUID();
  if (request.amount === null) { $('#form-error').textContent = 'Введите положительную сумму, не более двух знаков после запятой.'; return; }
  const result = await action('attempt', request);
  if (['INVALID_AMOUNT', 'INVALID_RECIPIENT', 'INVALID_KIND'].includes(result.decision.code)) { $('#form-error').textContent = result.decision.reason; return; }
  if (!result.decision.allowed) { decisionDialog(result.decision, request, result.operation); return; }
  pendingRequest = request;
  showDialog(request.kind === 'cash' ? 'Подтвердите снятие' : 'Подтвердите перевод', `<p>${esc(result.decision.reason)}</p><div class="dialog-facts"><div><span>${request.kind === 'cash' ? 'Операция' : 'Получатель'}</span><b>${esc(request.recipientName)}</b></div><div><span>Сумма</span><b>${money(request.amount)}</b></div></div><p>При подтверждении спишется только демонстрационный баланс.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button" id="confirm-operation">Подтвердить</button></div>`, request.kind === 'cash' ? 'cash' : 'transfer');
  if (request.kind === 'transfer') $('#dialog-title').insertAdjacentHTML('afterend', classificationPill(result.classification));
}
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.hasAttribute('data-close')) { closeDialog(); return; }
    if (b.id === 'logout') { await api('/api/auth/logout', {}); location.replace('/login'); return; }
    if (b.dataset.aiOperation) { const op = state.operations.find(o => o.id === b.dataset.aiOperation); openAssistantDialog(op); return; }
    if (b.dataset.aiConversation) { ui.page = 'assistant'; ui.aiConversationId = b.dataset.aiConversation; ui.aiDraft = ''; ui.aiRequestId = null; render(); }
    if (b.id === 'ai-new') { ui.aiConversationId = null; ui.aiOperationId = ''; ui.aiDraft = ''; ui.aiRequestId = null; render(); }
    if (b.dataset.resumeReviewed) {
      const op = state.operations.find(op => op.id === b.dataset.resumeReviewed);
      if (!op) return;
      showDialog('Подтвердите проверенный перевод', `<p>Сотрудник разрешил продолжить. При подтверждении сервер снова проверит ограничения.</p><div class="dialog-facts"><div><span>Получатель</span><b>${esc(op.recipientName)}</b></div><div><span>Сумма</span><b>${money(op.amount)}</b></div></div><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button" data-confirm-reviewed="${esc(op.id)}">Подтвердить перевод</button></div>`);
    }
    if (b.dataset.confirmReviewed) {
      b.disabled = true;
      try { const result = await action('confirm-reviewed', { operationId: b.dataset.confirmReviewed }); decisionDialog(result.decision, result.operation, result.operation); }
      finally { b.disabled = false; }
    }
    if (b.dataset.reportSecurity) {
      const alert = state.securityAlerts?.find(a => a.id === b.dataset.reportSecurity);
      if (!alert) return;
      showDialog('Это действие совершили не вы?', `<p>${esc(alert.text)} · ${date(alert.at)} МСК.</p><p>Будут заблокированы все переводы и снятие наличных, включая прежних получателей. Другие сессии завершатся. Сотрудник банка получит срочную тревогу.</p><p>Блокировка не снимается через 24 часа. Кнопка доступна только в старой сессии, открытой до события.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button danger" data-confirm-security="${esc(alert.id)}">Заблокировать операции</button></div>`, 'alert', 'red');
    }
    if (b.dataset.confirmSecurity) {
      b.disabled = true;
      try { await action('report-security', { alertId: b.dataset.confirmSecurity }); closeDialog(); pendingRequest = null; toast('Операции заблокированы. Сотруднику отправлена срочная тревога.'); }
      finally { b.disabled = false; }
    }
    if (b.dataset.page) { ui.page = b.dataset.page; render(); }
    if (b.dataset.kind) { ui.kind = b.dataset.kind; render(); }
    if (b.id === 'demo-change' || b.hasAttribute('data-change-phone')) phoneDialog();
    if (b.id === 'demo-forward') {
      await action('advance');
      toast(state.securityLock ? 'Прошло 24 часа. Блокировка «Это был не я» продолжает действовать.' : 'Прошло 24 часа. Новые операции снова проходят обычную проверку.');
    }
    if (b.id === 'demo-reset') showDialog('Начать демонстрацию заново?', '<p>Сбросится только это демо: баланс, операции, обращения, добавленные записи реестра и таймер. Базовые пять записей останутся.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button" id="confirm-reset">Начать заново</button></div>', 'history');
    if (b.id === 'confirm-reset') { await action('reset'); ui.recipient = 'DEMO-FAMILY-001'; ui.amount = '3 000'; ui.kind = 'transfer'; ui.answers = {}; pendingRequest = null; closeDialog(); toast('Демонстрация начата заново'); }
    if (b.id === 'restore-access') showDialog('Восстановить доступ?', '<p>Это демонстрация смены способа подтверждения. Начнётся новая пауза на 24 часа для новых получателей и наличных.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button class="button" type="button" id="confirm-recovery">Восстановить доступ</button></div>', 'lock');
    if (b.id === 'confirm-recovery') { await action('recovery'); closeDialog(); toast('Доступ восстановлен. Защитная пауза — 24 часа.'); }
    if (b.id === 'confirm-operation' && pendingRequest) {
      b.disabled = true;
      const request = pendingRequest; pendingRequest = null;
      const result = await action('confirm', request);
      decisionDialog(result.decision, request, result.operation);
    }
    if (b.dataset.operation) {
      const op = state.operations.find(x => x.id === b.dataset.operation);
      if (op) decisionDialog({ code: op.code, reason: op.reason, endsAt: op.holdEndsAt, registryReason: op.registryReason, classification: op.classification }, { kind: op.kind, recipientName: op.recipientName, amount: op.amount }, op, true);
    }
    if (b.dataset.support) { await action('ticket', { operationId: b.dataset.support }); closeDialog(); ui.page = 'history'; render(); toast('Обращение создано. Оно доступно сотруднику банка.'); }
    if (b.id === 'retry-registry') await loadRegistry();
  } catch (err) { toast(err.message); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'amount') ui.amount = e.target.value;
  if (e.target.id === 'ai-message') { ui.aiDraft = e.target.value; ui.aiRequestId = null; }
  if (e.target.id === 'custom-id') { ui.customId = e.target.value; updateRecipientInfo(); }
  if (e.target.id === 'custom-name') ui.customName = e.target.value;
  if (e.target.id?.startsWith('reply-')) ui.answers[e.target.id.slice(6)] = e.target.value;
  if (e.target.id?.startsWith('review-comment-')) ui.answers['review-' + e.target.id.slice(15)] = e.target.value;
});
document.addEventListener('change', e => {
  if (e.target.id === 'ai-operation') ui.aiOperationId = e.target.value;
  if (e.target.id === 'ai-consent') ui.aiConsent = e.target.checked;
  if (e.target.id === 'recipient') { ui.recipient = e.target.value; $('#custom-recipient').hidden = ui.recipient !== 'custom'; updateRecipientInfo(); }
  if (e.target.id === 'operation-filter') { ui.filter = e.target.value; render(); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    if (e.target.id === 'ai-chat-form') {
      if (ui.aiBusy) return;
      const message = ui.aiDraft.trim();
      if (!message || !ui.aiConsent) { toast('Напишите объяснение и подтвердите согласие'); return; }
      ui.aiRequestId ||= crypto.randomUUID();
      const payload = { message, consent: ui.aiConsent, requestId: ui.aiRequestId, conversationId: ui.aiConversationId, operationId: ui.aiConversationId ? undefined : ui.aiOperationId || undefined };
      ui.aiBusy = true; render();
      try {
        const result = await api('/api/assistant', payload);
        state = result.state; receivedAt = Date.now(); ui.aiConversationId = result.conversationId; ui.aiDraft = ''; ui.aiRequestId = null;
      } finally { ui.aiBusy = false; render(); }
    }
    if (e.target.id === 'model-mode-form') { await action('model-mode', { mode: $('#model-mode').value }); toast('Режим демонстрационной заглушки изменён'); }
    if (e.target.dataset.reviewForm) {
      const id = e.target.dataset.reviewForm, comment = $(`#review-comment-${id}`).value, verdict = e.submitter?.dataset.verdict;
      await action('review-transfer', { operationId: id, verdict, comment });
      toast(verdict === 'approve' ? 'Разрешено подтверждение клиентом. Деньги не списаны.' : 'Перевод отклонён. Деньги не списаны.');
    }
    if (e.target.id === 'operation-form') await submitOperation();
    if (e.target.id === 'phone-form') {
      const phone = $('#new-phone').value.trim();
      if (!/^\+?[\d ()-]{10,25}$/.test(phone) || phone.replace(/\D/g, '').length !== 11 || phone.replace(/\D/g, '') === state.phone.replace(/\D/g, '')) { $('#phone-error').textContent = 'Укажите другой номер из 11 цифр.'; return; }
      await action('phone', { phone }); closeDialog(); toast('Номер изменён. Защитная пауза включена на 24 часа.');
    }
    if (e.target.id === 'registry-form') {
      const entry = { recipient_id: $('#registry-id').value, display_name: $('#registry-name').value, reason: $('#registry-reason').value };
      try { await action('registry-add', { entry }); toast('Получатель добавлен в реестр. Проверка уже действует.'); }
      catch (err) { $('#registry-error').textContent = err.message; }
    }
    if (e.target.dataset.ticket) { const id = e.target.dataset.ticket; const reply = ui.answers[id] || ''; await action('reply', { ticketId: id, reply }); toast('Ответ отправлен клиенту'); }
  } catch (err) { toast(err.message); }
});
async function loadRegistry(redraw = true) {
  if (account.role !== 'employee') return;
  registryStatus = 'loading';
  try {
    const data = await api('/api/registry');
    baseRegistry = data.entries; registryStatus = 'ready';
  } catch { baseRegistry = null; registryStatus = 'error'; }
  if (redraw) render();
}
$('#dialog').addEventListener('close', () => { pendingRequest = null; ui.aiModalOperationId = null; $('#dialog').classList.remove('assistant-dialog'); });
render(); if (account.role === 'employee') loadRegistry();
$('#logout').disabled = false;
setInterval(() => { const active = protectionOf(state, now()).active; if (active !== wasActive) { wasActive = active; render(); } else tick(); }, 1000);
let refreshing = false;
setInterval(async () => {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try {
    const me = await api('/api/auth/me');
    if (me.user.id !== account.id) { location.replace(me.user.role === 'employee' ? '/employee' : '/client'); return; }
    const data = await api('/api/state');
    assistantConfig = data.assistant;
    $('#connection-notice').hidden = true;
    if (data.state.revision !== state.revision) {
      state = data.state; receivedAt = Date.now();
      if (account.role === 'employee') await loadRegistry(false);
      // Keep an unfinished form intact; the next submit still checks the server's current state.
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) render(); else renderBanner();
    }
  } catch { $('#connection-notice').hidden = false; }
  finally { refreshing = false; }
}, 4000);
