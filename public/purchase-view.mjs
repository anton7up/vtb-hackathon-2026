const titles = { review: 'Покупку нужно проверить', incomplete: 'Проверка не завершена', no_signals: 'Явных признаков не найдено' };
const registryTitles = { blocked: 'получатель в стоп-листе', watch: 'есть рассмотренные жалобы', not_listed: 'совпадение не найдено', unavailable: 'реестр недоступен' };
const cbrTitles = { matched: 'домен найден в списке', not_listed: 'совпадение домена не найдено', not_requested: 'не запрашивался', unavailable: 'источник недоступен' };

export function renderPurchaseReport(report, { esc, money, date }, { actionable = false, busy = false } = {}) {
  if (!report) return '';
  const expired = Number.isFinite(report.expiresAt) && report.expiresAt <= Date.now();
  return `<article class="purchase-report notice ${report.status === 'no_signals' ? '' : 'warning'}"><div class="section-head"><h3>${esc(titles[report.status] || 'Результат недоступен')}</h3>${report.source === 'demo' ? '<span class="pill amber">Учебный HTML</span>' : ''}</div>
    <p><b>${esc(report.site?.origin || report.origin || '')}</b> → ${esc(report.recipientName)} · ${esc(money(report.amount))}</p>
    <p class="field-help">Сайт указал клиент добровольно. Принадлежность сайта получателю не подтверждена; банк не получает эту ссылку из платежа автоматически.</p>
    <p>Объяснение клиента: ${esc(report.explanation)}</p>
    <ul class="purchase-findings">${(report.scan?.findings || report.findings || []).filter(f => f.severity !== 'info').map(f => `<li>${esc(f.message)}</li>`).join('') || '<li>Конкретных признаков риска в доступных результатах не найдено. Это не гарантия безопасности.</li>'}</ul>
    <p class="field-help">HTML: ${(report.scan?.status || report.scanStatus) === 'completed' ? 'одна страница проверена' : 'не удалось проверить'}. Реестр: ${esc(registryTitles[report.registry?.status || report.registryStatus] || 'недоступен')}. Список ЦБ: ${esc(cbrTitles[report.cbr?.status || report.cbrStatus] || 'не запрашивался')}.</p>
    ${report.model?.status === 'completed' ? `<p class="field-help">URL-модель: ${report.model.label === 'phishing' ? 'есть предупреждение, возможны ложные срабатывания' : 'предупреждения нет, безопасность не гарантирована'}. Модель анализирует только адрес, не продавца и не доставку.</p>` : report.model?.status === 'unavailable' ? '<p class="field-help">URL-модель недоступна; результат не подтверждает безопасность.</p>' : ''}
    ${report.incomplete ? '<p>Есть незавершённые проверки. Положительного заключения о безопасности нет.</p>' : ''}
    <p class="field-help">${expired ? 'Срок привязки истёк. Создайте новую проверку.' : `Привязка действительна до ${esc(date(report.expiresAt))} МСК только для этой суммы и получателя.`}</p>
    ${actionable && !expired ? `<button type="button" class="button secondary" data-purchase-use="${esc(report.id)}" ${busy ? 'disabled' : ''}>Продолжить с этим получателем</button>` : ''}
    <p class="aside-note">Результат не отправляет деньги, не подтверждает добросовестность магазина и не отменяет стоп-лист, защитную паузу или подтверждение близких.</p></article>`;
}

export function renderPurchaseCheck(ui, state, helpers) {
  const { esc } = helpers;
  const reports = state.purchaseChecks || [];
  return `<section class="panel purchase-entry" id="purchase-check"><h2>Проверить покупку целиком</h2><p class="panel-subtitle">Ссылка на магазин, получатель и сумма — в одной проверке. Если вы хотите, сотрудник увидит объяснение вместе с результатом проверки сайта.</p>
    <form id="purchase-check-form"><label class="field-label" for="purchase-url">Ссылка на страницу магазина</label><input id="purchase-url" inputmode="url" maxlength="2048" autocomplete="off" spellcheck="false" required value="${esc(ui.purchaseUrl || '')}" placeholder="https://example.com" ${ui.purchaseBusy ? 'disabled' : ''}>
      <div class="purchase-fields"><div><label class="field-label" for="purchase-recipient">Кому переводите</label><select id="purchase-recipient" ${ui.purchaseBusy ? 'disabled' : ''}>${(state.recipients || []).map(r => `<option value="${esc(r.id)}" ${ui.purchaseRecipient === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div><div><label class="field-label" for="purchase-amount">Сумма, ₽</label><input id="purchase-amount" inputmode="decimal" maxlength="20" required value="${esc(ui.purchaseAmount || '')}" ${ui.purchaseBusy ? 'disabled' : ''}></div></div>
      <label class="field-label" for="purchase-explanation">За что платите и кто предложил оплату</label><textarea id="purchase-explanation" rows="3" minlength="5" maxlength="2000" required placeholder="Например: покупаю велосипед, продавец прислал ссылку и реквизиты" ${ui.purchaseBusy ? 'disabled' : ''}>${esc(ui.purchaseExplanation || '')}</textarea>
      <p class="field-help">Не вводите ФИО, контакты, данные карты, пароли или коды. Автоматическое скрытие данных не гарантирует анонимность. Текст сохраняется для сотрудника, но в Qwen автоматически не отправляется.</p>
      <label class="purchase-consent"><input id="purchase-consent" type="checkbox" required ${ui.purchaseConsent ? 'checked' : ''} ${ui.purchaseBusy ? 'disabled' : ''}><span>Разрешаю загрузить публичную страницу и сохранить краткий результат с объяснением. Проверяемый сайт увидит сетевой адрес сканера. Путь ссылки и её параметры не сохраняются.</span></label>
      ${ui.purchaseError ? `<p class="notice error" role="alert">${esc(ui.purchaseError)}</p>` : ''}<button type="submit" class="button full" ${ui.purchaseBusy ? 'disabled' : ''}>${ui.purchaseBusy ? 'Проверяем покупку…' : 'Проверить покупку'}</button></form>
    <p class="aside-note">Ссылку указываете вы: из обычного перевода банк не узнаёт, на каком сайте вы оформили покупку. Проверка одной страницы не подтверждает доставку или подлинность компании.</p></section>
    ${reports.length ? `<section class="panel purchase-results" aria-live="polite"><h2>Ваши проверки покупок</h2>${reports.slice(0, 5).map(r => renderPurchaseReport(r, helpers, { actionable: true, busy: !!ui.purchaseBusy })).join('')}</section>` : ''}`;
}

export function renderPurchaseCase(op, state, helpers) {
  if (!op?.purchaseCheckId) return '';
  const report = (state.purchaseChecks || []).find(r => r.id === op.purchaseCheckId);
  return `<section class="purchase-case"><h4>Связанная проверка покупки</h4>${report ? renderPurchaseReport(report, helpers) : '<p class="notice warning">Сохранённый краткий отчёт недоступен. Нельзя считать сайт безопасным.</p>'}</section>`;
}
