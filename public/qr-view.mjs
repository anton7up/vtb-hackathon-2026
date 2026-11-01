import { renderQrPaymentEntry } from './qr-payment-view.mjs';

export const QR_DEMOS = {
  normal: { title: 'Обычный учебный QR', note: 'Сервер знает вымышленный платёжный ID: получатель «Мама», 1 000 ₽. Результат зависит от текущих ограничений счёта и реестра.', text: 'https://qr.nspk.ru/DEMO1000000000000000000000000000', file: '/qr-demo-normal.png' },
  shared: { title: 'Жалоба защищает следующего клиента', note: 'Учебный платёж на 3 000 ₽ тому же получателю, что и в истории для жалоб. Решение зависит от текущей отметки сотрудника.', text: 'https://qr.nspk.ru/DEMO2000000000000000000000000000', file: '/qr-demo-shared.png' },
  sbp: { title: 'СБП без суммы', note: 'Есть ссылка и ID, но нет подтверждённых данных продавца.', text: 'https://qr.nspk.ru/DEMO0000000000000000000000000000', file: '/qr-demo-sbp.png' },
  subscription: { title: 'Привязка счёта', note: 'Не путать с разовой покупкой.', text: 'https://sub.nspk.ru/DEMO0000000000000000000000000000', file: '/qr-demo-subscription.png' },
  spoof: { title: 'Подмена адреса', note: 'Название НСПК находится внутри чужого домена.', text: 'https://qr.nspk.ru.pay-check.example/confirm', file: '/qr-demo-spoof.png' },
  mismatch: { title: 'Не та сумма и получатель', note: 'Сравниваем данные квитанции с ожидаемыми.', text: 'ST00012|Name=ООО Учебный получатель|PersonalAcc=40702810000000000000|BankName=Учебный банк|BIC=049999999|CorrespAcc=30101810000000000000|Sum=350000|Purpose=Учебная покупка', expectedAmount: '3000', expectedRecipient: 'Магазин Ромашка', file: '/qr-demo-mismatch.png' },
};

