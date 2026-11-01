// Roles, balances, operations and permissions come exclusively from the server.
import { needsAssistantReview, reviewGreeting, reviewStatus } from './review-assistant.mjs';
import { renderLinkChecks, renderJuryDemo, validReport, demoUrls, normalizeClientUrl } from './site-inspection.mjs';
import { analyzeQr } from './qr-analysis.mjs';
import { decodeQrImage } from './qr-image.mjs';
import { renderQrCheck, renderQrDemo, QR_DEMOS } from './qr-view.mjs';
import { renderComplaints, renderFraudStaff } from './complaints-view.mjs';
import { renderCaseRiskCard } from './case-risk-card.mjs';
import { renderCbrWarningCheck } from './cbr-warning-view.mjs';
import { renderTrustedSettings, renderTrustedInbox, renderTrustedQueue, renderTrustedOperation } from './trusted-view.mjs';
import { renderPurchaseCheck, renderPurchaseCase } from './purchase-view.mjs';
import { renderRecoveryOwner, renderRecoveryStaff } from './recovery-view.mjs';
import { createRequestId } from './request-id.mjs';
async function api(path, body, options = {}) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: options.signal });
  const data = await response.json();
  if (response.status === 401) { location.replace('/login'); throw new Error('Войдите в аккаунт'); }
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос');
  return data;
}
const { user: account } = await api('/api/auth/me');
const landing = account.role === 'employee' ? '/employee' : '/client';
if (location.pathname !== landing) location.replace(landing);
let { state, assistant: assistantConfig, websiteInspector: inspectorConfig } = await api('/api/state');
const staffClients = account.role === 'employee' ? (await api('/api/clients')).clients : [];
let activeClientId = state.clientId;
let clientSelectionEpoch = 0;
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
Object.assign(ui, { urlDraft: '', urlBusy: false, urlError: '', siteReport: null, pageConsent: false, juryReport: null, juryBusy: false, juryError: '', juryScenario: '', juryUrl: '', juryModelResult: null, juryModelBusy: false, juryModelError: '' });
Object.assign(ui, { qrMode: 'file', qrFile: null, qrText: '', qrDecoded: '', qrReport: null, qrExpectedAmount: '', qrExpectedRecipient: '', qrError: '', qrBusy: false, qrJob: 0, qrAbort: null, qrDemo: '', qrDemoReport: null });
Object.assign(ui, { complaintId: null, complaintDraft: '', complaintNote: '', complaintConsent: false, complaintBusy: false, complaintError: '', complaintRequestId: null, complaintConfigured: !!assistantConfig?.configured });
Object.assign(ui, { cbrUrl: '', cbrBusy: false, cbrError: '', cbrReport: null, qrPayment: null, qrDemoPayment: null, qrPaymentBusy: false, qrPaymentError: '', qrPaymentJob: 0, clientSwitchBusy: false, actionBusy: 0 });
Object.assign(ui, { trustedEnabled: !!state.trustedPolicy?.enabled, trustedLimit: String((state.trustedPolicy?.limit || 1000000) / 100), trustedLogins: (state.trustedPolicy?.guardians || []).map(g => g.login).join(', '), trustedMode: state.trustedPolicy?.mode || 'any', trustedBusy: false, trustedError: '' });
ui.trustedDailyLimit = state.trustedPolicy?.dailyLimit == null ? '' : String(state.trustedPolicy.dailyLimit / 100);
Object.assign(ui, { purchaseUrl: '', purchaseRecipient: 'DEMO-CLASS-NORMAL', purchaseAmount: '3000', purchaseExplanation: '', purchaseConsent: false, purchaseBusy: false, purchaseError: '', purchaseCheckId: null, recoveryBusy: false, recoveryError: '' });
if (location.hash === '#purchase' && account.role === 'client') ui.page = 'purchase';
if (ui.role === 'employee') ui.page = 'cases';
if (location.hash === '#jury') ui.page = 'jury-demo';
if (location.hash === '#links') ui.page = 'url-check';
if (location.hash === '#qr') ui.page = 'qr-check';
if (location.hash === '#qr-demo') ui.page = 'qr-demo';
if (location.hash === '#complaints') ui.page = account.role === 'employee' ? 'fraud-reports' : 'complaints';
if (location.hash === '#history' && account.role === 'client') ui.page = 'history';
if (location.hash === '#profile' && account.role === 'client') ui.page = 'profile';
if (location.hash === '#trusted' && account.role === 'client') ui.page = 'trusted';
const registry = () => baseRegistry;
const allRecipients = () => state.recipients;
async function action(name, data = {}) {
  if (ui.clientSwitchBusy) throw new Error('Дождитесь переключения клиента');
  ui.actionBusy++;
  const selector = $('#staff-client'); if (selector) selector.disabled = true;
  try {
    const result = await api('/api/action', { ...data, action: name, ...(account.role === 'employee' ? { clientId: activeClientId } : {}) });
    if (result.recovery?.forceLogin) { location.replace('/login'); return result; }
    state = result.state; receivedAt = Date.now();
    if (ui.role === 'employee' && ['registry-add', 'report-review', 'reset'].includes(name)) await loadRegistry(false);
    render(); return result;
  } finally {
    ui.actionBusy--; if ($('#staff-client')) $('#staff-client').disabled = !!ui.actionBusy || ui.clientSwitchBusy;
  }
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
  banner.hidden = ['url-check', 'jury-demo', 'qr-check', 'qr-demo', 'complaints'].includes(ui.page) && !state.securityLock;
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
  client: [['transfer', 'transfer', 'Переводы'], ['assistant', 'message', 'ИИ-помощник'], ['url-check', 'shield', 'Ссылки'], ['qr-check', 'shield', 'QR-коды'], ['profile', 'user', 'Профиль'], ['trusted', 'check', 'Подтверждения'], ['security', 'lock', 'Безопасность'], ['history', 'history', 'История'], ['complaints', 'message', 'Мои жалобы']],
  employee: [['cases', 'shield', 'Операции'], ['fraud-reports', 'message', 'Жалобы'], ['registry', 'list', 'Реестр'], ['events', 'history', 'Журнал'], ['url-check', 'shield', 'Ссылки'], ['qr-check', 'shield', 'QR-коды']]
};
const titles = {
  transfer: ['Переводы и наличные', 'Управляйте деньгами. Мы позаботимся о проверке.'],
  profile: ['Профиль', 'Лимиты операций и группа доверенных лиц.'],
  trusted: ['Подтверждения близким', 'Запросы, в которых вас выбрали доверенным лицом.'],
  assistant: ['ИИ-помощник по безопасности', 'Разберём ситуацию и заметим признаки известных схем обмана.'],
  'url-check': ['Проверить ссылку', 'Перед оплатой или вводом личных данных.'],
  'jury-demo': ['Демонстрация для жюри', 'Посмотрите, как система объясняет риск клиенту.'],
  'qr-check': ['Проверить QR-код', 'Узнайте, что внутри, до перехода или оплаты.'],
  'qr-demo': ['QR-коды · демо для жюри', 'Вымышленные QR, общий реестр и демонстрационные переводы.'],
  complaints: ['Сообщить о возможном обмане', 'Помощник уточнит обстоятельства, решение примет сотрудник.'],
  'fraud-reports': ['Проверка жалоб', 'Рассмотрите обстоятельства и установите отметку риска получателя.'],
  security: ['Безопасность аккаунта', 'Данные доступа и защита после их изменения.'],
  history: ['История и обращения', 'Все операции, решения системы и ответы банка.'],
  cases: ['Контроль операций', 'Видно каждое решение: основание, получатель и результат.'],
  registry: ['Подозрительные получатели', 'Демонстрационная база для проверки переводов.'],
  events: ['Журнал событий', 'Хронология изменений данных, проверок и обращений.']
};
navItems.client.splice(3, 0, ['purchase', 'shield', 'Покупка']);
titles.purchase = ['Проверка покупки', 'Сайт, получатель и сумма — в одной проверке перед переводом.'];
function render() {
  ui.complaintConfigured = !!assistantConfig?.configured;
  wasActive = protectionOf(state, now()).active;
  if (!['jury-demo', 'qr-demo'].includes(ui.page) && !navItems[account.role].some(([id]) => id === ui.page)) ui.page = account.role === 'employee' ? 'cases' : 'transfer';
  $('#nav-caption').textContent = ui.role === 'client' ? 'МОЙ БАНК' : 'РАБОЧЕЕ МЕСТО';
  $('#eyebrow').textContent = ['jury-demo', 'qr-demo'].includes(ui.page) ? 'ХАКАТОН · ПОКАЗ РЕШЕНИЯ' : ui.role === 'client' ? 'ЛИЧНЫЙ КАБИНЕТ' : 'АНТИФРОД · ДЕМО СОТРУДНИКА';
  $('#profile-name').textContent = account.name;
  if ($('.profile .user-icon')) $('.profile .user-icon').textContent = ui.role === 'employee' ? 'СБ' : account.name.split(' ').map(part => part[0]).slice(0, 2).join('');
  $('#profile-description').textContent = ui.role === 'client' ? 'Демонстрационный клиент' : `Клиент: ${state.client?.name || 'не выбран'}`;
  $('#navigation').innerHTML = navItems[ui.role].map(([id, symbol, title]) => `<button type="button" data-page="${id}" class="${ui.page === id ? 'active' : ''}" ${ui.page === id ? 'aria-current="page"' : ''}>${icon(symbol)}${title}</button>`).join('');
  $('#page-title').textContent = titles[ui.page][0]; $('#page-description').textContent = titles[ui.page][1];
  renderBanner();
  const views = { transfer: transferView, profile: () => `<section class="panel"><h2>${esc(account.name)}</h2><p class="field-help">Логин: ${esc(account.login)} · учебный клиент</p></section>` + renderTrustedSettings(ui, state, { esc, money, date }), trusted: () => renderTrustedInbox(ui, state, { esc, money, date }), assistant: assistantView, 'url-check': urlCheckView, 'jury-demo': juryDemoView, 'qr-check': () => renderQrCheck(ui, { esc }), 'qr-demo': () => renderQrDemo(ui, { esc }), complaints: () => renderComplaints(ui, state, { esc, money, date }), 'fraud-reports': () => renderFraudStaff(ui, state, { esc, money, date }), security: securityView, history: historyView, cases: employeeView, registry: registryView, events: eventsView };
  views.purchase = () => renderPurchaseCheck(ui, state, { esc, money, date }) + '<details class="panel"><summary>Учебные примеры для жюри</summary><p class="field-help">Синтетический HTML, демонстрационный получатель и сумма 3 000 ₽. Внешний сайт не открывается.</p><button type="button" class="button secondary" data-purchase-demo="shop_clone">Подмена магазина</button> <button type="button" class="button secondary" data-purchase-demo="ordinary_shop">Обычная страница</button></details>';
  views.security = () => renderRecoveryOwner(ui, state, { esc, date }) + securityView();
  views.cases = () => renderRecoveryStaff(ui, state, { esc, date }) + employeeView();
  views.transfer = () => (ui.purchaseCheckId ? '<p class="notice">К переводу привязана проверка покупки. Изменение суммы или получателя потребует новой проверки. <button type="button" class="link-button" data-purchase-detach>Отвязать проверку</button></p>' : '') + transferView();
  $('#workspace').innerHTML = views[ui.page]();
  if (ui.role === 'employee') $('#workspace').insertAdjacentHTML('afterbegin', `<section class="panel staff-client-picker"><label class="field-label" for="staff-client">Клиент для просмотра и рассмотрения операций</label><select id="staff-client" ${ui.actionBusy || ui.clientSwitchBusy ? 'disabled' : ''}>${staffClients.map(client => `<option value="${esc(client.id)}" ${client.id === activeClientId ? 'selected' : ''}>${esc(client.name)}</option>`).join('')}</select><p class="field-help">Баланс, история и жалобы раздельные. Реестр получателей общий для обоих клиентов.</p></section>`);
  if ($('.bank-profile b')) $('.bank-profile b').textContent = `${state.client?.name || 'Клиент'} · счёт •• ${activeClientId === 'client-demo-2' ? '4824' : '4812'}`;
  if ($('.bank-profile .user-icon')) $('.bank-profile .user-icon').textContent = (state.client?.name || '').split(' ').map(part => part[0]).slice(0, 2).join('');
  if (ui.role === 'client') {
    document.querySelectorAll('[data-operation]').forEach(button => {
      const op = state.operations.find(o => o.id === button.dataset.operation);
      if (op?.kind === 'transfer' && op.status === 'completed') {
        const existing = state.fraudReports?.some(r => r.operationId === op.id);
        button.insertAdjacentHTML('afterend', `<button type="button" class="link-button report-operation-button" data-report-operation="${esc(op.id)}" ${ui.complaintBusy ? 'disabled' : ''}>${existing ? 'Открыть жалобу' : 'Сообщить об обмане'}</button>`);
      }
    });
  }
  if (ui.role === 'employee' && ui.page === 'cases') $('#workspace').insertAdjacentHTML('afterbegin', classifierControls() + staffReviewQueue() + staffAssistantReports());
  if (ui.role === 'employee') document.querySelectorAll('[data-review-form]').forEach(form => {
    const op = state.operations.find(item => item.id === form.dataset.reviewForm);
    if (op?.purchaseCheckId) form.insertAdjacentHTML('beforebegin', renderPurchaseCase(op, state, { esc, money, date }));
  });
  if (ui.role === 'client' && ['transfer', 'history'].includes(ui.page)) $('#workspace').insertAdjacentHTML('afterbegin', renderTrustedQueue(ui, state, { esc, money, date }));
  if (ui.role === 'client') {
    const count = (state.trustedInbox || []).filter(r => r.status === 'pending' && !r.myVerdict).length;
    if (count && $('[data-page="trusted"]')) $('[data-page="trusted"]').append(` · ${count}`);
  }
  if (ui.role === 'client') {
    const pending = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW');
    document.querySelectorAll('.client-review-card').forEach((card, i) => { if (pending[i]) card.insertAdjacentHTML('beforeend', `<button class="button review-ai-action ai-open" type="button" data-ai-operation="${esc(pending[i].id)}">${icon('message')}<span><b>Проверить ситуацию с ИИ</b><small>Помощник задаст несколько уточняющих вопросов</small></span>${icon('arrow')}</button>`); });
  }
  if (state.securityLock && $('.balance-bottom span')) $('.balance-bottom span').textContent = 'Демо-баланс · списания заблокированы';
  if (ui.page === 'security' && !state.securityLock) $('#workspace').insertAdjacentHTML('afterbegin', '<p class="notice">Предупреждение «Это был не я» отображается только в старых сессиях — открытых до нового входа или изменения данных. В сессии, совершившей действие, кнопки нет.</p>');
  updateRecipientInfo();
  if (ui.role === 'employee' && ui.page === 'cases') $('#workspace').insertAdjacentHTML('afterbegin', '<p class="notice">Три получателя «Тест · …» имеют фиксированные классы независимо от режима ниже. Для остальных получателей работает выбранный режим заглушки.</p>');
  if (ui.role === 'employee' && $('#staff-client')) $('#workspace').prepend($('#staff-client').closest('.staff-client-picker'));
  if (ui.aiModalOperationId && $('#dialog').open) renderAssistantDialog();
  if (ui.role === 'client') document.querySelectorAll('[data-resume-reviewed]').forEach(button => {
    const op = state.operations.find(item => item.id === button.dataset.resumeReviewed);
    if (op?.guardianApproval && op.trustedStatus !== 'approved') { button.disabled = true; button.textContent = 'Ожидается разрешение доверенных лиц'; }
  });
}
function balanceCard() { return `<div class="panel balance-card"><div class="balance-top"><span>Мастер-счёт · RUB</span><span class="mini-shield">${icon('shield')} Защищён</span></div><strong id="balance">${money(state.balance)}</strong><div class="balance-bottom"><span>Доступный демо-баланс</span><b>•• 4812</b></div></div>`; }
function urlCheckView() { return renderLinkChecks(ui, { esc, icon, date, inspectorAvailable: !!inspectorConfig?.configured }) + `<div class="link-client investment-check-layout">${renderCbrWarningCheck(ui, { esc })}</div>`; }
function juryDemoView() { return renderJuryDemo(ui, { esc, icon, date, inspectorAvailable: !!inspectorConfig?.configured }); }
function navigate(page) {
  ui.page = page;
  const hashes = { profile: '#profile', trusted: '#trusted', 'jury-demo': '#jury', 'url-check': '#links', 'qr-check': '#qr', 'qr-demo': '#qr-demo', complaints: '#complaints', 'fraud-reports': '#complaints', history: '#history' };
  history.replaceState(null, '', landing + (hashes[page] || ''));
  if (page === 'purchase') history.replaceState(null, '', landing + '#purchase');
  render();
  window.scrollTo(0, 0);
}
async function runPurchaseCheck(demoScenario) {
  if (ui.purchaseBusy) return;
  const amount = demoScenario ? 300000 : parseAmount(ui.purchaseAmount);
  if (!amount || (!demoScenario && !ui.purchaseConsent)) { toast('Укажите сумму и согласие на проверку страницы.'); return; }
  ui.purchaseBusy = true; ui.purchaseError = ''; render();
  try {
    const result = await api('/api/purchase/check', {
      url: ui.purchaseUrl, recipientId: demoScenario ? 'DEMO-CLASS-NORMAL' : ui.purchaseRecipient, amount,
      explanation: demoScenario ? 'Учебная покупка в интернет-магазине: продавец прислал ссылку на оплату.' : ui.purchaseExplanation,
      consent: true, ...(demoScenario ? { demoScenario } : {}),
    }, { signal: AbortSignal.timeout(45000) });
    state = result.state; receivedAt = Date.now(); toast('Проверка сохранена. Деньги не отправлены.');
  } catch (error) { ui.purchaseError = error.message; }
  finally { ui.purchaseBusy = false; render(); if (!ui.purchaseError) $('.purchase-results')?.scrollIntoView({ block: 'start' }); }
}
function clearQrResult() {
  ui.qrAbort?.abort(); ui.qrAbort = null; ui.qrJob++; ui.qrBusy = false;
  ui.qrReport = null; ui.qrDecoded = ''; ui.qrError = '';
  ui.qrPayment = null; ui.qrPaymentError = ''; ui.qrPaymentBusy = false; ui.qrPaymentJob++;
  $('.qr-result')?.remove(); $('#qr-error')?.remove();
}
async function checkCbrList() {
  if (ui.cbrBusy) return;
  const value = ui.cbrUrl.trim();
  ui.cbrReport = null; ui.cbrError = ''; ui.cbrBusy = true; render();
  try {
    const { report } = await api('/api/cbr-warning', { url: value }, { signal: AbortSignal.timeout(20000) });
    if (!report || !['matched', 'not_listed', 'unavailable'].includes(report.status)) throw new Error('Некорректный ответ проверки списка ЦБ');
    if (ui.cbrUrl.trim() === value) ui.cbrReport = report;
  } catch (error) { ui.cbrError = ['AbortError', 'TimeoutError'].includes(error.name) ? 'Проверка списка ЦБ не завершилась вовремя. Это не означает безопасность сайта.' : error.message; }
  finally { ui.cbrBusy = false; render(); }
}
const currentQrPayload = mode => mode === 'demo' ? QR_DEMOS[ui.qrDemo]?.text : ui.qrDecoded;
async function resolvePaymentQr(mode) {
  if (ui.qrPaymentBusy || account.role !== 'client') return;
  const payload = currentQrPayload(mode);
  if (!payload) return;
  const job = ++ui.qrPaymentJob;
  ui.qrPaymentBusy = true; ui.qrPaymentError = ''; ui[mode === 'demo' ? 'qrDemoPayment' : 'qrPayment'] = null; render();
  try {
    const { payment } = await api('/api/qr/resolve', { payload });
    if (job === ui.qrPaymentJob && payload === currentQrPayload(mode)) ui[mode === 'demo' ? 'qrDemoPayment' : 'qrPayment'] = payment;
  } catch (error) { if (job === ui.qrPaymentJob) ui.qrPaymentError = error.message; }
  finally { if (job === ui.qrPaymentJob) { ui.qrPaymentBusy = false; render(); } }
}
async function attemptQrPayment(mode) {
  if (ui.qrPaymentBusy || account.role !== 'client') return;
  const payment = ui[mode === 'demo' ? 'qrDemoPayment' : 'qrPayment'];
  const payload = currentQrPayload(mode);
  if (!payload || !payment?.supported || !['clear', 'watch'].includes(payment.registryStatus)) return;
  const request = { kind: 'transfer', recipientId: payment.recipient.id, recipientName: payment.recipient.name, amount: payment.amountKopecks,
    qrPayload: payload, qrFixtureId: payment.fixtureId, requestId: createRequestId() };
  ui.qrPaymentBusy = true; render();
  try { await prepareOperation(request); }
  finally { ui.qrPaymentBusy = false; render(); }
}
async function switchStaffClient(id) {
  if (account.role !== 'employee' || ui.actionBusy || ui.clientSwitchBusy || ui.complaintBusy || !staffClients.some(client => client.id === id)) return;
  const epoch = ++clientSelectionEpoch;
  ui.clientSwitchBusy = true; closeDialog(); render();
  try {
    const data = await api(`/api/state?clientId=${encodeURIComponent(id)}`);
    if (epoch !== clientSelectionEpoch) return;
    activeClientId = id; state = data.state; assistantConfig = data.assistant; inspectorConfig = data.websiteInspector; receivedAt = Date.now();
    ui.answers = {}; ui.filter = 'all'; ui.complaintId = null; ui.complaintError = ''; ui.aiConversationId = null;
    pendingRequest = null; await loadRegistry(false);
  } catch (error) { toast(error.message); }
  finally { if (epoch === clientSelectionEpoch) { ui.clientSwitchBusy = false; render(); } }
}
async function checkQr() {
  if (ui.qrBusy) return;
  clearQrResult();
  const job = ui.qrJob, file = ui.qrMode === 'file' ? ui.qrFile : null, text = ui.qrMode === 'text' ? ui.qrText : '';
  const expected = { expectedAmount: ui.qrExpectedAmount, expectedRecipient: ui.qrExpectedRecipient };
  const controller = new AbortController(); ui.qrAbort = controller; ui.qrBusy = true; render();
  try {
    if (!file && !text.trim()) throw new Error('Выберите изображение или вставьте текст из QR.');
    const decoded = file ? await decodeQrImage(file, { signal: controller.signal }) : text;
    if (ui.qrJob !== job) return;
    ui.qrDecoded = decoded; ui.qrReport = analyzeQr(decoded, expected);
  } catch (error) { if (ui.qrJob === job) ui.qrError = error.message || 'Не удалось распознать QR. Попробуйте другое изображение.'; }
  finally { if (ui.qrJob === job) { ui.qrBusy = false; ui.qrAbort = null; if (ui.page === 'qr-check') render(); } }
}
async function inspectPage() {
  if (ui.urlBusy) return;
  ui.siteReport = null; ui.urlError = '';
  try { ui.urlDraft = normalizeClientUrl(ui.urlDraft); }
  catch (error) { ui.urlError = error.message; render(); return; }
  // The explicit submit follows the visible consent notice next to this one action.
  ui.pageConsent = true; ui.urlBusy = true; render();
  try {
    const payload = { url: ui.urlDraft, consent: true };
    const { report } = await api('/api/phishing/inspect', payload, { signal: AbortSignal.timeout(35000) });
    if (!validReport(report) || report.source !== 'live') throw new Error('Не удалось получить результат проверки. Попробуйте позже.');
    ui.siteReport = report;
  } catch (error) { ui.urlError = ['TimeoutError', 'AbortError'].includes(error.name) ? 'Сайт не ответил вовремя. Попробуйте позже.' : error.message; }
  finally { ui.urlBusy = false; render(); }
}
async function runJuryScenario(scenario) {
  if (ui.juryBusy || !demoUrls[scenario]) return;
  ui.juryScenario = scenario; ui.juryReport = null; ui.juryError = ''; ui.juryBusy = true;
  ui.juryUrl = demoUrls[scenario]; ui.juryModelResult = null; ui.juryModelError = ''; render();
  try {
    const { report } = await api('/api/phishing/inspect', { demoScenario: scenario }, { signal: AbortSignal.timeout(20000) });
    if (!validReport(report) || report.source !== 'demo_fixture') throw new Error('Не удалось получить учебный пример.');
    ui.juryReport = report;
  } catch (error) { ui.juryError = ['TimeoutError', 'AbortError'].includes(error.name) ? 'Пример не успел обработаться. Повторите запуск.' : error.message; }
  finally { ui.juryBusy = false; render(); }
}
async function runJuryUrlModel() {
  if (ui.juryModelBusy) return;
  ui.juryModelResult = null; ui.juryModelError = '';
  let url;
  try { url = normalizeClientUrl(ui.juryUrl); } catch (error) { ui.juryModelError = error.message; render(); return; }
  ui.juryUrl = url; ui.juryModelBusy = true; render();
  try {
    const { result } = await api('/api/phishing/check', { url }, { signal: AbortSignal.timeout(15000) });
    if (!result || !['safe', 'phishing'].includes(result.label) || !Number.isFinite(result.phishing_score) || result.phishing_score < 0 || result.phishing_score > 1 || typeof result.model_version !== 'string') throw new Error('Некорректный ответ URL-модели.');
    if (ui.juryUrl === url) ui.juryModelResult = result;
  } catch (error) { if (ui.juryUrl === url) ui.juryModelError = ['TimeoutError', 'AbortError'].includes(error.name) ? 'Модель не ответила вовремя.' : error.message; }
  finally { ui.juryModelBusy = false; render(); }
}
function policyView() {
  const active = protectionOf(state, now()).active;
  return `<div class="aside-grid"><div class="panel"><div class="policy-title"><h2>Что доступно сейчас</h2>${icon('shield')}</div>${[
    ['user', 'Прежние получатели', 'После проверки по реестру', true], ['transfer', 'Новые получатели', active ? 'Пауза на 24 часа' : 'После проверки по реестру', !active], ['cash', 'Снятие наличных', active ? 'До окончания паузы' : 'После подтверждения', !active], ['history', 'Баланс и история', 'Без ограничений', true]
  ].map(([symbol, title, text, allowed]) => { const locked = state.securityLock && symbol !== 'history'; return `<div class="policy-item"><span class="policy-icon">${icon(symbol)}</span><div><b>${title}</b><p>${locked ? 'Сообщение «Это был не я»' : text}</p></div><span class="availability ${locked || !allowed ? 'closed' : ''}">${locked ? 'Блокировка' : allowed ? 'Доступно' : 'Пауза'}</span></div>`; }).join('')}<p class="aside-note">Старый получатель — тот, кому вы успешно переводили до изменения данных. Совпадение в реестре останавливает любой перевод.</p></div><div class="panel support-card"><h3>${icon('message')} Банк рядом</h3><p>Откройте остановленную операцию и создайте обращение. Ответ сотрудника появится в истории.</p><button class="link-button" data-page="history">История и обращения →</button></div></div>`;
}
function transferView() {
  const options = allRecipients().map(r => `<option value="${esc(r.id)}" ${ui.recipient === r.id ? 'selected' : ''}>${esc(r.name)} · ${isKnown(state, r.id, now()) ? 'прежний' : 'новый'}</option>`).join('');
  return `<div class="grid-main"><div>${balanceCard()}<section class="panel"><h2>Новая операция</h2><div class="segment" role="group" aria-label="Тип операции"><button data-kind="transfer" type="button" class="${ui.kind === 'transfer' ? 'active' : ''}">${icon('transfer')} Перевод</button><button data-kind="cash" type="button" class="${ui.kind === 'cash' ? 'active' : ''}">${icon('cash')} Наличные</button></div><form id="operation-form" novalidate>${ui.kind === 'transfer' ? `<label class="field-label" for="recipient">Кому переводим</label><select id="recipient" name="recipient">${options}<option value="custom" ${ui.recipient === 'custom' ? 'selected' : ''}>Другой получатель по демо-ID</option></select><div id="custom-recipient" ${ui.recipient === 'custom' ? '' : 'hidden'}><label class="field-label" for="custom-id">Демонстрационный ID</label><input id="custom-id" maxlength="50" placeholder="DEMO-NEW-002" value="${esc(ui.customId)}"><label class="field-label" for="custom-name">Имя для истории</label><input id="custom-name" maxlength="80" placeholder="Новый получатель" value="${esc(ui.customName)}"></div><div class="recipient-meta" id="recipient-info"></div>` : `<div class="notice">${icon('cash')} Демонстрация снятия наличных. Банкомат и карта не подключены.</div>`}<label class="field-label" for="amount">Сумма, ₽</label><input class="amount-input" id="amount" inputmode="decimal" autocomplete="off" value="${esc(ui.amount)}" aria-describedby="amount-help"><p class="field-help" id="amount-help">${ui.kind === 'transfer' ? 'Комиссия в демо — 0 ₽' : 'Деньги списываются только после подтверждения'}</p><p id="form-error" class="dialog-error" role="alert"></p><button class="button full" type="submit">Проверить ${ui.kind === 'transfer' ? 'перевод' : 'снятие'} ${icon('arrow')}</button><p class="secure-caption">${icon('lock')} Сначала проверка, затем подтверждение</p></form></section></div><aside class="transfer-aside">${reviewQueueShortcut()}${policyView()}</aside></div>${operationsTable(state.operations.slice(0, 5), false, 'Последние операции')}`;
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
  if (op?.purchaseCheckId) $('#dialog .review-chat').insertAdjacentHTML('beforebegin', `<details class="purchase-evidence"><summary>Результат проверки покупки</summary>${renderPurchaseCase(op, state, { esc, money, date })}</details>`);
}
function assistantView() {
  const c = state.aiConversations?.find(c => c.id === ui.aiConversationId);
  const pending = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW');
  const finished = c?.status === 'complete', processing = ui.aiBusy || c?.status === 'processing';
  return `<div class="assistant-layout"><section class="panel ai-chat-panel"><div class="ai-chat-kicker">${icon('shield')} Безопасный диалог с ИИ-помощником</div><div class="section-head ai-chat-head"><h2>Проверим обстоятельства перевода</h2><span class="pill blue">Qwen · Groq</span></div><p class="panel-subtitle">Помощник уточняет ситуацию за 1–4 ответа. Для хакатона используйте только вымышленные данные.</p><div class="notice warning">Это внешний ИИ-сервис, он может ошибаться. Не вводите ФИО, телефоны, номера карт, пароли и SMS-коды. Автоматическое скрытие данных не гарантирует полную анонимность.</div>${!assistantConfig?.configured ? '<div class="notice error">Серверный ключ модели не настроен. Обратитесь к сотруднику.</div>' : ''}${c ? `<p class="field-help">${c.operationId ? `Проверка перевода ${esc(c.operationId)}. Опасная рекомендация остановит только этот ожидающий перевод.` : 'Общая проверка ситуации: она не привязана к переводу и не блокирует операции.'}</p>${aiTurnsView(c)}` : `<label class="field-label" for="ai-operation">Какую ситуацию проверяем</label><select id="ai-operation"><option value="">Общая проверка ситуации</option>${pending.map(op => `<option value="${esc(op.id)}" ${ui.aiOperationId === op.id ? 'selected' : ''}>${esc(op.id)} · ${esc(op.recipientName)} · ${money(op.amount)}</option>`).join('')}</select><div class="ai-message bot"><b>ИИ-помощник</b><p>Кому и зачем вы переводите деньги? Кто предложил перевод и знакомы ли вам эти реквизиты?</p></div>`}${finished ? '<p class="notice">Оценка завершена. Результат доступен сотруднику банка; он не заменяет проверку личности и не снимает ограничения.</p>' : `<form id="ai-chat-form"><label class="field-label" for="ai-message">Ваш ответ</label><textarea id="ai-message" maxlength="1200" required placeholder="Опишите вымышленную ситуацию своими словами" ${processing ? 'disabled' : ''}>${esc(ui.aiDraft)}</textarea><label class="ai-consent"><input type="checkbox" id="ai-consent" ${ui.aiConsent ? 'checked' : ''} required ${processing ? 'disabled' : ''}><span>Согласен отправить текст объяснения в Groq для анализа и сохранить диалог для сотрудника банка. Реальные персональные и банковские данные не ввожу.</span></label><button type="submit" class="button" ${processing || !assistantConfig?.configured ? 'disabled' : ''}>${processing ? 'Ждём ответ модели…' : 'Отправить ИИ'}</button></form>`}<button type="button" class="link-button ai-open" id="ai-new" ${ui.aiBusy ? 'disabled' : ''}>Начать новый диалог</button></section><aside class="panel ai-about"><h2>Что проверяем</h2><p>«Безопасный счёт», требования от имени МВД, фишинг, удалённый доступ, подмену близкого, лжеинвестиции, навязанный кредит и передачу наличных.</p><h3>Как действует защита</h3><p>ИИ не отправляет деньги. Благоприятный ответ не отменяет паузу, реестр или решение классификатора переводов.</p><h3>Недавние диалоги</h3>${(state.aiConversations || []).slice(0, 8).map(x => `<button class="link-button ai-history" type="button" data-ai-conversation="${esc(x.id)}">${esc(date(x.createdAt))} · ${esc(x.operationId || 'Общая проверка')}</button>`).join('') || '<p>Диалогов пока нет.</p>'}</aside></div>`;
}
function staffAssistantReports() {
  const conversations = (state.aiConversations || []).filter(c => c.assessment || c.status === 'error');
  return `<section class="panel model-panel"><div class="section-head"><h2>Предварительные проверки ИИ</h2><small>Последние ${Math.min(conversations.length, 5)}</small></div><p class="panel-subtitle">Рекомендация не является проверкой личности или разрешением платежа. Сверяйте её с ответами клиента и независимыми сигналами.</p>${conversations.slice(0, 5).map(c => `<details class="ai-report"><summary>${esc(c.operationId || 'Общая проверка')} · ${esc(date(c.createdAt))} · ${esc(c.assessment ? classNames[c.assessment.class] : 'Ошибка сервиса')}</summary>${c.operationId ? '' : '<p class="field-help">Без привязки к переводу; операций не блокирует.</p>'}${aiTurnsView(c)}</details>`).join('') || '<p class="empty">Клиент ещё не обращался к ИИ-помощнику.</p>'}</section>`;
}
function requestFromForm() {
  const r = allRecipients().find(r => r.id === ui.recipient);
  return { kind: ui.kind, amount: parseAmount(ui.amount), recipientId: ui.kind === 'cash' ? undefined : ui.recipient === 'custom' ? ui.customId.trim().toUpperCase() : ui.recipient, recipientName: ui.kind === 'cash' ? 'Наличные' : r?.name ?? (ui.customName.trim() || ui.customId.trim().toUpperCase()), ...(ui.purchaseCheckId && ui.kind === 'transfer' ? { purchaseCheckId: ui.purchaseCheckId } : {}) };
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
  const source = value?.source === 'mock' ? 'Демо-заглушка' : value?.source === 'policy' ? (value.model_version === 'purchase-check-v1' ? 'Связанная проверка покупки' : 'Правило реестра жалоб') : 'ML-модель';
  return `<span class="model-result pill ${value?.class === 'normal' ? 'green' : value?.class === 'block' ? 'red' : 'amber'}">${value ? `Класс: ${esc(classNames[value.class] || 'Неизвестен')}` : 'Классификатор: нет ответа'}</span>${value ? `<small class="model-source">${source} · ${esc(value.model_version)}</small>` : ''}`;
}
function classifierControls() {
  return `<section class="panel model-panel"><div class="section-head"><h2>Классификатор переводов</h2><span class="pill blue">Демо-заглушка · не ML</span></div><p class="panel-subtitle">Выберите ответ для новых проверок переводов. Клиент не управляет этим режимом. Пауза, реестр и блокировка аккаунта имеют приоритет.</p><form id="model-mode-form" class="model-controls"><div><label class="field-label" for="model-mode">Ответ заглушки</label><select id="model-mode">${[...Object.entries(classNames), ['unavailable', 'Сервис недоступен · проверка ошибки']].map(([value, label]) => `<option value="${value}" ${state.modelMock.mode === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div><button type="submit" class="button secondary">Применить режим</button></form><p class="field-help">Сейчас: ${esc(classNames[state.modelMock.mode] || 'Нет ответа сервиса')}. Изменение режима не отправляет и не разблокирует ранее остановленные переводы.</p></section>`;
}
function staffReviewQueue() {
  const pending = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW');
  return `<section class="panel review-queue employee-review-queue"><div class="section-head"><h2>Проверка спорных переводов</h2><small>${pending.length} в очереди</small></div><p class="panel-subtitle">Разрешение сотрудника не списывает деньги. Клиент подтверждает исходную сумму и получателя отдельно; все ограничения проверяются заново.</p>${pending.length ? pending.map(op => `<article class="review-card employee-review-card"><div class="employee-review-top"><div><small>Операция ${esc(op.id)}</small><strong>${esc(op.recipientName)}</strong></div><strong class="employee-review-amount">${money(op.amount)}</strong></div><div class="employee-review-meta">${classificationPill(op.classification)}<span>${icon('clock')} ${esc(date(op.createdAt))} МСК</span></div>${op.review?.status === 'approved' ? `<p class="notice">Разрешено подтверждение клиента в течение 15 минут. Деньги пока не списаны.</p><p>${esc(op.review.comment)}</p>` : `<form data-review-form="${esc(op.id)}"><label class="field-label" for="review-comment-${esc(op.id)}">Комментарий по результату проверки</label><textarea id="review-comment-${esc(op.id)}" name="comment" minlength="5" maxlength="1000" required placeholder="Проверьте обстоятельства и свяжитесь с клиентом по проверенному каналу">${esc(ui.answers['review-' + op.id] || '')}</textarea><div class="review-actions"><button type="submit" class="button review-approve" data-verdict="approve">${icon('check')}<span><b>Разрешить клиенту</b><small>Деньги пока не спишутся</small></span></button><button type="submit" class="button review-reject" data-verdict="reject">${icon('lock')}<span><b>Отклонить перевод</b><small>Операция будет остановлена</small></span></button></div></form>`}</article>`).join('') : '<p class="empty">Переводов класса «Нужно проверить» пока нет.</p>'}</section>`;
}
function reviewQueueShortcut() {
  const count = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW').length;
  return `<button type="button" class="review-queue-shortcut" data-page="security"><span class="shortcut-icon">${icon('clock')}</span><span><b>Переводы на дополнительной проверке</b><small>${count ? 'Откройте список и продолжите проверку' : 'Новых переводов на проверке нет'}</small></span><span class="review-count">${count}</span>${icon('arrow')}</button>`;
}
function clientReviewQueue(showEmpty = false) {
  const pending = state.operations.filter(op => op.status === 'pending' && op.code === 'MODEL_REVIEW');
  if (!pending.length && !showEmpty) return '';
  return `<section class="panel review-queue client-review-queue security-review-queue"><div class="review-queue-heading"><span class="review-queue-icon">${icon('clock')}</span><div><h2>Переводы на дополнительной проверке</h2><p>Деньги остаются на счёте до решения сотрудника банка</p></div><span class="review-count">${pending.length}</span></div><div class="review-list">${pending.length ? pending.map(op => `<article class="review-card client-review-card"><div class="review-card-top"><div class="review-recipient"><span class="review-avatar">${icon('user')}</span><div><small>Получатель</small><strong>${esc(op.recipientName)}</strong></div></div><strong class="review-amount">${money(op.amount)}</strong></div><div class="review-classification">${classificationPill(op.classification)}</div><div class="review-explanation"><span>${icon('shield')}</span><p><b>Почему перевод приостановлен</b><small>${esc(op.reason)}</small></p></div>${op.review?.comment ? `<p class="reply">${esc(op.review.comment)}</p>` : ''}<div class="review-state-row">${op.review?.status === 'approved' ? `<span class="review-state approved">Проверка завершена</span><button type="button" class="button" data-resume-reviewed="${esc(op.id)}">Продолжить перевод ${icon('arrow')}</button>` : `<span class="review-state waiting">${icon('clock')} Ожидает решения сотрудника</span>`}</div></article>`).join('') : '<p class="empty review-empty">Сейчас переводов на дополнительной проверке нет.</p>'}</div></section>`;
}
function operationsTable(ops, employee = false, title = 'Операции') {
  return `<section class="panel history"><div class="section-head"><h2>${esc(title)}</h2><small>${ops.length} записей</small></div><div class="table-wrap"><table class="${employee ? 'employee-table' : 'client-table'}"><thead><tr><th>Получатель / операция</th><th class="money">Сумма</th>${employee ? '<th>Основание</th>' : ''}<th>Статус</th><th></th></tr></thead><tbody>${ops.length ? ops.map(op => `<tr><td><div class="recipient-cell"><span class="recipient-avatar">${icon(op.kind === 'cash' ? 'cash' : 'user')}</span><div>${esc(op.recipientName)}<small>${esc(date(op.createdAt))}${op.seeded ? ' · демо-история' : ''}</small></div></div></td><td class="money">${money(op.amount)}</td>${employee ? `<td class="reason-column">${esc(op.reason)}<small>${esc(op.code)} · ${op.kind === 'cash' ? 'Наличные' : op.knownAtDecision ? 'Прежний получатель' : 'Новый получатель'}</small></td>` : ''}<td>${statusPill(op)}</td><td><button type="button" class="link-button" data-operation="${esc(op.id)}" aria-label="Подробнее об операции ${esc(op.id)}">Подробнее</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Новых операций пока нет. Создайте перевод в кабинете клиента.</td></tr>'}</tbody></table></div></section>`;
}
function securityView() {
  if (state.securityLock) return `<section class="panel"><h2>Доступ защищён после вашего сообщения</h2><p>Прямое изменение данных доступа недоступно. Для восстановления используйте отдельную процедуру с проверкой сотрудника. Все переводы и наличные пока заблокированы.</p><button type="button" class="button secondary" data-page="history">Открыть обращение</button><p>Предупреждение «Это был не я» отображается только в старых сессиях, открытых до события, и не показывается в сессии, совершившей действие.</p>${eventList(state.events.slice(0, 6))}</section>`;
  return `<div class="security-layout"><section class="panel"><h2>Данные доступа</h2><p class="panel-subtitle">Изменение запускает защитную паузу на 24 часа.</p><div class="setting-row"><span class="policy-icon">${icon('phone')}</span><div><b>Номер телефона</b><p id="current-phone">${esc(state.phone)}</p></div><button type="button" class="button secondary small" data-change-phone>Изменить</button></div><div class="setting-row"><span class="policy-icon">${icon('lock')}</span><div><b>Восстановление доступа</b><p>Смена способа подтверждения</p></div><button type="button" class="button secondary small" id="restore-access">Восстановить</button></div><div class="security-illustration">${icon('shield')}<p>После изменения данных прежние получатели остаются доступны. Новые переводы и наличные — через 24 часа.</p></div><p class="aside-note">При повторном изменении 24 часа отсчитываются заново. Истечение времени не отправляет ранее остановленные операции.</p></section>${clientReviewQueue(true)}</div><section class="panel security-events"><div class="section-head"><h2>Последние события</h2><small>Безопасность аккаунта</small></div>${eventList(state.events.filter(e => ['phone', 'recovery', 'time'].includes(e.type)).slice(0, 6))}</section>`;
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
  return `<div class="stack"><section class="panel"><div class="section-head"><h2>Демонстрационный реестр</h2><span class="registry-count">${entries?.length ?? 0} записей</span></div><p class="panel-subtitle">Стоп-лист останавливает перевод, отметка по рассмотренным жалобам направляет его на дополнительную проверку. Это относится и к прежним получателям.</p><button type="button" class="link-button" data-page="fraud-reports">Открыть жалобы и решения →</button>${entries === null ? '<div class="notice error">Не удалось завершить загрузку реестра. Переводы остаются на проверке. <button class="link-button" id="retry-registry">Повторить загрузку</button></div>' : `<div class="table-wrap"><table class="registry-table"><thead><tr><th>Получатель</th><th>Основание отметки</th><th>Действие</th></tr></thead><tbody>${entries.map(e => `<tr><td>${esc(e.display_name)}<small class="registry-code">${esc(e.recipient_id)}</small></td><td class="reason-column">${esc(e.reason)}</td><td><span class="pill ${e.status === 'watch' ? 'amber' : 'red'}">${e.status === 'watch' ? 'Дополнительная проверка' : 'Стоп-лист демо'}</span></td></tr>`).join('')}</tbody></table></div>`}<p class="aside-note">Источник: вымышленные сценарии хакатона. Реестр не подключён к базе Банка России. Отметки по жалобам пересматриваются в разделе «Жалобы».</p></section><section class="panel"><h2>Добавить получателя в стоп-лист</h2><p class="panel-subtitle">Новая запись сразу участвует в проверках обеих вкладок.</p><form id="registry-form"><div class="inline-fields"><div><label class="field-label" for="registry-id">Демонстрационный ID</label><input id="registry-id" required pattern="DEMO-[A-Za-z0-9_-]{1,40}" maxlength="45" placeholder="DEMO-NEW-001"></div><div><label class="field-label" for="registry-name">Имя получателя</label><input id="registry-name" required maxlength="80" placeholder="Новый получатель"></div><div class="span-full"><label class="field-label" for="registry-reason">Причина включения</label><input id="registry-reason" required maxlength="300" placeholder="Основание ограничения в демонстрационном сценарии"></div></div><p class="dialog-error" id="registry-error" role="alert"></p><button type="submit" class="button" ${entries === null ? 'disabled' : ''}>Добавить в демо-реестр</button></form></section></div>`;
}
function eventList(events) { return events.length ? `<ol class="timeline">${events.map(e => `<li><div><p>${esc(e.text)}</p><small>${date(e.at)} МСК · ${esc(e.actor)}</small></div></li>`).join('')}</ol>` : '<p class="empty">Изменений данных пока нет.</p>'; }
function eventsView() { return `<section class="panel"><h2>Действия клиента и сотрудника</h2><p class="panel-subtitle">Общий журнал для обеих ролей. Новые события сверху.</p>${eventList(state.events)}</section>`; }
function phoneDialog() {
  showDialog('Сменить номер телефона', `<p>Переводы новым получателям и снятие наличных будут недоступны 24 часа. Прежние получатели останутся доступны после проверки.</p><form id="phone-form"><label class="field-label" for="new-phone">Новый демонстрационный номер</label><input id="new-phone" required inputmode="tel" maxlength="25" value="${state.phone === '+7 000 000-00-02' ? '+7 000 000-00-03' : '+7 000 000-00-02'}"><p class="field-help">Используйте вымышленные данные. Никаких SMS не отправляется.</p><p id="phone-error" class="dialog-error" role="alert"></p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button class="button" type="submit">Сохранить номер</button></div></form>`, 'phone');
}
function decisionDialog(decision, request, operation, readOnly = false) {
  if (account.role === 'client' && needsAssistantReview(operation) && !['TRUSTED_REQUIRED'].includes(decision.code)) { openAssistantDialog(operation); return; }
  const completed = operation?.status === 'completed';
  const title = completed ? (request.kind === 'cash' ? 'Наличные выданы в демо' : 'Перевод выполнен') : decision.code === 'RISK_REGISTRY' ? 'Получатель в демо-реестре' : decision.code === 'REGISTRY_UNAVAILABLE' ? 'Проверка не завершена' : 'Операция остановлена';
  showDialog(title, `<p>${esc(completed ? operation.reason : decision.reason)}</p><div class="dialog-facts"><div><span>${request.kind === 'cash' ? 'Операция' : 'Получатель'}</span><b>${esc(request.recipientName)}</b></div><div><span>Сумма</span><b>${money(request.amount)}</b></div>${!completed && decision.endsAt && ['CASH_HOLD', 'NEW_RECIPIENT_HOLD'].includes(decision.code) ? `<div><span>Пауза до</span><b>${date(decision.endsAt)} МСК</b></div>` : ''}${decision.registryReason ? `<div><span>Основание</span><b>${esc(decision.registryReason)}</b></div>` : ''}</div><p>${completed ? `Остаток: ${money(state.balance)}.` : 'Деньги не списаны. Операция не будет выполнена автоматически.'}</p><div class="dialog-actions">${operation && !completed && ui.role === 'client' ? `<button type="button" class="button secondary" data-support="${esc(operation.id)}">Обратиться в банк</button>` : ''}<button type="button" class="button" data-close>${completed ? 'Готово' : readOnly ? 'Закрыть' : 'Понятно'}</button></div>`, completed ? 'check' : 'lock', completed ? 'green' : decision.code === 'RISK_REGISTRY' ? 'red' : 'amber');
  if (request.kind === 'transfer') $('#dialog-title').insertAdjacentHTML('afterend', classificationPill(decision.classification ?? operation?.classification));
  if (!completed && operation?.status === 'pending' && operation.code === 'MODEL_REVIEW') $('#dialog-title').textContent = 'Перевод на проверке сотрудника';
  if (!completed && decision.code === 'MODEL_BLOCK') { $('#dialog-title').textContent = 'Перевод заблокирован'; $('#dialog .dialog-symbol').classList.remove('amber'); $('#dialog .dialog-symbol').classList.add('red'); }
  if (ui.role === 'client' && operation?.status === 'pending' && operation.code === 'MODEL_REVIEW') $('#dialog .dialog-actions').insertAdjacentHTML('afterbegin', `<button type="button" class="button secondary" data-ai-operation="${esc(operation.id)}">Обсудить с ИИ</button>`);
  if (account.role === 'employee' && operation) $('#dialog .dialog-actions').insertAdjacentHTML('beforebegin', renderCaseRiskCard(operation, state, { esc, money, date }));
  if (operation?.purchaseCheckId) $('#dialog .dialog-actions').insertAdjacentHTML('beforebegin', renderPurchaseCase(operation, state, { esc, money, date }));
  if (account.role === 'client' && operation?.guardianApproval) $('#dialog .dialog-actions').insertAdjacentHTML('beforebegin', renderTrustedOperation(operation, { esc, money, date }));
  if (decision.code === 'TRUSTED_REQUIRED') $('#dialog-title').textContent = 'Нужно разрешение доверенных лиц';
}
let pendingRequest = null;
async function submitOperation() {
  const request = requestFromForm();
  request.requestId = createRequestId();
  if (request.amount === null) { $('#form-error').textContent = 'Введите положительную сумму, не более двух знаков после запятой.'; return; }
  await prepareOperation(request);
}
async function prepareOperation(request) {
  const result = await action('attempt', request);
  if (['INVALID_AMOUNT', 'INVALID_RECIPIENT', 'INVALID_KIND'].includes(result.decision.code)) { if ($('#form-error')) $('#form-error').textContent = result.decision.reason; else toast(result.decision.reason); return; }
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
    if (b.dataset.purchaseDemo) { await runPurchaseCheck(b.dataset.purchaseDemo); return; }
    if (b.hasAttribute('data-purchase-detach')) { ui.purchaseCheckId = null; render(); return; }
    if (b.dataset.purchaseUse) {
      const report = state.purchaseChecks?.find(item => item.id === b.dataset.purchaseUse);
      if (!report || report.expiresAt <= Date.now()) { toast('Срок проверки истёк. Проверьте покупку заново.'); return; }
      ui.purchaseCheckId = report.id; ui.recipient = report.recipientId; ui.amount = String(report.amount / 100); ui.kind = 'transfer'; pendingRequest = null;
      navigate('transfer'); return;
    }
    if (b.dataset.trustedVote) {
      const r = state.trustedInbox.find(item => item.requestId === b.dataset.trustedRequest);
      if (!r || r.status !== 'pending' || r.myVerdict || ui.trustedBusy) return;
      showDialog(b.dataset.trustedVote === 'approve' ? 'Разрешить запрос?' : 'Отказать по запросу?', `<p>Клиент: ${esc(r.ownerName)}.</p>${r.type === 'operation' ? `<p>${r.kind === 'cash' ? 'Снятие' : `Перевод: ${esc(r.recipientName)}`} · <b>${money(r.amount)}</b>.</p>` : `<p>Изменение настроек защиты: ${r.proposed.enabled ? `новый лимит ${money(r.proposed.limit)}, группа ${r.proposed.names.map(esc).join(', ')}` : 'отключение подтверждения крупных операций'}.</p>`}<p>Ваше решение не отправляет деньги. Разрешение не отменяет ограничения банка.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Назад</button><button type="button" class="button" data-trusted-final="${esc(r.requestId)}" data-verdict="${esc(b.dataset.trustedVote)}">${b.dataset.trustedVote === 'approve' ? 'Подтверждаю разрешение' : 'Подтверждаю отказ'}</button></div>`);
      return;
    }
    if (b.dataset.trustedFinal) {
      if (ui.trustedBusy) return;
      const r = state.trustedInbox.find(item => item.requestId === b.dataset.trustedFinal);
      if (!r) return;
      ui.trustedBusy = true; b.disabled = true;
      try {
        await api('/api/trusted/decision', { ownerClientId: r.ownerClientId, operationId: r.operationId, requestId: r.requestId, verdict: b.dataset.verdict });
        const fresh = await api('/api/state'); state = fresh.state; receivedAt = Date.now(); closeDialog(); toast('Решение сохранено. Автоматического списания нет.');
      } finally { ui.trustedBusy = false; render(); }
      return;
    }
    if (b.dataset.trustedCancelChange || b.dataset.trustedCancelOperation) {
      if (ui.trustedBusy) return;
      await action('trusted-cancel', { requestId: b.dataset.trustedCancelChange, operationId: b.dataset.trustedCancelOperation });
      toast('Запрос отменён. Деньги не списаны.'); return;
    }
    if (b.dataset.trustedResume) {
      const op = state.operations.find(item => item.id === b.dataset.trustedResume);
      if (!op || op.trustedStatus !== 'approved') return;
      showDialog('Подтвердите операцию', `<p>Доверенные лица дали разрешение. Сервер ещё раз проверит его срок, сумму, получателя и ограничения банка.</p><div class="dialog-facts"><div><span>Получатель / операция</span><b>${esc(op.recipientName)}</b></div><div><span>Сумма</span><b>${money(op.amount)}</b></div></div><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button" data-confirm-trusted="${esc(op.id)}">Подтвердить списание в демо</button></div>`);
      return;
    }
    if (b.dataset.confirmTrusted) {
      b.disabled = true;
      try { const result = await action('confirm-trusted', { operationId: b.dataset.confirmTrusted }); decisionDialog(result.decision, result.operation, result.operation); }
      finally { b.disabled = false; }
      return;
    }
    if (b.hasAttribute('data-qr-payment-resolve')) { await resolvePaymentQr(b.dataset.qrPaymentResolve); return; }
    if (b.hasAttribute('data-qr-payment-attempt')) { await attemptQrPayment(b.dataset.qrPaymentAttempt); return; }
    if (b.dataset.reportOperation) {
      if (ui.complaintBusy) return;
      ui.complaintBusy = true;
      try {
        const result = await action('report-create', { operationId: b.dataset.reportOperation });
        ui.complaintId = result.reportId; ui.complaintDraft = ''; ui.complaintNote = ''; ui.complaintConsent = false; ui.complaintError = ''; ui.complaintRequestId = null;
        closeDialog(); navigate('complaints');
      } finally { ui.complaintBusy = false; render(); }
      return;
    }
    if (b.dataset.complaintOpen) {
      if (ui.complaintBusy) return;
      ui.complaintId = b.dataset.complaintOpen; ui.complaintDraft = ''; ui.complaintNote = ''; ui.complaintConsent = false; ui.complaintError = ''; ui.complaintRequestId = null; render(); return;
    }
    if (b.dataset.complaintWithdraw) {
      showDialog('Отозвать жалобу?', '<p>Обращение останется в вашей истории со статусом «Отозвана». Оно не будет основанием для новой отметки риска. Уже установленные сотрудником ограничения этим действием не снимаются.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button secondary" data-confirm-withdraw="' + esc(b.dataset.complaintWithdraw) + '">Отозвать жалобу</button></div>'); return;
    }
    if (b.dataset.confirmWithdraw) { await action('report-withdraw', { reportId: b.dataset.confirmWithdraw }); closeDialog(); toast('Жалоба отозвана.'); return; }
    if (b.hasAttribute('data-qr-clear')) { clearQrResult(); ui.qrFile = null; ui.qrText = ''; ui.qrMode = 'file'; ui.qrExpectedAmount = ''; ui.qrExpectedRecipient = ''; render(); return; }
    if (b.dataset.qrDemo && Object.hasOwn(QR_DEMOS, b.dataset.qrDemo)) {
      const demo = QR_DEMOS[b.dataset.qrDemo]; ui.qrDemo = b.dataset.qrDemo;
      ui.qrDemoPayment = null; ui.qrPaymentError = ''; ui.qrPaymentBusy = false; ui.qrPaymentJob++;
      ui.qrDemoReport = analyzeQr(demo.text, { expectedAmount: demo.expectedAmount || '', expectedRecipient: demo.expectedRecipient || '' }); render(); return;
    }
    if (b.hasAttribute('data-qr-link') && ui.qrReport?.kind === 'url' && ui.qrReport.checkUrl) {
      if (ui.urlBusy) { toast('Дождитесь завершения текущей проверки ссылки.'); return; }
      ui.urlDraft = ui.qrReport.checkUrl; ui.siteReport = null; ui.urlError = ''; ui.pageConsent = false; navigate('url-check'); return;
    }
    if (b.dataset.pageDemo && demoUrls[b.dataset.pageDemo]) { await runJuryScenario(b.dataset.pageDemo); return; }
    if (b.hasAttribute('data-retry-site')) { await inspectPage(); return; }
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
    if (b.dataset.page) { navigate(b.dataset.page); return; }
    if (b.dataset.kind) { ui.kind = b.dataset.kind; render(); }
    if (b.id === 'demo-change' || b.hasAttribute('data-change-phone')) phoneDialog();
    if (b.id === 'demo-forward') {
      await action('advance');
      toast(state.securityLock ? 'Прошло 24 часа. Блокировка «Это был не я» продолжает действовать.' : 'Прошло 24 часа. Новые операции снова проходят обычную проверку.');
    }
    if (b.id === 'demo-reset') showDialog('Сбросить выбранного клиента?', '<p>Сбросятся баланс, операции, жалобы и таймер выбранного клиента. История другого клиента, его отметки и общий ручной стоп-лист сохранятся.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button" id="confirm-reset">Сбросить клиента</button></div>', 'history');
    if (b.id === 'confirm-reset') { await action('reset'); ui.recipient = 'DEMO-FAMILY-001'; ui.amount = '3 000'; ui.kind = 'transfer'; ui.answers = {}; ui.complaintId = null; ui.complaintDraft = ''; ui.complaintNote = ''; ui.complaintConsent = false; ui.complaintError = ''; ui.complaintRequestId = null; pendingRequest = null; closeDialog(); toast('Демонстрация начата заново'); }
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
  const purchaseFields = { 'purchase-url': 'purchaseUrl', 'purchase-amount': 'purchaseAmount', 'purchase-explanation': 'purchaseExplanation' };
  if (purchaseFields[e.target.id]) ui[purchaseFields[e.target.id]] = e.target.value;
  if (e.target.id === 'trusted-daily-limit') ui.trustedDailyLimit = e.target.value;
  if (e.target.id === 'trusted-limit') ui.trustedLimit = e.target.value;
  if (e.target.id === 'trusted-logins') ui.trustedLogins = e.target.value;
  if (e.target.id === 'cbr-warning-url') { ui.cbrUrl = e.target.value; ui.cbrReport = null; ui.cbrError = ''; $('#investment-check')?.nextElementSibling?.classList.contains('client-link-result') && $('#investment-check').nextElementSibling.remove(); }
  if (e.target.id === 'complaint-message') { ui.complaintDraft = e.target.value; ui.complaintRequestId = null; }
  if (e.target.id === 'complaint-note') ui.complaintNote = e.target.value;
  if (['qr-text', 'qr-expected-amount', 'qr-expected-recipient'].includes(e.target.id)) {
    clearQrResult();
    if (e.target.id === 'qr-text') { ui.qrText = e.target.value; ui.qrMode = 'text'; ui.qrFile = null; if ($('#qr-file')) $('#qr-file').value = ''; $('.qr-selected')?.remove(); }
    if (e.target.id === 'qr-expected-amount') ui.qrExpectedAmount = e.target.value;
    if (e.target.id === 'qr-expected-recipient') ui.qrExpectedRecipient = e.target.value;
  }
  if (e.target.id === 'website-url') {
    ui.urlDraft = e.target.value; ui.siteReport = null; ui.urlError = ''; ui.pageConsent = false;
    // A result must never remain visible as the verdict for newly edited input.
    $('.url-result')?.remove();
    $('.site-report')?.remove();
    $('.url-check-panel .notice.error')?.remove();
  }
  if (e.target.id === 'jury-url') { ui.juryUrl = e.target.value; ui.juryModelResult = null; ui.juryModelError = ''; $('.jury-model-result')?.remove(); $('#jury-model-error')?.remove(); }
  if (e.target.id === 'amount') ui.amount = e.target.value;
  if (e.target.id === 'ai-message') { ui.aiDraft = e.target.value; ui.aiRequestId = null; }
  if (e.target.id === 'custom-id') { ui.customId = e.target.value; updateRecipientInfo(); }
  if (e.target.id === 'custom-name') ui.customName = e.target.value;
  if (e.target.id?.startsWith('reply-')) ui.answers[e.target.id.slice(6)] = e.target.value;
  if (e.target.id?.startsWith('review-comment-')) ui.answers['review-' + e.target.id.slice(15)] = e.target.value;
});
document.addEventListener('change', e => {
  if (e.target.id === 'purchase-recipient') ui.purchaseRecipient = e.target.value;
  if (e.target.id === 'purchase-consent') ui.purchaseConsent = e.target.checked;
  if (e.target.id === 'trusted-enabled') ui.trustedEnabled = e.target.checked;
  if (e.target.id === 'trusted-mode') ui.trustedMode = e.target.value;
  if (e.target.id === 'staff-client') { void switchStaffClient(e.target.value); return; }
  if (e.target.id === 'complaint-consent') {
    ui.complaintConsent = e.target.checked;
    const button = $('#complaint-chat-form button[type="submit"]');
    if (button) button.disabled = !ui.complaintConsent || !ui.complaintConfigured || ui.complaintBusy;
  }
  if (e.target.id === 'qr-file') { clearQrResult(); ui.qrFile = e.target.files?.[0] || null; ui.qrMode = 'file'; ui.qrText = ''; render(); }
  if (e.target.id === 'ai-operation') ui.aiOperationId = e.target.value;
  if (e.target.id === 'ai-consent') ui.aiConsent = e.target.checked;
  if (e.target.id === 'recipient') { ui.recipient = e.target.value; $('#custom-recipient').hidden = ui.recipient !== 'custom'; updateRecipientInfo(); }
  if (e.target.id === 'operation-filter') { ui.filter = e.target.value; render(); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    if (e.target.id === 'purchase-check-form') { await runPurchaseCheck(); return; }
    if (e.target.id === 'security-recovery-form') {
      if (ui.recoveryBusy) return;
      const step = e.target.dataset.recoveryStep, requestId = e.target.dataset.recoveryRequest;
      const password = $('#security-recovery-password').value;
      const newPassword = $('#security-recovery-new-password')?.value;
      const repeated = $('#security-recovery-repeat-password')?.value;
      if (step === 'complete' && newPassword !== repeated) { ui.recoveryError = 'Новые пароли не совпадают'; render(); return; }
      $('#security-recovery-password').value = '';
      if ($('#security-recovery-new-password')) $('#security-recovery-new-password').value = '';
      if ($('#security-recovery-repeat-password')) $('#security-recovery-repeat-password').value = '';
      ui.recoveryBusy = true; ui.recoveryError = ''; render();
      try { await action(`security-recovery-${step}`, { requestId, password, ...(step === 'complete' ? { newPassword } : {}) }); }
      catch (error) { ui.recoveryError = error.message; }
      finally { ui.recoveryBusy = false; render(); }
      return;
    }
    if (e.target.id === 'security-recovery-review-form') {
      if (ui.recoveryBusy) return;
      const form = new FormData(e.target);
      const payload = { requestId: e.target.dataset.recoveryRequest, verdict: e.submitter?.value,
        comment: form.get('comment'), checks: Object.fromEntries(['knownChannel', 'incidentReviewed', 'accessSecured'].map(key => [key, form.has(key)])) };
      ui.recoveryBusy = true; ui.recoveryError = ''; render();
      try { await action('security-recovery-decide', payload); toast('Решение сохранено. Блокировка пока остаётся.'); }
      catch (error) { ui.recoveryError = error.message; }
      finally { ui.recoveryBusy = false; render(); }
      return;
    }
    if (e.target.id === 'trusted-policy-form') {
      if (ui.trustedBusy) return;
      const limit = parseAmount(ui.trustedLimit), dailyLimit = ui.trustedDailyLimit.trim() ? parseAmount(ui.trustedDailyLimit) : null, password = $('#trusted-password').value;
      $('#trusted-password').value = '';
      if (limit === null) { ui.trustedError = 'Введите положительный лимит с точностью до копейки'; render(); return; }
      if (ui.trustedDailyLimit.trim() && dailyLimit === null) { ui.trustedError = 'Введите положительный общий лимит за 24 часа или оставьте поле пустым'; render(); return; }
      ui.trustedBusy = true; ui.trustedError = ''; render();
      try {
        const result = await action('trusted-policy', { enabled: ui.trustedEnabled, limit, dailyLimit, mode: ui.trustedMode,
          guardianLogins: ui.trustedLogins.split(',').map(value => value.trim()).filter(Boolean), password });
        toast(result.trusted.pending ? 'Запрос отправлен действующей группе. Прежние настройки пока сохраняются.' : 'Настройки подтверждения сохранены.');
      } catch (error) { ui.trustedError = error.message; }
      finally { ui.trustedBusy = false; render(); }
      return;
    }
    if (e.target.id === 'complaint-chat-form') {
      if (ui.complaintBusy) return;
      const report = (state.fraudReports || []).find(r => r.id === ui.complaintId) || state.fraudReports?.[0];
      if (!report || !ui.complaintConsent || !ui.complaintDraft.trim()) { toast('Напишите ответ и подтвердите согласие на внешний ИИ.'); return; }
      ui.complaintRequestId ||= createRequestId();
      const payload = { reportId: report.id, message: ui.complaintDraft.trim(), consent: true, requestId: ui.complaintRequestId };
      ui.complaintBusy = true; ui.complaintError = ''; render();
      try {
        const result = await api('/api/complaints/chat', payload);
        state = result.state; receivedAt = Date.now(); ui.complaintId = result.reportId; ui.complaintDraft = ''; ui.complaintRequestId = null;
      } catch (error) { ui.complaintError = error.message; }
      finally { ui.complaintBusy = false; render(); }
      return;
    }
    if (e.target.id === 'complaint-submit-form') {
      if (ui.complaintBusy) return;
      const report = (state.fraudReports || []).find(r => r.id === ui.complaintId) || state.fraudReports?.[0];
      if (!report) return;
      ui.complaintBusy = true; ui.complaintError = ''; render();
      try { await action('report-submit', { reportId: report.id, note: ui.complaintNote }); ui.complaintDraft = ''; ui.complaintNote = ''; toast('Жалоба передана сотруднику. Получатель автоматически не блокируется.'); }
      catch (error) { ui.complaintError = error.message; }
      finally { ui.complaintBusy = false; render(); }
      return;
    }
    if (e.target.dataset.complaintReview) {
      if (ui.complaintBusy) return;
      const form = e.target;
      const payload = { reportId: form.dataset.complaintReview, verdict: form.elements.verdict.value, comment: form.elements.comment.value };
      ui.complaintBusy = true; ui.complaintError = '';
      try { await action('report-review', payload); toast('Решение сохранено. Новые переводы проверяются с учётом отметки.'); }
      catch (error) { ui.complaintError = error.message; }
      finally { ui.complaintBusy = false; render(); }
      return;
    }
    if (e.target.id === 'qr-form') { await checkQr(); return; }
    if (e.target.id === 'cbr-warning-form') { await checkCbrList(); return; }
    if (e.target.id === 'url-check-form') { await inspectPage(); return; }
    if (e.target.id === 'jury-url-form') { await runJuryUrlModel(); return; }
    if (e.target.id === 'ai-chat-form') {
      if (ui.aiBusy) return;
      const message = ui.aiDraft.trim();
      if (!message || !ui.aiConsent) { toast('Напишите объяснение и подтвердите согласие'); return; }
      ui.aiRequestId ||= createRequestId();
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
window.addEventListener('hashchange', () => {
  if (location.hash === '#profile') ui.page = 'profile';
  else if (location.hash === '#trusted') ui.page = 'trusted';
  else if (location.hash === '#jury') ui.page = 'jury-demo';
  else if (location.hash === '#qr') ui.page = 'qr-check';
  else if (location.hash === '#qr-demo') ui.page = 'qr-demo';
  else if (location.hash === '#complaints') ui.page = account.role === 'employee' ? 'fraud-reports' : 'complaints';
  else if (location.hash === '#history') ui.page = account.role === 'employee' ? 'cases' : 'history';
  else if (location.hash === '#links' || ui.page === 'jury-demo') ui.page = 'url-check';
  render();
});
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
    const epoch = clientSelectionEpoch, selected = activeClientId;
    const data = await api('/api/state' + (account.role === 'employee' ? `?clientId=${encodeURIComponent(selected)}` : ''));
    if (epoch !== clientSelectionEpoch || selected !== activeClientId || ui.clientSwitchBusy) return;
    assistantConfig = data.assistant;
    inspectorConfig = data.websiteInspector;
    $('#connection-notice').hidden = true;
    if (data.state.revision !== state.revision || data.state.registryRevision !== state.registryRevision || data.state.trustedInboxRevision !== state.trustedInboxRevision || data.state.trustedRevision !== state.trustedRevision) {
      state = data.state; receivedAt = Date.now();
      // A registry mark may change without any change to this client's balance or history.
      ui.qrPayment = null; ui.qrDemoPayment = null; ui.qrPaymentJob++; ui.qrPaymentBusy = false;
      if (account.role === 'employee') await loadRegistry(false);
      // Keep an unfinished form intact; the next submit still checks the server's current state.
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) render(); else renderBanner();
    }
  } catch { $('#connection-notice').hidden = false; }
  finally { refreshing = false; }
}, 4000);
