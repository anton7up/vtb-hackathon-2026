import { DEMO_CLASS_RECIPIENTS, ensureDemoRecipientHistory } from './demo-class-recipients.mjs';
import { trustedGate, ensureTrustedApproval } from './trusted-approval.mjs';
export const DAY = 24 * 60 * 60 * 1000;
export const VERSION = 2;
const NORMAL_SCENARIO_RECIPIENTS = Object.freeze([
  { id: 'DEMO-FAMILY-001', name: 'Мама (обычный перевод)', bank: 'Демо банк', initials: 'МА', demoGroup: 'normal', suggestedAmount: 50000 },
  { id: 'DEMO-FRIEND-001', name: 'Михаил · друг (обычный перевод)', bank: 'Демо банк', initials: 'МИ', demoGroup: 'normal', suggestedAmount: 50000 },
  { id: 'DEMO-NORMAL-003', name: 'Оплата аренды (обычный перевод)', bank: 'Демо банк', initials: 'АР', demoGroup: 'normal', suggestedAmount: 50000 },
  { id: 'DEMO-NORMAL-004', name: 'Коммунальные услуги (обычный перевод)', bank: 'Демо банк', initials: 'КУ', demoGroup: 'normal', suggestedAmount: 50000 },
  { id: 'DEMO-NORMAL-005', name: 'Знакомый магазин (обычный перевод)', bank: 'Демо банк', initials: 'ЗМ', demoGroup: 'normal', suggestedAmount: 50000 },
]);
export const RECIPIENTS = [
  ...DEMO_CLASS_RECIPIENTS,
  ...NORMAL_SCENARIO_RECIPIENTS,
  { id: 'DEMO-NEW-001', name: 'Продавец велосипеда', bank: 'Демо банк', initials: 'ВЛ' },
  { id: 'DEMO-ML-REVIEW-001', name: 'Алексей Орлов (ML: доп. проверка + ИИ)', bank: 'Демо банк', initials: 'АО', demoGroup: 'review', suggestedAmount: 325000 },
  { id: 'DEMO-ML-REVIEW-002', name: 'Маркет электроники (ML: доп. проверка + ИИ)', bank: 'Демо банк', initials: 'МЭ', demoGroup: 'review', suggestedAmount: 325000 },
  { id: 'DEMO-ML-REVIEW-003', name: 'Частный продавец (ML: доп. проверка + ИИ)', bank: 'Демо банк', initials: 'ЧП', demoGroup: 'review', suggestedAmount: 325000 },
  { id: 'DEMO-ML-REVIEW-004', name: 'Сервис объявлений (ML: доп. проверка + ИИ)', bank: 'Демо банк', initials: 'СО', demoGroup: 'review', suggestedAmount: 325000 },
  { id: 'DEMO-ML-REVIEW-005', name: 'Новый поставщик (ML: доп. проверка + ИИ)', bank: 'Демо банк', initials: 'НП', demoGroup: 'review', suggestedAmount: 325000 },
  { id: 'DEMO-ML-BLOCK-001', name: 'Безопасный счёт мошенников (ML: блокировка)', bank: 'Демо банк', initials: 'БС', demoGroup: 'block', suggestedAmount: 5000000 },
  { id: 'DEMO-ML-BLOCK-002', name: 'Фишинговый получатель (ML: блокировка)', bank: 'Демо банк', initials: 'ФП', demoGroup: 'block', suggestedAmount: 5000000 },
  { id: 'DEMO-ML-BLOCK-003', name: 'Захваченный аккаунт (ML: блокировка)', bank: 'Демо банк', initials: 'ЗА', demoGroup: 'block', suggestedAmount: 5000000 },
  { id: 'DEMO-ML-BLOCK-004', name: 'Лжеинвестиции (ML: блокировка)', bank: 'Демо банк', initials: 'ЛИ', demoGroup: 'block', suggestedAmount: 5000000 },
  { id: 'DEMO-ML-BLOCK-005', name: 'Счёт посредника (ML: блокировка)', bank: 'Демо банк', initials: 'СП', demoGroup: 'block', suggestedAmount: 5000000 },
  { id: 'DEMO-WATCH-001', name: 'Алексей Орлов · служебная watch-запись', bank: 'Демо банк', initials: 'АО', reviewDemo: true, suggestedAmount: 100000 },
  { id: 'DEMO-WATCH-002', name: 'Маркет электроники · служебная watch-запись', bank: 'Демо банк', initials: 'МЭ', reviewDemo: true, suggestedAmount: 100000 },
  { id: 'DEMO-WATCH-003', name: 'Частный продавец · служебная watch-запись', bank: 'Демо банк', initials: 'ЧП', reviewDemo: true, suggestedAmount: 100000 },
  { id: 'DEMO-WATCH-004', name: 'Сервис объявлений · служебная watch-запись', bank: 'Демо банк', initials: 'СО', reviewDemo: true, suggestedAmount: 100000 },
  { id: 'DEMO-WATCH-005', name: 'Новый поставщик · служебная watch-запись', bank: 'Демо банк', initials: 'НП', reviewDemo: true, suggestedAmount: 100000 },
  { id: 'DEMO-RISK-001', name: 'Демо получатель 1', bank: 'Демо банк', initials: 'Д1' },
  { id: 'DEMO-RISK-002', name: 'Демо получатель 2', bank: 'Демо банк', initials: 'Д2' },
  { id: 'DEMO-RISK-003', name: 'Демо получатель 3', bank: 'Демо банк', initials: 'Д3' },
  { id: 'DEMO-RISK-004', name: 'Демо получатель 4', bank: 'Демо банк', initials: 'Д4' },
  { id: 'DEMO-RISK-005', name: 'Демо получатель 5', bank: 'Демо банк', initials: 'Д5' }
];
export function ensureRecipientScenarioHistory(state, now) {
  ensureDemoRecipientHistory(state, now);
  const anchor = Math.min(now, ...state.operations.filter(o => o.seeded).map(o => o.createdAt));
  for (const recipient of NORMAL_SCENARIO_RECIPIENTS) {
    if (state.operations.some(op => op.kind === 'transfer' && op.recipientId === recipient.id && op.status === 'completed')) continue;
    state.operations.push({ id: `HISTORY-${recipient.id}`, kind: 'transfer', recipientId: recipient.id, recipientName: recipient.name,
      amount: recipient.suggestedAmount, createdAt: anchor - DAY, status: 'completed', code: 'COMPLETED',
      reason: 'Вымышленная демо-история обычного перевода. Не списывает деньги с текущего баланса.', seeded: true });
  }
  return state;
}
export function initialState(now = Date.now()) {
  return ensureRecipientScenarioHistory({
    version: VERSION, balance: 24830000, phone: '+7 000 000-00-01', offsetMs: 0,
    lastCriticalChange: null, changeKind: null, nextId: 1,
    operations: [
      { id: 'HISTORY-1', kind: 'transfer', recipientId: 'DEMO-FAMILY-001', recipientName: 'Мама', amount: 300000, createdAt: now - 3 * DAY, status: 'completed', code: 'COMPLETED', reason: 'Перевод выполнен', seeded: true },
      { id: 'HISTORY-2', kind: 'transfer', recipientId: 'DEMO-FRIEND-001', recipientName: 'Михаил · друг', amount: 150000, createdAt: now - 2 * DAY, status: 'completed', code: 'COMPLETED', reason: 'Перевод выполнен', seeded: true },
      { id: 'HISTORY-3', kind: 'transfer', recipientId: 'DEMO-RISK-002', recipientName: 'Демо получатель 2', amount: 100000, createdAt: now - DAY, status: 'completed', code: 'COMPLETED', reason: 'Перевод до включения получателя в демо-реестр', seeded: true }
    ],
    events: [{ id: 'EVENT-0', at: now, actor: 'Система', type: 'created', text: 'Открыт демонстрационный счёт. Баланс 248 300 ₽.' }],
    tickets: [], registryAdditions: [], securityAlerts: [], securityLock: null,
    modelMock: { mode: 'normal', revision: 0 }
  }, now);
}
export function timeOf(state, actualNow = Date.now()) { return actualNow + state.offsetMs; }
export function protectionOf(state, now) {
  const endsAt = state.lastCriticalChange === null ? null : state.lastCriticalChange + DAY;
  return { active: endsAt !== null && now < endsAt, endsAt, remainingMs: endsAt === null ? 0 : Math.max(0, endsAt - now) };
}
export function isKnown(state, recipientId, now) {
  const cutoff = protectionOf(state, now).active ? state.lastCriticalChange : now + 1;
  return state.operations.some(op => op.kind === 'transfer' && op.recipientId === recipientId && op.status === 'completed' && (op.completedAt ?? op.createdAt) < cutoff);
}
export function parseAmount(value) {
  const normalized = String(value).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
export function evaluate(state, request, registry, now, options = {}) {
  const hold = protectionOf(state, now);
  const base = { allowed: false, known: request.kind === 'transfer' && isKnown(state, request.recipientId, now), endsAt: hold.endsAt, classification: request.classification ?? null };
  const reject = (code, reason) => ({ ...base, code, reason });
  if (!['transfer', 'cash'].includes(request.kind)) return reject('INVALID_KIND', 'Неизвестная операция');
  if (!Number.isSafeInteger(request.amount) || request.amount <= 0) return reject('INVALID_AMOUNT', 'Введите положительную сумму, не более двух знаков после запятой.');
  if (state.securityLock) return reject('ACCOUNT_SECURITY_LOCK', 'Клиент сообщил «Это был не я». Все переводы и снятие наличных заблокированы. Деньги остаются на счёте.');
  if (request.kind === 'transfer') {
    if (!request.recipientId || !/^[A-Z0-9][A-Z0-9_-]{2,49}$/.test(request.recipientId)) return reject('INVALID_RECIPIENT', 'Укажите корректный демонстрационный ID получателя.');
    if (!Array.isArray(registry)) return reject('REGISTRY_UNAVAILABLE', 'Реестр временно недоступен. Проверка не завершена, деньги не списаны.');
    const match = registry.find(entry => entry.status === 'active' && entry.recipient_id === request.recipientId);
    if (match) return { ...reject('RISK_REGISTRY', 'Получатель найден в демонстрационном реестре подозрительных. Перевод остановлен.'), registryReason: match.reason, registryCode: match.reason_code };
    if (hold.active && !base.known) return reject('NEW_RECIPIENT_HOLD', 'После изменения данных доступа переводы новым получателям недоступны 24 часа. Деньги остаются на счёте.');
  } else if (hold.active) {
    return reject('CASH_HOLD', 'После изменения данных доступа снятие наличных недоступно 24 часа. Деньги остаются на счёте.');
  }
  if (request.amount > state.balance) return reject('INSUFFICIENT_FUNDS', 'На демонстрационном счёте недостаточно денег.');
  if (request.kind === 'transfer' && Object.hasOwn(request, 'classification')) {
    if (!request.classification || !['normal', 'review', 'block'].includes(request.classification.class)) return reject('MODEL_UNAVAILABLE', 'Проверка классификатором не завершена. Перевод не выполнен, деньги не списаны. Повторите проверку позже.');
    if (request.classification.class === 'block') return reject('MODEL_BLOCK', 'Класс перевода — «Блокировка». Перевод остановлен защитой. Деньги не списаны.');
    if (registry.some(entry => entry.status === 'watch' && entry.recipient_id === request.recipientId)) {
      return { ...reject('MODEL_REVIEW', 'По получателю есть обращения, рассмотренные сотрудником. Нужна дополнительная проверка перевода. Деньги не списаны.'), classification: { ...request.classification, class: 'review', source: 'policy', model_version: 'recipient-reports-v1' } };
    }
    if (request.classification.class === 'review') return reject('MODEL_REVIEW', 'Класс перевода — «Нужно проверить». Перевод передан сотруднику банка; до проверки деньги не списываются.');
  }
  if (!options.skipTrusted) {
    const gate = trustedGate(state, request, now - (state.offsetMs || 0));
    if (gate) return reject(gate.code, gate.reason);
  }
  return { ...base, allowed: true, code: 'READY', reason: request.kind === 'cash' ? 'Защитной паузы нет. Можно подтвердить снятие.' : (hold.active ? 'Это прежний получатель, совпадений в демо-реестре нет. Можно подтвердить перевод.' : 'Совпадений в демо-реестре нет. Можно подтвердить перевод.') };
}
function event(state, now, type, text, actor = 'Система') {
  const id = `EVENT-${state.nextId++}`;
  state.events.unshift({ id, at: now, actor, type, text });
}
export function securityEvent(state, kind, actualNow, sourceSessionHash) {
  const labels = { login: 'Новый вход в аккаунт', phone: 'Изменён номер телефона', recovery: 'Восстановлен доступ к аккаунту' };
  const alert = { id: `SEC-${crypto.randomUUID()}`, kind, text: labels[kind], createdAt: actualNow, at: timeOf(state, actualNow), sourceSessionHash };
  state.securityAlerts ??= [];
  state.securityAlerts.unshift(alert);
  state.securityAlerts = state.securityAlerts.slice(0, 50);
  if (kind === 'login') event(state, alert.at, 'login', 'Выполнен новый вход. Предупреждение доступно только в ранее открытых сессиях.', 'Клиент');
  return alert;
}
export function reportSecurity(state, alert, now) {
  if (state.securityLock) return;
  state.securityLock = { at: now, alertId: alert.id, eventText: alert.text };
  const ticket = { id: `REQ-${String(state.nextId++).padStart(4, '0')}`, kind: 'security', operationId: null, createdAt: now, status: 'open', priority: 'urgent', eventText: alert.text, eventAt: alert.at, reply: '' };
  state.tickets.unshift(ticket);
  event(state, now, 'security-report', `СРОЧНО: клиент сообщил «Это был не я»: ${alert.text}. Все переводы и наличные заблокированы. Создано обращение ${ticket.id}.`, 'Клиент');
}
export function acknowledgeSecurity(state, alert, now) {
  state.securityAlerts = (state.securityAlerts || []).filter(item => item.id !== alert.id);
  event(state, now, 'security-acknowledged', `Клиент подтвердил событие «${alert.text}». Предупреждение закрыто без блокировки операций.`, 'Клиент');
}
export function changeAccess(state, kind, now, phone) {
  if (!['phone', 'recovery'].includes(kind)) throw new Error('Неизвестное изменение данных доступа');
  if (kind === 'phone' && (!phone || phone === state.phone)) throw new Error('Укажите новый номер');
  state.lastCriticalChange = now;
  state.changeKind = kind;
  if (kind === 'phone') state.phone = phone;
  event(state, now, kind, `${kind === 'phone' ? 'Изменён номер телефона' : 'Восстановлен доступ к аккаунту'}. Переводы новым получателям и снятие наличных закрыты на 24 часа.`, 'Клиент');
}
export function attempt(state, request, registry, now) {
  const existing = request.requestId && state.operations.find(op => op.requestId === request.requestId);
  if (existing) return { operation: existing, duplicate: true, decision: { allowed: existing.status === 'completed', code: existing.code, reason: existing.reason, classification: existing.classification } };
  const decision = evaluate(state, request, registry, now);
  if (decision.allowed) return { decision, operation: null };
  if (['INVALID_AMOUNT', 'INVALID_RECIPIENT', 'INVALID_KIND'].includes(decision.code)) return { decision, operation: null };
  const operation = record(state, request, decision, now, pendingCode(decision.code) ? 'pending' : 'blocked');
  return { decision, operation };
}
function record(state, request, decision, now, status) {
  const operation = {
    id: `OP-${String(state.nextId++).padStart(4, '0')}`, kind: request.kind,
    recipientId: request.recipientId ?? null, recipientName: request.recipientName ?? 'Наличные',
    amount: request.amount, createdAt: now, status, code: status === 'completed' ? 'COMPLETED' : decision.code,
    senderBalanceBefore: state.balance,
    reason: status === 'completed' ? (request.kind === 'cash' ? 'Снятие выполнено в демо' : 'Перевод выполнен в демо') : decision.reason,
    knownAtDecision: decision.known, holdEndsAt: decision.endsAt,
    registryReason: decision.registryReason ?? null,
    classification: decision.classification ?? request.classification ?? null, modelFeatures: request.modelFeatures ?? null,
    requestId: request.requestId,
    review: decision.code === 'MODEL_REVIEW' ? { status: 'pending' } : null
  };
  state.operations.unshift(operation);
  if (status === 'pending' && ['MODEL_REVIEW', 'TRUSTED_REQUIRED'].includes(decision.code)) ensureTrustedApproval(state, operation, now - (state.offsetMs || 0));
  event(state, now, status, `${request.kind === 'cash' ? 'Снятие наличных' : `Перевод ${operation.recipientId}`}: ${operation.reason}`);
  return operation;
}
const pendingCode = code => ['REGISTRY_UNAVAILABLE', 'MODEL_REVIEW', 'MODEL_UNAVAILABLE', 'TRUSTED_REQUIRED'].includes(code);
export function confirmOperation(state, request, registry, now) {
  // Repeat all checks at confirmation: the phone or registry may have changed in another tab.
  if (!request.requestId) throw new Error('Нет идентификатора подтверждения');
  const existing = state.operations.find(op => op.requestId === request.requestId);
  if (existing) return { operation: existing, duplicate: true, decision: { allowed: existing.status === 'completed', code: existing.code, reason: 'Это подтверждение уже обработано.', classification: existing.classification ?? null } };
  const decision = evaluate(state, request, registry, now);
  if (['INVALID_AMOUNT', 'INVALID_RECIPIENT', 'INVALID_KIND'].includes(decision.code)) return { decision, operation: null };
  const status = decision.allowed ? 'completed' : pendingCode(decision.code) ? 'pending' : 'blocked';
  const operation = record(state, request, decision, now, status);
  operation.requestId = request.requestId;
  if (decision.allowed) {
    state.balance -= request.amount;
    operation.completedAt = now;
    operation.actualCompletedAt = now - (state.offsetMs || 0);
  }
  return { operation, decision };
}
export function openTicket(state, operationId, now) {
  const operation = state.operations.find(op => op.id === operationId);
  if (!operation || operation.status === 'completed') throw new Error('Нет остановленной операции');
  const existing = state.tickets.find(t => t.operationId === operationId && t.status === 'open');
  if (existing) return existing;
  const ticket = { id: `REQ-${String(state.nextId++).padStart(4, '0')}`, operationId, createdAt: now, status: 'open', reply: '' };
  state.tickets.unshift(ticket);
  event(state, now, 'ticket', `Создано обращение ${ticket.id} по операции ${operationId}.`, 'Клиент');
  return ticket;
}
export function replyToTicket(state, ticketId, reply, now) {
  const ticket = state.tickets.find(t => t.id === ticketId && t.status === 'open');
  if (!ticket || !reply.trim()) throw new Error('Выберите обращение и укажите ответ');
  ticket.reply = reply.trim().slice(0, 1000);
  ticket.status = 'answered';
  ticket.answeredAt = now;
  event(state, now, 'reply', `Отправлен ответ на ${ticket.id}. Ограничения операции не изменены.`, 'Сотрудник');
}
export function addRegistryEntry(state, entry, registry, now) {
  const id = entry.recipient_id?.trim().toUpperCase();
  if (!/^DEMO-[A-Z0-9_-]{1,40}$/.test(id ?? '')) throw new Error('ID должен начинаться с DEMO- и содержать латинские буквы, цифры или дефис');
  if (!entry.reason?.trim() || !entry.display_name?.trim()) throw new Error('Укажите имя и причину');
  if (!Array.isArray(registry)) throw new Error('Сначала дождитесь загрузки реестра');
  if (registry.some(e => e.recipient_id === id)) throw new Error('Такой ID уже есть в реестре');
  state.registryAdditions.push({ recipient_id: id, display_name: entry.display_name.trim().slice(0, 80), reason: entry.reason.trim().slice(0, 300), reason_code: 'DEMO_EMPLOYEE_REVIEW', status: 'active', source: 'synthetic_hackathon_data', action: 'block_transfer' });
  event(state, now, 'registry', `В демонстрационный реестр добавлен ${id}.`, 'Сотрудник');
}