function resultCard(report, text, { esc }, demo = false) {
  if (!report) return '';
  const facts = report.fields || [];
  const mainFacts = facts.filter(f => /^(Получатель|Сумма|Домен|Тип,)/u.test(f.label));
  const extraFacts = facts.filter(f => !mainFacts.includes(f));
  const factsList = list => `<dl class="qr-facts">${list.map(f => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl>`;
  return `<section class="panel client-link-result qr-result outcome-${report.tone === 'danger' ? 'danger' : report.tone === 'warning' ? 'warning' : 'neutral'}" aria-live="polite">
    ${demo ? '<span class="pill amber">ДЕМО · вымышленные платёжные данные</span>' : ''}
    <div class="outcome-heading"><span class="outcome-symbol" aria-hidden="true">${report.tone === 'danger' ? '!' : '?'}</span><h2>${esc(report.title)}</h2></div>
    <p class="outcome-advice">${esc(report.message)}</p>
    ${report.displayUrl ? `<p class="field-label">Адрес из QR · параметры скрыты</p><code class="outcome-url">${esc(report.displayUrl)}</code>` : ''}
    ${mainFacts.length ? factsList(mainFacts) : ''}
    ${extraFacts.length ? `<details class="client-details"><summary>Реквизиты и технические поля</summary>${factsList(extraFacts)}</details>` : ''}
    ${facts.length ? '<p class="qr-note">Эти сведения прочитаны из кода. Банк их не подтверждал.</p>' : ''}
    ${report.warnings?.length ? `<ul class="outcome-reasons">${report.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <p class="notice warning"><b>Получатель не подтверждён банком.</b> Распознанный формат, корректные реквизиты или официальный домен сами по себе не разрешают оплату.</p>
    ${!demo && report.checkUrl ? '<button type="button" class="button secondary" data-qr-link>Перейти к проверке ссылки</button><p class="qr-note">Только заполним адрес в разделе «Ссылки». Загрузка сайта начнётся после отдельного нажатия. Не передавайте ссылки с секретными токенами.</p>' : ''}
    <details class="client-details"><summary>Содержимое QR</summary><p class="qr-note">Может содержать персональные данные. Не публикуйте этот текст.</p><code class="outcome-url">${esc(text)}</code></details>
  </section>`;
}

export function renderQrCheck(ui, helpers) {
  const { esc } = helpers;
  return `<div class="link-client"><div class="link-mode-switch"><button type="button" class="link-button" data-page="qr-demo">Примеры QR для жюри →</button></div>
    <section class="panel link-entry qr-entry"><h2>Проверьте QR перед оплатой</h2><p class="link-intro">Загрузите фото или скриншот одного QR-кода.</p>
    <form id="qr-form"><label class="field-label" for="qr-file">Изображение QR</label><input id="qr-file" type="file" accept="image/png,image/jpeg" ${ui.qrBusy ? 'disabled' : ''} aria-describedby="qr-file-help">
    <p id="qr-file-help" class="qr-note">PNG или JPEG, до 5 МБ. Изображение распознаётся только в этой вкладке. Текст можно передать нашему серверу отдельно — кнопкой проверки получателя.</p>
    ${ui.qrFile && ui.qrMode === 'file' ? `<p class="qr-selected">Выбран файл: ${esc(ui.qrFile.name)}</p>` : ''}
    <details class="qr-options" ${ui.qrMode === 'text' ? 'open' : ''}><summary>У меня уже есть текст из QR</summary><label class="field-label" for="qr-text">Текст или ссылка из QR</label><textarea id="qr-text" rows="3" maxlength="4096" spellcheck="false" ${ui.qrBusy ? 'disabled' : ''}>${esc(ui.qrText)}</textarea></details>
    <details class="qr-options" ${ui.qrExpectedAmount || ui.qrExpectedRecipient ? 'open' : ''}><summary>Сравнить с покупкой · необязательно</summary><label class="field-label" for="qr-expected-amount">Ожидаемая сумма, ₽</label><input id="qr-expected-amount" inputmode="decimal" maxlength="22" value="${esc(ui.qrExpectedAmount)}" ${ui.qrBusy ? 'disabled' : ''}><label class="field-label" for="qr-expected-recipient">Кому собираетесь платить</label><input id="qr-expected-recipient" maxlength="160" value="${esc(ui.qrExpectedRecipient)}" ${ui.qrBusy ? 'disabled' : ''}></details>
    <button type="submit" class="button full" ${ui.qrBusy ? 'disabled' : ''}>${ui.qrBusy ? 'Читаем QR…' : 'Разобрать QR'}</button>
    <p class="link-consent-note">Ничего не оплачиваем, не открываем ссылки и не запускаем банковские приложения. Не используйте QR для входа в банк или выдачи наличных.</p></form>
    ${ui.qrBusy ? '<p role="status" class="link-progress">Распознаём изображение локально. Подождите несколько секунд.</p>' : ''}
    ${ui.qrError ? `<p class="notice error" id="qr-error" role="alert">${esc(ui.qrError)}</p>` : ''}
    ${ui.qrReport || ui.qrFile || ui.qrText ? '<button type="button" class="link-button qr-clear" data-qr-clear>Очистить QR и результат</button>' : ''}</section>
    ${resultCard(ui.qrReport, ui.qrDecoded, helpers)}${ui.qrReport && ui.qrDecoded ? renderQrPaymentEntry(ui.qrDecoded, helpers, { busy: ui.qrPaymentBusy, error: ui.qrPaymentError, role: ui.role, result: ui.qrPayment }) : ''}<p class="link-disclaimer">Проверка QR не подтверждает честность продавца и не снимает ограничения счёта.</p></div>`;
}

export function renderQrDemo(ui, helpers) {
  const { esc } = helpers;
  return `<div class="jury-view"><div class="jury-toolbar"><button type="button" class="link-button" data-page="qr-check">← К проверке своего QR</button><span class="pill amber">ДЕМО · без реальных денег</span></div>
    <section class="panel jury-intro"><h2>Что скрывается в платёжном QR</h2><p>Это вымышленные учебные коды. Разбор текста выполняется локально. По отдельной кнопке наш сервер определяет получателя двух учебных кодов и проверяет свой реестр; банковские API не подключены. Реальные платёжные ссылки не открываются.</p></section>
    <details class="panel qr-jury-walkthrough"><summary>Сценарий для жюри: жалоба одного клиента защищает другого</summary><ol><li>Клиент Анна: в истории открыть выполненный «Тест · Нормальный перевод», сообщить об обмане и передать жалобу.</li><li>Сотрудник: выбрать Анну, рассмотреть жалобу и назначить дополнительную проверку получателя.</li><li>Войти как второй клиент <code>client2</code> и открыть этот экран. Выбрать «Жалоба защищает следующего клиента».</li><li>Проверить получателя в учебном банке, затем проверить перевод. Сервер применит общую отметку: деньги не спишутся, откроется проверка с помощником.</li><li>Сотрудник: выбрать Дмитрия, открыть операцию → «Подробнее». В карточке видны источник QR, основание остановки и общая сводка без чужого текста жалобы.</li></ol><p class="qr-note">Если по получателю уже есть рассмотренная жалоба, повторно создавать её не нужно. Это учебная интеграция, не доступ к настоящим данным СБП. Аккаунты в одном профиле браузера делят cookie: переключайтесь через выход или используйте отдельные профили.</p></details>
    <div class="jury-scenarios">${Object.entries(QR_DEMOS).map(([key, d]) => `<section class="jury-case ${ui.qrDemo === key ? 'selected' : ''}"><b>${esc(d.title)}</b><span>${esc(d.note)}</span><div class="qr-demo-actions"><button type="button" class="button secondary small" data-qr-demo="${key}">Разобрать пример</button><a class="link-button" href="${d.file}" download>Скачать QR · PNG</a></div></section>`).join('')}</div>
    ${ui.qrDemoReport ? `<h3 class="qr-demo-caption">Учебный результат · ${esc(QR_DEMOS[ui.qrDemo]?.title)}</h3>${resultCard(ui.qrDemoReport, QR_DEMOS[ui.qrDemo]?.text, helpers, true)}${renderQrPaymentEntry(QR_DEMOS[ui.qrDemo]?.text, helpers, { busy: ui.qrPaymentBusy, error: ui.qrPaymentError, role: ui.role, result: ui.qrDemoPayment, demo: true })}` : ''}</div>`;
}
