const OFFICIAL_LIST_URL = 'https://www.cbr.ru/inside/warning-list/';

function timestamp(value, esc) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? esc(date.toLocaleString('ru-RU')) : '—';
}

export function renderCbrWarningResult(report, { esc }) {
  if (!report) return '';
  const matched = report.status === 'matched';
  const unavailable = report.status === 'unavailable';
  const title = matched ? 'Домен найден в списке Банка России' : unavailable ? 'Проверку не удалось завершить' : 'Совпадение домена не найдено';
  return `<section class="panel client-link-result outcome-${matched ? 'danger' : 'neutral'}" aria-live="polite"><h3>${title}</h3><code class="outcome-url">${esc(report.domain)}</code><p>${esc(report.message)}</p>
    ${matched ? `<div>${(report.matches || []).map(record => `<article class="notice warning"><b>${esc(record.name)}</b><p>${esc(record.signs || 'Признаки указаны в официальном списке.')}</p><small>Домен: ${esc(record.matchedDomain)} · запись № ${esc(record.id)}${record.listedAt ? ` · внесена ${esc(record.listedAt)}` : ''}${record.updatedAt ? ` · обновлена ${esc(record.updatedAt)}` : ''}</small></article>`).join('')}</div>` : ''}
    ${report.matchCount > (report.matches || []).length ? `<p>Всего совпадений: ${esc(report.matchCount)}. Остальные записи смотрите в официальном источнике.</p>` : ''}
    <p class="qr-note">Проверено: ${timestamp(report.checkedAt, esc)}. ${unavailable && report.dataFetchedAt ? 'Предыдущая копия (не использована для решения): ' : 'Копия списка получена: '}${timestamp(report.dataFetchedAt, esc)}.</p>
    <a class="link-button" href="${OFFICIAL_LIST_URL}" target="_blank" rel="noopener noreferrer">Открыть официальный список Банка России ↗</a>
    <p class="link-disclaimer">Это не закрытая база мошеннических переводов и не подтверждение лицензии. Проверяем только точное совпадение домена, а не все поддомены, страницы соцсетей или название компании. Отсутствие записи не гарантирует безопасность.</p></section>`;
}

export function renderCbrWarningCheck(ui, helpers) {
  const { esc } = helpers;
  return `<section class="panel link-entry" id="investment-check"><h2>Проверка инвестиционного сайта</h2><p class="link-intro">Проверим домен по открытому списку Банка России: финансовые пирамиды и другие признаки нелегальной деятельности.</p>
    <form id="cbr-warning-form"><label class="field-label" for="cbr-warning-url">Домен или ссылка на инвестиционный сайт</label><input id="cbr-warning-url" type="text" inputmode="url" maxlength="4096" autocomplete="off" spellcheck="false" required value="${esc(ui.cbrUrl || '')}" placeholder="example.com" ${ui.cbrBusy ? 'disabled' : ''}>
    <button type="submit" class="button secondary full" ${ui.cbrBusy ? 'disabled' : ''}>${ui.cbrBusy ? 'Проверяем список ЦБ…' : 'Проверить по списку ЦБ'}</button></form>
    <p class="link-consent-note">Указанный сайт не открываем. Ссылка не передаётся в ЦБ или Qwen: сопоставляем домен с копией открытого списка на нашем сервере.</p>
    ${ui.cbrBusy ? '<p role="status">При первой проверке загружаем официальный список. Это может занять до 15 секунд.</p>' : ''}
    ${ui.cbrError ? `<p class="notice error" role="alert">${esc(ui.cbrError)}</p>` : ''}</section>${renderCbrWarningResult(ui.cbrReport, helpers)}`;
}
