const amountText = amount => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);

/** Pure renderer: the app owns request lifecycle and stale-result invalidation. */
export function renderQrPaymentEntry(payload, { esc }, { busy = false, error = '', role = 'client', result = null, demo = false } = {}) {
  if (typeof payload !== 'string' || !payload || role !== 'client') return '';
  return `<section class="panel qr-payment-bridge" aria-label="Проверка получателя QR в учебном банке">
    <h2>Проверить получателя в банке</h2>
    <p class="qr-note">Для хакатона подключён учебный справочник только с двумя вымышленными кодами. Реальные QR СБП он не разрешает. Подлинность наклейки и честность продавца по одному коду установить нельзя.</p>
    <p class="qr-note">По кнопке текст QR будет отправлен только нашему серверу. Ссылки из QR не открываются; реальные платёжные данные не используйте.</p>
    <button type="button" class="button secondary" data-qr-payment-resolve${demo ? '="demo"' : '="check"'} ${busy ? 'disabled' : ''}>${busy ? 'Проверяем получателя…' : result ? 'Обновить проверку получателя' : 'Проверить в учебном банке'}</button>
    ${error ? `<p class="notice error" role="alert">${esc(error)}</p>` : ''}
    ${result ? renderQrPayment(result, { esc }, { busy, demo }) : ''}
  </section>`;
}

export function renderQrPayment(report, { esc, money = amountText }, { busy = false, demo = false } = {}) {
  if (!report) return '';
  if (!report.supported) return `<div class="notice warning" role="status"><b>Получатель не определён</b><p>${esc(report.message)}</p><p>Без данных банковского провайдера неизвестный платёжный ID не превращается в проверенные реквизиты.</p></div>`;
  const status = report.registryStatus;
  const tone = status === 'blocked' ? 'error' : status === 'clear' ? '' : 'warning';
  const title = status === 'blocked' ? 'Получатель в стоп-листе демо' : status === 'watch' ? 'Нужна дополнительная проверка' : status === 'unavailable' ? 'Проверка не завершена' : 'Получатель определён в учебном справочнике';
  const canAttempt = ['clear', 'watch'].includes(status);
  return `<div class="qr-payment-result notice ${tone}" aria-live="polite"><span class="pill amber">УЧЕБНАЯ БАНКОВСКАЯ ИНТЕГРАЦИЯ</span><h3>${esc(title)}</h3>
    <dl class="qr-facts"><div><dt>Получатель из учебного банка</dt><dd>${esc(report.recipient?.name)}</dd></div><div><dt>Сумма из учебного банка</dt><dd>${esc(money(report.amountKopecks))}</dd></div><div><dt>Демо-ID получателя</dt><dd>${esc(report.recipient?.id)}</dd></div></dl>
    <p>${esc(report.message)}</p>
    ${report.hasReviewedComplaints ? `<p><b>По получателю есть рассмотренные жалобы${Number.isSafeInteger(report.reviewedComplaintCount) && report.reviewedComplaintCount > 0 ? `: ${esc(report.reviewedComplaintCount)}` : ''}.</b> Личные данные и обстоятельства других клиентов не раскрываются.</p>` : ''}
    ${canAttempt ? `<button type="button" class="button" data-qr-payment-attempt${demo ? '="demo"' : '="check"'} ${busy ? 'disabled' : ''}>Проверить перевод в демо</button><p class="qr-note">Это ещё не оплата. Действуют обычные проверки банка; списание демонстрационного баланса возможно только после отдельного подтверждения.</p>` : '<p class="qr-note">Деньги не списаны. Продолжить перевод через эту проверку нельзя.</p>'}
    <p class="qr-note">Определение получателя не подтверждает, что QR принадлежит ожидаемому магазину. Подлинность QR и отсутствие мошенничества не подтверждены.</p>
  </div>`;
}
