import { redact } from './anti-scam-model.mjs';

export const REPORT_PENDING_MS = 45000;
export const REPORT_LIMITS = Object.freeze({ reports: 200, drafts: 10, validTurns: 4, attempts: 6 });
export const REPORT_AI_ERRORS = Object.freeze({
  not_configured: 'ИИ-помощник не настроен. Жалобу можно отправить сотруднику без ИИ.',
  quota: 'Лимит ИИ исчерпан. Жалобу можно отправить сотруднику без ИИ.',
  timeout: 'ИИ не успел ответить. Повторите сообщение или отправьте жалобу сотруднику без ИИ.',
  unavailable: 'ИИ временно недоступен. Жалобу можно отправить сотруднику без ИИ.',
  invalid_response: 'Не удалось проверить ответ ИИ. Жалобу можно отправить сотруднику без ИИ.',
});

const CATEGORIES = new Set(['unknown', 'non_delivery', 'qr_substitution', 'phishing', 'impersonation', 'other']);
const actualTime = (state, now) => now - (Number.isFinite(state.offsetMs) ? state.offsetMs : 0);
const reportOf = (state, id) => {
  const report = typeof id === 'string' && state.fraudReports?.find(item => item.id === id);
  if (!report) throw new Error('Нет такой жалобы');
  return report;
};

function event(state, now, type, report, actor = 'Система') {
  state.events ??= [];
  state.events.unshift({
    id: `EVENT-${state.nextId++}`, at: now, actor, type,
    // Deliberately exclude all client text, model output, and moderation comments from the log.
    text: `Жалоба ${report.id}, операция ${report.operationId}: ${type}.`,
  });
}

function expirePending(report, actualNow) {
  for (const turn of report.turns) {
    if (turn.status !== 'processing') continue;
    if (actualNow - turn.startedAt < REPORT_PENDING_MS) throw new Error('Дождитесь ответа ИИ на предыдущее сообщение');
    turn.status = 'error';
    turn.error = REPORT_AI_ERRORS.timeout;
  }
}

export function createFraudReport(state, operationId, now) {
  const operation = typeof operationId === 'string' && state.operations?.find(item => item.id === operationId);
  if (!operation || operation.kind !== 'transfer' || operation.status !== 'completed' ||
      typeof operation.recipientId !== 'string' || !operation.recipientId ||
      typeof operation.recipientName !== 'string' || !Number.isSafeInteger(operation.amount) || operation.amount <= 0) {
    throw new Error('Нет выполненного перевода для этой жалобы');
  }
  state.fraudReports ??= [];
  const existing = state.fraudReports.find(item => item.operationId === operation.id);
  if (existing) return existing;
  if (state.fraudReports.length >= REPORT_LIMITS.reports) throw new Error('Нет возможности создать ещё одну жалобу. Обратитесь к сотруднику банка.');
  if (state.fraudReports.filter(item => item.status === 'draft').length >= REPORT_LIMITS.drafts) throw new Error('Нет возможности создать ещё один черновик. Завершите существующие жалобы.');
  const report = {
    id: `FRAUD-${crypto.randomUUID()}`, operationId: operation.id,
    recipientId: operation.recipientId, recipientName: operation.recipientName, amount: operation.amount,
    createdAt: now, updatedAt: now, status: 'draft', note: '', turns: [], assessment: null, review: null,
    reviewRevision: 0,
  };
  state.fraudReports.unshift(report);
  event(state, now, 'fraud-report-created', report, 'Клиент');
  return report;
}

export function reserveReportTurn(state, body, now, actualNow) {
  if (!body || body.consent !== true) throw new Error('Укажите согласие на отправку текста внешнему ИИ-сервису');
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1200 ||
      typeof body.requestId !== 'string' || !/^[\w-]{10,80}$/.test(body.requestId)) {
    throw new Error('Укажите сообщение до 1200 символов и корректный идентификатор запроса');
  }
  const report = reportOf(state, body.reportId);
  if (report.status !== 'draft') throw new Error('Нет открытого черновика для продолжения опроса');
  const message = redact(body.message.trim());
  const existing = report.turns.find(item => item.requestId === body.requestId);
  if (existing) {
    if (existing.message !== message) throw new Error('Укажите новый идентификатор запроса для другого сообщения');
    if (existing.status === 'processing' && actualNow - existing.startedAt >= REPORT_PENDING_MS) {
      existing.status = 'error'; existing.error = REPORT_AI_ERRORS.timeout;
    }
    return { report, turn: existing, cached: true };
  }
  expirePending(report, actualNow);
  if (report.turns.filter(item => item.status !== 'error').length >= REPORT_LIMITS.validTurns || report.turns.length >= REPORT_LIMITS.attempts) {
    throw new Error('Нет возможности продолжать опрос. Отправьте жалобу сотруднику банка.');
  }
  const turn = { requestId: body.requestId, message, status: 'processing', startedAt: actualNow, at: now };
  report.turns.push(turn);
  report.updatedAt = now;
  return { report, turn, cached: false };
}

