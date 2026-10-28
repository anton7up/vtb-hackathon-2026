import { DAY, VERSION, RECIPIENTS, initialState, timeOf, protectionOf, isKnown, parseAmount, evaluate, attempt, confirmOperation, changeAccess, openTicket, replyToTicket, addRegistryEntry } from './engine.mjs';

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
const KEY = 'antiscam-protection-v2';
let storageAvailable = true;
let state;
function readState() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    if (value?.version === VERSION && Number.isSafeInteger(value.balance) && value.balance >= 0 && Array.isArray(value.operations) && Array.isArray(value.events) && Array.isArray(value.tickets) && Array.isArray(value.registryAdditions) && Number.isFinite(value.offsetMs)) return value;
  } catch { storageAvailable = false; }
  return null;
}
state = readState() || initialState();
let wasActive = protectionOf(state, timeOf(state)).active;
let baseRegistry = null;
let registryStatus = 'loading';
const ui = { role: new URLSearchParams(location.search).get('role') === 'employee' ? 'employee' : 'client', page: 'transfer', kind: 'transfer', recipient: 'DEMO-FAMILY-001', amount: '3 000', customId: '', customName: '', answers: {}, filter: 'all' };
if (ui.role === 'employee') ui.page = 'cases';
const registry = () => baseRegistry === null ? null : [...baseRegistry, ...state.registryAdditions];
const now = () => timeOf(state);
const allRecipients = () => {
  const map = new Map(RECIPIENTS.map(r => [r.id, r]));
  for (const entry of state.registryAdditions) if (!map.has(entry.recipient_id)) map.set(entry.recipient_id, { id: entry.recipient_id, name: entry.display_name, bank: 'Демо банк', initials: 'ДП' });
  return [...map.values()];
};
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { storageAvailable = false; }
  $('#storage-notice').hidden = storageAvailable;
}
async function mutate(fn) {
  const run = () => {
    const stored = readState();
    if (stored) state = stored;
    const result = fn();
    persist();
    render();
    return result;
  };
  return navigator.locks ? navigator.locks.request(KEY, run) : run();
}
let toastTimer;
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4300); }
function showDialog(title, content, symbol = 'shield', tone = '') {
  $('#dialog-content').innerHTML = `<div class="dialog-inner"><button type="button" class="dialog-close" aria-label="Закрыть окно" data-close>×</button><div class="dialog-symbol ${tone}">${icon(symbol)}</div><h2 id="dialog-title">${esc(title)}</h2>${content}</div>`;
  if (!$('#dialog').open) $('#dialog').showModal();
}
const closeDialog = () => $('#dialog').close();
function renderBanner() {
  const hold = protectionOf(state, now());
  const banner = $('#protection-banner');
  banner.className = `protection-banner${hold.active ? ' hold' : ''}`;
  if (hold.active) banner.innerHTML = `<div class="banner-icon">${icon('clock')}</div><div><b>Защитная пауза после изменения данных</b><p>Новым получателям и наличными — после ${esc(date(hold.endsAt))}. Прежним получателям переводить можно.</p></div><div class="countdown"><span id="countdown"></span><small>до окончания паузы</small></div>`;
  else banner.innerHTML = `<div class="banner-icon">${icon('shield')}</div><div><b>${state.lastCriticalChange === null ? 'Счёт под защитой. Ограничений по времени нет' : 'Защитная пауза завершена'}</b><p>${state.lastCriticalChange === null ? 'Проверяем каждого получателя перед отправкой. История и баланс всегда доступны.' : 'Переводы и наличные снова доступны после проверки. Остановленные операции не отправляются автоматически.'}</p></div>`;
  tick();
}
function tick() {
  const remaining = protectionOf(state, now()).remainingMs;
  if ($('#countdown')) {
    const secs = Math.ceil(remaining / 1000);
    $('#countdown').textContent = [Math.floor(secs / 3600), Math.floor(secs % 3600 / 60), secs % 60].map(x => String(x).padStart(2, '0')).join(':');
  }
  $('#demo-clock').textContent = `${date(now())} МСК${state.offsetMs ? ' · демо-время' : ''}`;
}
const navItems = {
  client: [['transfer', 'transfer', 'Переводы'], ['security', 'lock', 'Безопасность'], ['history', 'history', 'История']],
  employee: [['cases', 'shield', 'Операции'], ['registry', 'list', 'Реестр'], ['events', 'history', 'Журнал']]
};
const titles = {
  transfer: ['Переводы и наличные', 'Управляйте деньгами. Мы позаботимся о проверке.'],
  security: ['Безопасность аккаунта', 'Данные доступа и защита после их изменения.'],
  history: ['История и обращения', 'Все операции, решения системы и ответы банка.'],
  cases: ['Контроль операций', 'Видно каждое решение: основание, получатель и результат.'],
  registry: ['Подозрительные получатели', 'Демонстрационная база для проверки переводов.'],
  events: ['Журнал событий', 'Хронология изменений данных, проверок и обращений.']
};
function render() {
  wasActive = protectionOf(state, now()).active;
  $('#storage-notice').hidden = storageAvailable;
  document.querySelectorAll('[data-role]').forEach(b => { b.classList.toggle('active', b.dataset.role === ui.role); b.setAttribute('aria-pressed', b.dataset.role === ui.role ? 'true' : 'false'); });
  $('#nav-caption').textContent = ui.role === 'client' ? 'МОЙ БАНК' : 'РАБОЧЕЕ МЕСТО';
  $('#eyebrow').textContent = ui.role === 'client' ? 'ЛИЧНЫЙ КАБИНЕТ' : 'АНТИФРОД · ДЕМО СОТРУДНИКА';
  $('#profile-name').textContent = ui.role === 'client' ? 'Анна Ковалёва' : 'Сотрудник антифрода';
  $('#profile-description').textContent = ui.role === 'client' ? 'Демонстрационный клиент' : 'Клиент: Анна Ковалёва';
  $('#navigation').innerHTML = navItems[ui.role].map(([id, symbol, title]) => `<button type="button" data-page="${id}" class="${ui.page === id ? 'active' : ''}" ${ui.page === id ? 'aria-current="page"' : ''}>${icon(symbol)}${title}</button>`).join('');
  $('#page-title').textContent = titles[ui.page][0]; $('#page-description').textContent = titles[ui.page][1];
  renderBanner();
  const views = { transfer: transferView, security: securityView, history: historyView, cases: employeeView, registry: registryView, events: eventsView };
  $('#workspace').innerHTML = views[ui.page]();
  updateRecipientInfo();
}
function balanceCard() { return `<div class="panel balance-card"><div class="balance-top"><span>Мастер-счёт · RUB</span><span class="mini-shield">${icon('shield')} Защищён</span></div><strong id="balance">${money(state.balance)}</strong><div class="balance-bottom"><span>Доступный демо-баланс</span><b>•• 4812</b></div></div>`; }
function policyView() {
  const active = protectionOf(state, now()).active;
  return `<div class="aside-grid"><div class="panel"><div class="policy-title"><h2>Что доступно сейчас</h2>${icon('shield')}</div>${[
    ['user', 'Прежние получатели', 'После проверки по реестру', true], ['transfer', 'Новые получатели', active ? 'Пауза на 24 часа' : 'После проверки по реестру', !active], ['cash', 'Снятие наличных', active ? 'До окончания паузы' : 'После подтверждения', !active], ['history', 'Баланс и история', 'Без ограничений', true]
  ].map(([symbol, title, text, allowed]) => `<div class="policy-item"><span class="policy-icon">${icon(symbol)}</span><div><b>${title}</b><p>${text}</p></div><span class="availability ${allowed ? '' : 'closed'}">${allowed ? 'Доступно' : 'Пауза'}</span></div>`).join('')}<p class="aside-note">Старый получатель — тот, кому вы успешно переводили до изменения данных. Совпадение в реестре останавливает любой перевод.</p></div><div class="panel support-card"><h3>${icon('message')} Банк рядом</h3><p>Откройте остановленную операцию и создайте обращение. Ответ сотрудника появится в истории.</p><button class="link-button" data-page="history">История и обращения →</button></div></div>`;
}
function transferView() {
  const options = allRecipients().map(r => `<option value="${esc(r.id)}" ${ui.recipient === r.id ? 'selected' : ''}>${esc(r.name)} · ${isKnown(state, r.id, now()) ? 'прежний' : 'новый'}</option>`).join('');
  return `<div class="grid-main"><div>${balanceCard()}<section class="panel"><h2>Новая операция</h2><div class="segment" role="group" aria-label="Тип операции"><button data-kind="transfer" type="button" class="${ui.kind === 'transfer' ? 'active' : ''}">${icon('transfer')} Перевод</button><button data-kind="cash" type="button" class="${ui.kind === 'cash' ? 'active' : ''}">${icon('cash')} Наличные</button></div><form id="operation-form" novalidate>${ui.kind === 'transfer' ? `<label class="field-label" for="recipient">Кому переводим</label><select id="recipient" name="recipient">${options}<option value="custom" ${ui.recipient === 'custom' ? 'selected' : ''}>Другой получатель по демо-ID</option></select><div id="custom-recipient" ${ui.recipient === 'custom' ? '' : 'hidden'}><label class="field-label" for="custom-id">Демонстрационный ID</label><input id="custom-id" maxlength="50" placeholder="DEMO-NEW-002" value="${esc(ui.customId)}"><label class="field-label" for="custom-name">Имя для истории</label><input id="custom-name" maxlength="80" placeholder="Новый получатель" value="${esc(ui.customName)}"></div><div class="recipient-meta" id="recipient-info"></div>` : `<div class="notice">${icon('cash')} Демонстрация снятия наличных. Банкомат и карта не подключены.</div>`}<label class="field-label" for="amount">Сумма, ₽</label><input class="amount-input" id="amount" inputmode="decimal" autocomplete="off" value="${esc(ui.amount)}" aria-describedby="amount-help"><p class="field-help" id="amount-help">${ui.kind === 'transfer' ? 'Комиссия в демо — 0 ₽' : 'Деньги списываются только после подтверждения'}</p><p id="form-error" class="dialog-error" role="alert"></p><button class="button full" type="submit">Проверить ${ui.kind === 'transfer' ? 'перевод' : 'снятие'} ${icon('arrow')}</button><p class="secure-caption">${icon('lock')} Сначала проверка, затем подтверждение</p></form></section></div><aside>${policyView()}</aside></div>${operationsTable(state.operations.slice(0, 5), false, 'Последние операции')}`;
}
function requestFromForm() {
  const r = allRecipients().find(r => r.id === ui.recipient);
  return { kind: ui.kind, amount: parseAmount(ui.amount), recipientId: ui.kind === 'cash' ? undefined : ui.recipient === 'custom' ? ui.customId.trim().toUpperCase() : ui.recipient, recipientName: ui.kind === 'cash' ? 'Наличные' : r?.name ?? (ui.customName.trim() || ui.customId.trim().toUpperCase()) };
}
function updateRecipientInfo() {
  if (!$('#recipient-info')) return;
  const request = requestFromForm();
  const known = isKnown(state, request.recipientId, now());
  const match = registry()?.find(e => e.status === 'active' && e.recipient_id === request.recipientId);
  $('#recipient-info').innerHTML = `<span class="pill ${known ? 'green' : 'blue'}">${icon('user')}${known ? 'Прежний получатель' : 'Новый получатель'}</span><span class="pill ${registryStatus !== 'ready' ? 'amber' : match ? 'red' : 'green'}">${icon(match ? 'alert' : 'shield')}${registryStatus !== 'ready' ? 'Реестр: проверка недоступна' : match ? 'Есть в демо-реестре' : 'Нет совпадений в реестре'}</span><span class="pill">${esc(request.recipientId || 'Демо-ID не указан')}</span>`;
}
function statusPill(op) { return `<span class="pill ${op.status === 'completed' ? 'green' : op.status === 'pending' ? 'amber' : 'red'}">${op.status === 'completed' ? 'Выполнено' : op.status === 'pending' ? 'На проверке' : 'Остановлено'}</span>`; }
function operationsTable(ops, employee = false, title = 'Операции') {
  return `<section class="panel history"><div class="section-head"><h2>${esc(title)}</h2><small>${ops.length} записей</small></div><div class="table-wrap"><table class="${employee ? 'employee-table' : 'client-table'}"><thead><tr><th>Получатель / операция</th><th class="money">Сумма</th>${employee ? '<th>Основание</th>' : ''}<th>Статус</th><th></th></tr></thead><tbody>${ops.length ? ops.map(op => `<tr><td><div class="recipient-cell"><span class="recipient-avatar">${icon(op.kind === 'cash' ? 'cash' : 'user')}</span><div>${esc(op.recipientName)}<small>${esc(date(op.createdAt))}${op.seeded ? ' · демо-история' : ''}</small></div></div></td><td class="money">${money(op.amount)}</td>${employee ? `<td class="reason-column">${esc(op.reason)}<small>${esc(op.code)} · ${op.kind === 'cash' ? 'Наличные' : op.knownAtDecision ? 'Прежний получатель' : 'Новый получатель'}</small></td>` : ''}<td>${statusPill(op)}</td><td><button type="button" class="link-button" data-operation="${esc(op.id)}" aria-label="Подробнее об операции ${esc(op.id)}">Подробнее</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Новых операций пока нет. Создайте перевод в кабинете клиента.</td></tr>'}</tbody></table></div></section>`;
}
function securityView() {
  return `<div class="security-layout"><section class="panel"><h2>Данные доступа</h2><p class="panel-subtitle">Изменение запускает защитную паузу на 24 часа.</p><div class="setting-row"><span class="policy-icon">${icon('phone')}</span><div><b>Номер телефона</b><p id="current-phone">${esc(state.phone)}</p></div><button type="button" class="button secondary small" data-change-phone>Изменить</button></div><div class="setting-row"><span class="policy-icon">${icon('lock')}</span><div><b>Восстановление доступа</b><p>Смена способа подтверждения</p></div><button type="button" class="button secondary small" id="restore-access">Восстановить</button></div><div class="security-illustration">${icon('shield')}<p>После изменения данных прежние получатели остаются доступны. Новые переводы и наличные — через 24 часа.</p></div><p class="aside-note">При повторном изменении 24 часа отсчитываются заново. Истечение времени не отправляет ранее остановленные операции.</p></section><section class="panel"><h2>Последние события</h2>${eventList(state.events.filter(e => ['phone', 'recovery', 'time'].includes(e.type)).slice(0, 6))}</section></div>`;
}
function ticketView(employee = false) {
  return `<section class="panel"><div class="section-head"><h2>${employee ? 'Обращения клиента' : 'Ваши обращения'}</h2><small>${state.tickets.filter(t => t.status === 'open').length} открыто</small></div>${state.tickets.length ? state.tickets.map(t => {
    const op = state.operations.find(o => o.id === t.operationId);
    return `<article class="ticket"><div class="ticket-top"><b>${esc(t.id)}</b><span class="pill ${t.status === 'open' ? 'amber' : 'green'}">${t.status === 'open' ? 'Ожидает ответа' : 'Есть ответ'}</span></div><p>${esc(op?.recipientName)} · ${money(op?.amount ?? 0)}<br>${esc(op?.reason)}</p>${t.reply ? `<p class="reply">${esc(t.reply)}</p><small class="muted">Сотрудник · ${date(t.answeredAt)}</small>` : employee ? `<form data-ticket="${esc(t.id)}"><label class="field-label" for="reply-${esc(t.id)}">Ответ клиенту</label><textarea id="reply-${esc(t.id)}" maxlength="1000" required placeholder="Объясните причину ограничения и дальнейшие действия">${esc(ui.answers[t.id] || '')}</textarea><button class="button small" type="submit">Отправить ответ</button></form>` : '<small class="muted">Ответ появится здесь после обработки сотрудником.</small>'}</article>`;
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
  const completed = operation?.status === 'completed';
  const title = completed ? (request.kind === 'cash' ? 'Наличные выданы в демо' : 'Перевод выполнен') : decision.code === 'RISK_REGISTRY' ? 'Получатель в демо-реестре' : decision.code === 'REGISTRY_UNAVAILABLE' ? 'Проверка не завершена' : 'Операция остановлена';
  showDialog(title, `<p>${esc(completed ? operation.reason : decision.reason)}</p><div class="dialog-facts"><div><span>${request.kind === 'cash' ? 'Операция' : 'Получатель'}</span><b>${esc(request.recipientName)}</b></div><div><span>Сумма</span><b>${money(request.amount)}</b></div>${!completed && decision.endsAt && ['CASH_HOLD', 'NEW_RECIPIENT_HOLD'].includes(decision.code) ? `<div><span>Пауза до</span><b>${date(decision.endsAt)} МСК</b></div>` : ''}${decision.registryReason ? `<div><span>Основание</span><b>${esc(decision.registryReason)}</b></div>` : ''}</div><p>${completed ? `Остаток: ${money(state.balance)}.` : 'Деньги не списаны. Операция не будет выполнена автоматически.'}</p><div class="dialog-actions">${operation && !completed && ui.role === 'client' ? `<button type="button" class="button secondary" data-support="${esc(operation.id)}">Обратиться в банк</button>` : ''}<button type="button" class="button" data-close>${completed ? 'Готово' : readOnly ? 'Закрыть' : 'Понятно'}</button></div>`, completed ? 'check' : 'lock', completed ? 'green' : decision.code === 'RISK_REGISTRY' ? 'red' : 'amber');
}
let pendingRequest = null;
async function submitOperation() {
  const request = requestFromForm();
  const result = await mutate(() => attempt(state, request, registry(), now()));
  if (['INVALID_AMOUNT', 'INVALID_RECIPIENT', 'INVALID_KIND'].includes(result.decision.code)) { $('#form-error').textContent = result.decision.reason; return; }
  if (!result.decision.allowed) { decisionDialog(result.decision, request, result.operation); return; }
  pendingRequest = { ...request, requestId: crypto.randomUUID() };
  showDialog(request.kind === 'cash' ? 'Подтвердите снятие' : 'Подтвердите перевод', `<p>${esc(result.decision.reason)}</p><div class="dialog-facts"><div><span>${request.kind === 'cash' ? 'Операция' : 'Получатель'}</span><b>${esc(request.recipientName)}</b></div><div><span>Сумма</span><b>${money(request.amount)}</b></div></div><p>При подтверждении спишется только демонстрационный баланс.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button" id="confirm-operation">Подтвердить</button></div>`, request.kind === 'cash' ? 'cash' : 'transfer');
}
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.hasAttribute('data-close')) { closeDialog(); return; }
    if (b.dataset.role) { ui.role = b.dataset.role; ui.page = ui.role === 'client' ? 'transfer' : 'cases'; const url = new URL(location.href); url.searchParams.set('role', ui.role); history.replaceState(null, '', url); render(); }
    if (b.dataset.page) { ui.page = b.dataset.page; render(); }
    if (b.dataset.kind) { ui.kind = b.dataset.kind; render(); }
    if (b.id === 'demo-change' || b.hasAttribute('data-change-phone')) phoneDialog();
    if (b.id === 'demo-forward') {
      await mutate(() => { state.offsetMs += DAY; state.events.unshift({ id: `EVENT-${state.nextId++}`, at: now(), actor: 'Демонстратор', type: 'time', text: 'Демо-время перемотано на 24 часа. Остановленные операции не отправлены.' }); });
      toast('Прошло 24 часа. Новые операции снова проходят обычную проверку.');
    }
    if (b.id === 'demo-reset') showDialog('Начать демонстрацию заново?', '<p>Сбросится только это демо: баланс, операции, обращения, добавленные записи реестра и таймер. Базовые пять записей останутся.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button type="button" class="button" id="confirm-reset">Начать заново</button></div>', 'history');
    if (b.id === 'confirm-reset') { await mutate(() => { state = initialState(); ui.recipient = 'DEMO-FAMILY-001'; ui.amount = '3 000'; ui.kind = 'transfer'; ui.answers = {}; }); pendingRequest = null; closeDialog(); toast('Демонстрация начата заново'); }
    if (b.id === 'restore-access') showDialog('Восстановить доступ?', '<p>Это демонстрация смены способа подтверждения. Начнётся новая пауза на 24 часа для новых получателей и наличных.</p><div class="dialog-actions"><button type="button" class="button subtle" data-close>Отмена</button><button class="button" type="button" id="confirm-recovery">Восстановить доступ</button></div>', 'lock');
    if (b.id === 'confirm-recovery') { await mutate(() => changeAccess(state, 'recovery', now())); closeDialog(); toast('Доступ восстановлен. Защитная пауза — 24 часа.'); }
    if (b.id === 'confirm-operation' && pendingRequest) {
      b.disabled = true;
      const request = pendingRequest; pendingRequest = null;
      const result = await mutate(() => confirmOperation(state, request, registry(), now()));
      decisionDialog(result.decision, request, result.operation);
    }
    if (b.dataset.operation) {
      const op = state.operations.find(x => x.id === b.dataset.operation);
      if (op) decisionDialog({ code: op.code, reason: op.reason, endsAt: op.holdEndsAt, registryReason: op.registryReason }, { kind: op.kind, recipientName: op.recipientName, amount: op.amount }, op, true);
    }
    if (b.dataset.support) { await mutate(() => openTicket(state, b.dataset.support, now())); closeDialog(); ui.page = 'history'; render(); toast('Обращение создано. Оно доступно сотруднику банка.'); }
    if (b.id === 'retry-registry') await loadRegistry();
  } catch (err) { toast(err.message); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'amount') ui.amount = e.target.value;
  if (e.target.id === 'custom-id') { ui.customId = e.target.value; updateRecipientInfo(); }
  if (e.target.id === 'custom-name') ui.customName = e.target.value;
  if (e.target.id?.startsWith('reply-')) ui.answers[e.target.id.slice(6)] = e.target.value;
});
document.addEventListener('change', e => {
  if (e.target.id === 'recipient') { ui.recipient = e.target.value; $('#custom-recipient').hidden = ui.recipient !== 'custom'; updateRecipientInfo(); }
  if (e.target.id === 'operation-filter') { ui.filter = e.target.value; render(); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    if (e.target.id === 'operation-form') await submitOperation();
    if (e.target.id === 'phone-form') {
      const phone = $('#new-phone').value.trim();
      if (!/^\+?[\d ()-]{10,25}$/.test(phone) || phone.replace(/\D/g, '').length !== 11 || phone.replace(/\D/g, '') === state.phone.replace(/\D/g, '')) { $('#phone-error').textContent = 'Укажите другой номер из 11 цифр.'; return; }
      await mutate(() => changeAccess(state, 'phone', now(), phone)); closeDialog(); toast('Номер изменён. Защитная пауза включена на 24 часа.');
    }
    if (e.target.id === 'registry-form') {
      const entry = { recipient_id: $('#registry-id').value, display_name: $('#registry-name').value, reason: $('#registry-reason').value };
      try { await mutate(() => addRegistryEntry(state, entry, registry(), now())); toast('Получатель добавлен в реестр. Проверка уже действует.'); }
      catch (err) { $('#registry-error').textContent = err.message; }
    }
    if (e.target.dataset.ticket) { const id = e.target.dataset.ticket; const reply = ui.answers[id] || ''; await mutate(() => replyToTicket(state, id, reply, now())); toast('Ответ отправлен клиенту'); }
  } catch (err) { toast(err.message); }
});
window.addEventListener('storage', e => { if (e.key === KEY) { const value = readState(); if (value) { state = value; render(); } } });
async function loadRegistry() {
  registryStatus = 'loading';
  try {
    const response = await fetch('./data/suspicious_recipients.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Не удалось загрузить реестр');
    const data = await response.json();
    if (!data.is_synthetic || !Array.isArray(data.entries) || !data.entries.every(e => typeof e.recipient_id === 'string' && typeof e.reason === 'string' && ['active', 'inactive'].includes(e.status))) throw new Error('Некорректный реестр');
    baseRegistry = data.entries; registryStatus = 'ready';
  } catch { baseRegistry = null; registryStatus = 'error'; }
  render();
}
$('#dialog').addEventListener('close', () => { pendingRequest = null; });
persist(); render(); loadRegistry();
setInterval(() => { const active = protectionOf(state, now()).active; if (active !== wasActive) { wasActive = active; render(); } else tick(); }, 1000);
