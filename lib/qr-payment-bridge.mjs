import { RECIPIENTS } from './bank-engine.mjs';

// Educational stand-in for a bank's authenticated payment-intent resolver.
// No URL parsing, DNS, HTTP or real NSPK lookup occurs here. Exact bytes only:
// appending a sum, changing a character or copying a merchant name is not a match.
const FIXTURE_VERSION = 'demo-qr-v1';
const FIXTURES = Object.freeze([
  Object.freeze({ id: 'demo-qr-normal', payload: 'https://qr.nspk.ru/DEMO1000000000000000000000000000', recipientId: 'DEMO-FAMILY-001', amount: 100000 }),
  Object.freeze({ id: 'demo-qr-shared', payload: 'https://qr.nspk.ru/DEMO2000000000000000000000000000', recipientId: 'DEMO-CLASS-NORMAL', amount: 300000 }),
]);

function fixtureOf(payload) {
  return typeof payload === 'string' && payload.length <= 4096
    ? FIXTURES.find(item => item.payload === payload) : undefined;
}

function canonicalRecipient(fixture) {
  const recipient = RECIPIENTS.find(item => item.id === fixture.recipientId);
  if (!recipient) throw new Error('Нет учебного получателя для QR');
  return { id: recipient.id, name: recipient.name, bank: recipient.bank };
}

function complaintCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
}

/** Read-only preview. Never authorizes a transfer and never exposes registry notes. */
export function resolveQrPayment(payload, registry, options = {}) {
  const fixture = fixtureOf(payload);
  const common = {
    demo: true, source: 'demo_qr_adapter', fixtureVersion: FIXTURE_VERSION,
    recipientVerified: false, authenticQrVerified: false,
  };
  if (!fixture) return {
    ...common, supported: false, status: 'unsupported', registryStatus: 'not_checked',
    message: 'Этот код не найден в учебном банковском справочнике. Получатель не определён; оплатить через прототип нельзя. Это не означает, что QR мошеннический или безопасный.',
  };
  const recipient = canonicalRecipient(fixture);
  const matches = Array.isArray(registry) ? registry.filter(item => item?.recipient_id === recipient.id) : [];
  const registryStatus = !Array.isArray(registry) ? 'unavailable'
    : matches.some(item => item.status === 'active') ? 'blocked'
    : matches.some(item => item.status === 'watch') ? 'watch' : 'clear';
  const count = complaintCount(options?.reviewedComplaintCount);
  const hasReviewedComplaints = (count !== null && count > 0)
    || matches.some(item => ['active', 'watch'].includes(item.status) && item.source === 'synthetic_complaint_review');
  const messages = {
    unavailable: 'Реестр недоступен. Проверка не завершена; перевод пока недоступен.',
    blocked: 'Получатель в стоп-листе учебного банка. Перевод будет остановлен, даже если получатель прежний.',
    watch: 'По получателю установлена отметка дополнительной проверки. Следующая попытка перевода направляется на рассмотрение, деньги не списываются.',
    clear: 'Действующих отметок в учебном реестре нет. Это не гарантирует безопасность: далее банк проверит сам перевод и ограничения счёта.',
  };
  return {
    ...common, supported: true, status: 'resolved', fixtureId: fixture.id,
    recipient, amountKopecks: fixture.amount, amountRub: fixture.amount / 100,
    registryStatus, hasReviewedComplaints, reviewedComplaintCount: count,
    message: messages[registryStatus],
  };
}

/**
 * Mandatory on EVERY attempt and confirmation, inside the bank API.
 * All payment fields originate on the server. A preview, client amount or parsed
 * merchant name is never used as authority. The caller still applies its normal
 * classifier, registry, account hold, idempotency and confirmation checks.
 */
export function qrTransferRequest(payload, fixtureId) {
  const fixture = fixtureOf(payload);
  if (!fixture || fixture.id !== fixtureId) {
    const error = new Error('Учебный QR не распознан или изменился. Повторите проверку перед подтверждением.');
    error.code = 'QR_PAYMENT_UNSUPPORTED';
    error.status = 400;
    throw error;
  }
  const recipient = canonicalRecipient(fixture);
  return {
    kind: 'transfer', recipientId: recipient.id, recipientName: recipient.name,
    amount: fixture.amount,
    paymentContext: { source: 'demo_qr_adapter', fixtureId: fixture.id, fixtureVersion: FIXTURE_VERSION, recipientId: recipient.id },
  };
}
