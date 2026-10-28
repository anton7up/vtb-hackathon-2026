import { redact } from './anti-scam-model.mjs';
import { isKnown } from './bank-engine.mjs';

export const AI_PENDING_MS = 45000;
export const ASSISTANT_ERRORS = {
  not_configured: 'ИИ-помощник пока не настроен. Перевод не разрешён автоматически.',
  quota: 'Лимит запросов ИИ исчерпан. Попробуйте позже или обратитесь к сотруднику банка.',
  timeout: 'ИИ не успел ответить. Попробуйте позже. Деньги не списаны.',
  unavailable: 'Сервис ИИ временно недоступен. Обратитесь к сотруднику банка.',
  invalid_response: 'Не удалось проверить ответ ИИ. Требуется проверка сотрудника.',
};
export function reserveAssistant(state, body, now, actualNow) {
  if (body.consent !== true) throw new Error('Укажите согласие на обработку текста внешним ИИ-сервисом');
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1200 || typeof body.requestId !== 'string' || !/^[\w-]{10,80}$/.test(body.requestId)) throw new Error('Укажите сообщение до 1200 символов и корректный идентификатор запроса');
  state.aiConversations ??= [];
  let conversation = body.conversationId ? state.aiConversations.find(c => c.id === body.conversationId) : null;
  if (body.conversationId && !conversation) throw new Error('Нет такого диалога. Начните новую проверку.');
  if (!conversation) {
    // Request IDs also deduplicate the creation of a conversation.
    conversation = state.aiConversations.find(c => c.turns.some(t => t.requestId === body.requestId));
  }
  if (conversation) {
    const existing = conversation.turns.find(t => t.requestId === body.requestId);
    if (existing) return { conversation, turn: existing, cached: true };
    const pending = conversation.turns.find(t => t.status === 'processing');
    if (pending && actualNow - pending.startedAt < AI_PENDING_MS) throw new Error('Дождитесь ответа ИИ на предыдущее сообщение');
    if (pending) { pending.status = 'error'; pending.error = ASSISTANT_ERRORS.timeout; }
    if (conversation.status === 'complete') throw new Error('Нет необходимости продолжать завершённую проверку. Начните новый диалог для другой ситуации.');
    if (conversation.turns.filter(t => t.status !== 'error').length >= 4 || conversation.turns.length >= 6) throw new Error('Нет возможности продолжать этот диалог. Обратитесь к сотруднику.');
  } else {
    const op = body.operationId ? state.operations.find(o => o.id === body.operationId && o.kind === 'transfer') : null;
    if (body.operationId && (!op || op.status !== 'pending' || op.code !== 'MODEL_REVIEW')) throw new Error('Нет перевода класса «Нужно проверить» для этого диалога');
    conversation = { id: crypto.randomUUID(), operationId: op?.id ?? null, createdAt: now, status: 'asking', context: op ? { amount_kopecks: op.amount, is_new_recipient: !isKnown(state, op.recipientId, now), transfer_class: op.classification?.class ?? null } : null, turns: [] };
    state.aiConversations.unshift(conversation);
    state.aiConversations = state.aiConversations.filter((c, i) => i < 8 || c.turns.some(t => t.status === 'processing' && actualNow - t.startedAt < AI_PENDING_MS));
  }
  const op = conversation.operationId && state.operations.find(o => o.id === conversation.operationId);
  if (op && (op.status !== 'pending' || op.code !== 'MODEL_REVIEW')) throw new Error('Нет ожидающего проверки перевода. Его статус уже изменился.');
  if (op?.aiPendingUntil > actualNow) throw new Error('Дождитесь завершения уже запущенной ИИ-проверки перевода');
  const turn = { requestId: body.requestId, message: redact(body.message.trim()), status: 'processing', startedAt: actualNow, at: now };
  conversation.turns.push(turn); conversation.status = 'processing';
  if (op) {
    op.aiPendingUntil = actualNow + AI_PENDING_MS;
    op.aiPendingRequest = body.requestId;
    if (op.review?.status === 'approved') { op.review = { status: 'pending' }; op.reason = 'Начата ИИ-проверка. После её завершения нужно новое решение сотрудника.'; }
  }
  return { conversation, turn, cached: false };
}
export function finishAssistant(state, conversationId, requestId, assessment, errorCode, now) {
  const c = state.aiConversations?.find(c => c.id === conversationId), turn = c?.turns.find(t => t.requestId === requestId);
  if (!turn) return null; // A demo reset must not restore an old conversation or touch a reused operation ID.
  if (turn.status !== 'processing') return c;
  turn.status = assessment ? 'done' : 'error';
  if (assessment) turn.response = assessment;
  else turn.error = ASSISTANT_ERRORS[errorCode] || ASSISTANT_ERRORS.unavailable;
  c.status = assessment ? assessment.next_question ? 'asking' : 'complete' : 'error';
  const op = c.operationId && state.operations.find(o => o.id === c.operationId);
  if (op?.aiPendingRequest === requestId) { op.aiPendingUntil = null; op.aiPendingRequest = null; }
  if (assessment) {
    c.assessment = { ...assessment, at: now, conversationId: c.id };
    if (op && op.status === 'pending' && op.code === 'MODEL_REVIEW') {
      op.aiAssessment = c.assessment;
      if (assessment.class === 'block') {
        op.status = 'blocked'; op.code = 'AI_SCAM_BLOCK';
        op.reason = 'ИИ обнаружил признаки опасной схемы в объяснении клиента. Перевод остановлен. Деньги не списаны.';
        op.review = { status: 'invalidated' };
      }
    }
    state.events.unshift({ id: `EVENT-${state.nextId++}`, at: now, type: 'ai-assessment', actor: 'Система', text: `ИИ-помощник: ${c.operationId || 'общая проверка'}, рекомендация ${assessment.class}, сценарий ${assessment.scenario}. Это предварительная оценка, не разрешение платежа.` });
  }
  return c;
}