function cleanAssessment(value) {
  if (!value || Array.isArray(value) || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 1400 ||
      !CATEGORIES.has(value.category) || !(value.next_question === null || typeof value.next_question === 'string') ||
      (typeof value.next_question === 'string' && value.next_question.length > 350)) return null;
  const result = {
    summary: redact(value.summary.trim()), next_question: value.next_question?.trim() ? redact(value.next_question.trim()) : null,
    category: value.category,
  };
  // The model cannot smuggle payment permissions or a moderation verdict into persisted assessment.
  if (value.source === 'groq') result.source = 'groq';
  for (const key of ['model_version', 'prompt_version']) {
    if (typeof value[key] === 'string' && value[key].length <= 120) result[key] = redact(value[key]);
  }
  return result;
}

export function finishReportTurn(state, reportId, requestId, assessment, errorCode, now) {
  const report = state.fraudReports?.find(item => item.id === reportId);
  const turn = report?.turns.find(item => item.requestId === requestId);
  // A reset, withdrawal or completed employee review must never be undone by a late model response.
  if (!turn) return null;
  if (report.status !== 'draft' || turn.status !== 'processing') return report;
  if (actualTime(state, now) - turn.startedAt >= REPORT_PENDING_MS) {
    turn.status = 'error'; turn.error = REPORT_AI_ERRORS.timeout; report.updatedAt = now;
    return report;
  }
  const cleaned = assessment ? cleanAssessment(assessment) : null;
  if (cleaned) {
    if (report.turns.filter(item => item.status !== 'error').length >= REPORT_LIMITS.validTurns) cleaned.next_question = null;
    turn.status = 'done'; turn.response = cleaned;
    report.assessment = { ...cleaned, at: now };
    event(state, now, 'fraud-report-assessment', report);
  } else {
    turn.status = 'error';
    turn.error = REPORT_AI_ERRORS[assessment ? 'invalid_response' : errorCode] || REPORT_AI_ERRORS.unavailable;
  }
  report.updatedAt = now;
  return report;
}

export function submitFraudReport(state, reportId, note, now) {
  const report = reportOf(state, reportId);
  if (report.status !== 'draft') throw new Error('Нет черновика для отправки жалобы');
  expirePending(report, actualTime(state, now));
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 2000)) throw new Error('Укажите описание до 2000 символов');
  const supplied = typeof note === 'string' ? note.trim() : '';
  const saved = report.turns.map(item => item.message).join('\n').trim();
  if (supplied.length < 5 && saved.length < 5) throw new Error('Укажите описание происшествия не короче 5 символов или ответьте помощнику');
  report.note = redact(supplied.length >= 5 ? supplied : saved).slice(0, 2000);
  report.status = 'submitted'; report.submittedAt = now; report.updatedAt = now;
  event(state, now, 'fraud-report-submitted', report, 'Клиент');
  return report;
}

export function withdrawFraudReport(state, reportId, now) {
  const report = reportOf(state, reportId);
  if (!['draft', 'submitted'].includes(report.status)) throw new Error('Нет жалобы, которую можно отозвать. Решение сотрудника этим действием не отменяется.');
  expirePending(report, actualTime(state, now));
  report.status = 'withdrawn'; report.withdrawnAt = now; report.updatedAt = now;
  event(state, now, 'fraud-report-withdrawn', report, 'Клиент');
  return report;
}

export function reviewFraudReport(state, reportId, verdict, comment, now, actor = 'Сотрудник') {
  if (!['watch', 'block', 'dismiss'].includes(verdict)) throw new Error('Выберите решение по жалобе');
  if (typeof comment !== 'string' || comment.trim().length < 5 || comment.length > 1000) throw new Error('Укажите комментарий сотрудника от 5 до 1000 символов');
  const report = reportOf(state, reportId);
  if (!['submitted', 'watch', 'blocked'].includes(report.status)) throw new Error('Нет отправленной жалобы для рассмотрения');
  expirePending(report, actualTime(state, now));
  report.reviewRevision = (Number.isSafeInteger(report.reviewRevision) ? report.reviewRevision : 0) + 1;
  report.review = {
    verdict, comment: redact(comment.trim()), decidedAt: now,
    decidedBy: typeof actor === 'string' && actor.trim() ? redact(actor.trim()).slice(0, 80) : 'Сотрудник',
    revision: report.reviewRevision,
  };
  report.status = { watch: 'watch', block: 'blocked', dismiss: 'dismissed' }[verdict];
  report.updatedAt = now;
  event(state, now, `fraud-report-${report.status}`, report, 'Сотрудник');
  return report;
}
