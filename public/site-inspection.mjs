// Presentation only. Network policy, authorization and decisions remain on the server.
export function normalizeClientUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(text)) throw new Error('Вставьте ссылку на сайт без пробелов.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) throw new Error('Нужна обычная ссылка на сайт: http:// или https://.');
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { throw new Error('Не удалось распознать ссылку. Проверьте адрес.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || (!url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.includes(':'))) throw new Error('Укажите адрес сайта без логина и пароля.');
  return url.href;
}

const conciseFinding = f => {
  if (f.code === 'BRAND_CREDENTIALS') return 'Страница представляется известным брендом на другом домене и просит чувствительные данные.';
  if (f.code === 'BRAND_MISMATCH') return 'Связь сайта с указанным брендом не подтверждена.';
  if (f.code.startsWith('FORM_HTTP')) return 'Чувствительные данные могут передаваться без шифрования.';
  if (f.code.startsWith('FORM_EXTERNAL')) return 'Форма заявляет отправку данных на сторонний адрес.';
  if (f.code.startsWith('FORM_GET')) return 'Чувствительные данные могут попасть в адресную строку.';
  if (f.code === 'SAFE_ACCOUNT') return 'На странице упоминается перевод на «безопасный счёт».';
  if (f.code === 'REMOTE_ACCESS') return 'Есть просьба установить удалённый доступ или отключить защиту.';
  if (f.code === 'PERSONAL_TRANSFER') return 'Есть указание на оплату переводом частному лицу.';
  if (f.code === 'URL_MODEL') return 'В адресе ссылки модель заметила подозрительные признаки. Возможна ошибка.';
  return f.message;
};
export function clientOutcome(report) {
  if (report.status !== 'completed') return {
    tone: 'warning', symbol: '?', title: 'Не удалось проверить сайт',
    text: 'Проверка не завершилась. Пока не вводите данные и не оплачивайте покупку по этой ссылке.',
    reasons: [report.error_code === 'non_public_dns' ? 'Не удалось подключиться к сайту. Попробуйте позже или через другое подключение.' : report.error_code === 'challenge' ? 'Сайт закрыл содержимое проверкой от роботов.' : 'Страница недоступна для проверки. Это не означает, что она безопасна.'],
  };
  const reasons = report.findings.filter(f => ['high', 'medium'].includes(f.severity)).toSorted((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1)).map(conciseFinding);
  const unique = [...new Set(reasons)].slice(0, 3);
  if (report.verdict === 'high_risk') return { tone: 'danger', symbol: '!', title: 'Есть признаки обмана', text: 'Не переводите деньги и не вводите пароли или коды по этой ссылке.', reasons: unique };
  if (report.verdict === 'review') return { tone: 'warning', symbol: '!', title: 'Стоит проверить внимательнее', text: 'Не спешите с оплатой. Уточните адрес у продавца или организации через независимый канал.', reasons: unique };
  return { tone: 'neutral', symbol: '✓', title: 'Явных признаков риска не найдено', text: 'В доступной странице мы не заметили явных признаков обмана. Это не гарантия честности продавца.', reasons: [] };
}

export const fieldNames = { password: 'пароль', card: 'номер карты', cvv: 'CVV/CVC', otp: 'код подтверждения' };
export const demoUrls = { brand_clone: 'https://vtb-login.example/confirm', shop_clone: 'https://ozon-sale.example/checkout', ordinary_shop: 'https://www.store.example/', challenge: 'https://protected.example/' };
export function validReport(r) {
  return !!r && ['completed', 'unavailable'].includes(r.status) && ['live', 'demo_fixture'].includes(r.source) && Array.isArray(r.findings) && Array.isArray(r.limitations) && Number.isFinite(r.checked_at) && (r.status === 'unavailable' ? r.verdict === null : ['high_risk', 'review', 'no_signals'].includes(r.verdict));
}
export function renderInspection(r, { esc, date }) {
  if (!r) return '';
  const color = r.verdict === 'high_risk' ? 'red' : r.verdict === 'review' || r.status !== 'completed' ? 'amber' : 'blue';
  const heading = r.status !== 'completed' ? 'Не удалось проверить страницу' : r.verdict === 'high_risk' ? 'Обнаружены серьёзные признаки риска' : r.verdict === 'review' ? 'Есть признаки, требующие внимания' : 'В пределах проверки явные признаки не найдены';
  const facts = r.summary ? `<dl class="scan-facts"><div><dt>Конечный домен</dt><dd>${esc(r.domain)}</dd></div><div><dt>Заголовок HTML</dt><dd>${esc(r.title || 'Не найден')}</dd></div><div><dt>Объём HTML</dt><dd>${Math.ceil(r.summary.html_bytes / 1024)} КБ</dd></div><div><dt>Формы / скрипты / iframe</dt><dd>${r.summary.form_count} / ${r.summary.script_count} / ${r.summary.iframe_count}</dd></div></dl>` : '';
  const findings = r.findings.length ? `<h3>Почему такой результат</h3><ol class="scan-findings">${r.findings.map(f => `<li class="finding-${esc(f.severity)}"><span class="pill ${f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'amber' : 'blue'}">${f.severity === 'high' ? 'Сильный сигнал' : f.severity === 'medium' ? 'Требует внимания' : 'Наблюдение'}</span><p>${esc(f.message)}</p>${f.evidence ? `<code>${esc(f.evidence)}</code>` : ''}</li>`).join('')}</ol>` : '';
  const forms = r.forms?.length ? `<details class="scan-details"><summary>Найденные HTML-формы · ${r.forms.length}</summary>${r.forms.map(f => `<div class="scan-form"><b>Форма ${f.index} · ${esc(f.method)}</b><p>Чувствительные поля: ${f.sensitive_fields.length ? f.sensitive_fields.map(x => esc(fieldNames[x] || x)).join(', ') : 'не обнаружены'}</p><p>Заявленная отправка:</p><code>${esc(f.action)}</code><p>${f.external ? f.unknown_external ? 'Другой домен вне небольшого справочника платёжных сервисов. Это не доказывает мошенничество.' : 'Другой домен совпал со справочником платёжных сервисов. Это не гарантия безопасности.' : 'Домен не отличается от домена страницы.'} ${f.override_count ? `Есть дополнительные адреса кнопок: ${f.override_count}.` : ''}</p></div>`).join('')}<p>Это объявление в HTML, а не наблюдение фактической отправки. Формы не отправлялись.</p></details>` : '';
  const brands = r.brands?.length ? `<details class="scan-details"><summary>Название бренда и домен · ${r.brands.length}</summary>${r.brands.map(b => `<p><b>${esc(b.name)}</b> — ${b.domain_match ? 'совпадение со справочником доменов' : 'домен не совпал с неполным справочником'}. Указанные в справочнике: ${b.official_domains.map(esc).join(', ')}.</p>`).join('')}<p>Логотипы по изображениям не распознаются: проверяются название и текстовая подпись. Независимый продавец не обязан использовать домен производителя.</p></details>` : '';
  const shop = r.shop ? `<details class="scan-details"><summary>Упоминания сведений о магазине</summary><ul>${[['contacts_mentioned', 'Контакты'], ['delivery_mentioned', 'Доставка'], ['returns_mentioned', 'Возврат'], ['company_details_mentioned', 'Реквизиты компании']].map(([key, label]) => `<li>${label}: ${r.shop[key] ? 'упоминание найдено' : 'не найдено в этом HTML'}</li>`).join('')}</ul><p>Наличие текста не подтверждает подлинность реквизитов или доставку товара. Отсутствие не доказывает мошенничество.</p></details>` : '';
  const redirects = r.redirects?.length ? `<details class="scan-details"><summary>HTTP-переходы · ${r.redirects.length - 1}</summary><ol>${r.redirects.map(t => `<li><b>${t.status}</b> <code>${esc(t.url)}</code></li>`).join('')}</ol></details>` : '';
  const retrieval = r.retrieval ? `<p class="notice">${r.retrieval.loader === 'browser_static' ? 'Реальный HTML загружен ограниченным сетевым клиентом и разобран в отдельном Chromium. Страница обрабатывается в offline-контексте, без JavaScript; это не динамическая проверка сайта.' : 'Реальный HTML загружен ограниченным сетевым клиентом.'} DNS: ${r.retrieval.dns === 'cloudflare' ? 'Cloudflare по HTTPS; передаётся только домен' : 'системный'}. Cookies пользователя и банковские данные не отправлялись.</p>` : '';
  return `<section class="panel site-report" aria-live="polite"><div class="section-head"><span class="pill ${color}">Подробная проверка</span><span class="pill ${r.source === 'demo_fixture' ? 'amber' : 'blue'}">${r.source === 'demo_fixture' ? 'ДЕМО · сохранённый HTML, без сети' : r.status === 'completed' ? 'Публичная страница загружена' : 'Сетевая проверка не завершена'}</span></div><h2>${heading}</h2>${r.source === 'demo_fixture' ? '<p class="notice warning">Вымышленный учебный сценарий. Это не результат загрузки сайта банка или магазина. Анализатор выполняется на сохранённом HTML.</p>' : ''}<p class="field-label">Проверенный адрес · параметры запроса скрыты</p><code class="url-checked">${esc(r.input_url)}</code>${r.explanation ? `<p class="notice warning">${esc(r.explanation)} Отсутствие результата не означает безопасность.</p>` : ''}${retrieval}${facts}${findings}${forms}${brands}${shop}${redirects}${r.ml ? `<div class="scan-ml"><b>Отдельный сигнал URL-модели</b><p>${r.ml.label === 'phishing' ? 'Модель предупредила о риске' : 'По строке URL признаки не найдены'} · оценка ${Number(r.ml.phishing_score).toFixed(4)} / 1.</p><p>Это не доказанная вероятность мошенничества. Правила анализа HTML не являются новой обученной моделью.</p></div>` : ''}<h3>Границы проверки</h3><ul class="scan-limitations">${r.limitations.map(x => `<li>${esc(x)}</li>`).join('')}</ul><small class="model-source">${esc(r.version)} · ${esc(date(r.checked_at))} МСК</small></section>`;
}

function outcomeCard(r, { esc, date }, { preview = false, busy = false } = {}) {
  const o = clientOutcome(r);
  return '<section class="panel client-link-result site-report outcome-' + o.tone + '" data-client-result aria-live="polite">' +
    (preview ? '<span class="pill amber">Учебный пример · без сети</span>' : '') +
    '<div class="outcome-heading"><span class="outcome-symbol" aria-hidden="true">' + o.symbol + '</span><h2>' + o.title + '</h2></div>' +
    '<p class="outcome-advice">' + o.text + '</p>' +
    (o.reasons.length ? '<ul class="outcome-reasons">' + o.reasons.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '<p class="outcome-address">Проверяемая ссылка</p><code class="outcome-url">' + esc(r.input_url) + '</code>' +
    (r.status !== 'completed' && !preview ? '<button type="button" class="button secondary small" data-retry-site ' + (busy ? 'disabled' : '') + '>Попробовать ещё раз</button>' : '') +
    '<details class="client-details"><summary>Подробнее о проверке</summary>' + renderInspection(r, { esc, date }) + '</details></section>';
}
export function renderClientResult(report, helpers) {
  return report?.source === 'live' ? outcomeCard(report, helpers) : '';
}
export function renderLinkChecks(ui, { esc, icon, date, inspectorAvailable }) {
  return '<div class="link-client"><div class="link-mode-switch"><button type="button" class="link-button" data-page="jury-demo">Демо для жюри →</button></div>' +
    '<section class="panel link-entry url-check-panel"><div class="link-entry-icon" aria-hidden="true">' + icon('shield') + '</div><h2>Проверьте сайт перед оплатой</h2><p class="link-intro">Пришлите ссылку из сообщения или интернет-магазина.</p>' +
    '<form id="url-check-form"><label class="field-label" for="website-url">Вставьте ссылку</label><input id="website-url" name="url" type="text" inputmode="url" required maxlength="2048" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Например, example.com" value="' + esc(ui.urlDraft) + '" ' + (ui.urlBusy ? 'disabled' : '') + ' aria-describedby="url-help">' +
    '<button type="submit" class="button full" ' + (ui.urlBusy || !inspectorAvailable ? 'disabled' : '') + '>' + icon(ui.urlBusy ? 'clock' : 'shield') + (ui.urlBusy ? 'Проверяем ссылку…' : 'Проверить ссылку') + '</button>' +
    '<p id="url-help" class="link-consent-note">Нажимая «Проверить ссылку», вы разрешаете загрузить публичную страницу. Сайт увидит IP сканера. Для определения адреса домен может передаваться в Cloudflare DNS.</p></form>' +
    (ui.urlBusy ? '<p class="link-progress" role="status">Проверяем адрес и доступную страницу. Обычно это занимает несколько секунд.</p>' : '') +
    (ui.urlError ? '<div class="notice error" role="alert"><b>Проверка не завершена</b><p>' + esc(ui.urlError) + '</p></div>' : '') +
    (!inspectorAvailable ? '<p class="notice warning">Проверка временно недоступна. Попробуйте позже.</p>' : '') +
    '<p class="link-privacy-note">' + icon('lock') + 'Пароли, реквизиты и SMS-коды для проверки не нужны.</p></section>' +
    (ui.urlBusy ? '' : renderClientResult(ui.siteReport, { esc, date })) +
    '<p class="link-disclaimer">Проверка помогает заметить риск, но не гарантирует безопасность покупки.</p></div>';
}
export function renderJuryDemo(ui, { esc, icon, date, inspectorAvailable }) {
  const cases = [
    ['brand_clone', '01', 'Подмена банка', 'Сайт выдаёт себя за банк и просит пароль.', 'Ожидается предупреждение о риске', 'danger'],
    ['shop_clone', '02', 'Поддельный магазин', 'Выдаёт себя за Ozon и просит карту, CVV и SMS-код.', 'Ожидается предупреждение о риске', 'danger'],
    ['ordinary_shop', '03', 'Обычный магазин', 'Каталог и поиск без запроса чувствительных данных.', 'Ожидается отсутствие явных признаков', 'neutral'],
    ['challenge', '04', 'Сайт недоступен', 'Вместо страницы — проверка от роботов.', 'Ожидается «Не удалось проверить»', 'warning'],
  ];
  const selected = cases.find(c => c[0] === ui.juryScenario);
  const report = ui.juryReport?.source === 'demo_fixture' ? ui.juryReport : null;
  return '<div class="jury-view"><div class="jury-toolbar"><button type="button" class="link-button" data-page="url-check">← К проверке ссылки</button><span class="pill amber">Учебный пример · без сети</span></div>' +
    '<section class="panel jury-intro"><h2>Одна проверка. Три понятных результата.</h2><p>Выберите сценарий: анализатор обработает сохранённую учебную страницу и покажет результат, который получил бы клиент.</p><p class="jury-honesty">Без посещения опасных сайтов и без операций со счётом. Это демонстрация, не проверка реального адреса.</p></section>' +
    '<div class="jury-scenarios">' + cases.map(([id, n, title, text, expected, tone]) => '<button type="button" class="jury-case ' + (ui.juryScenario === id ? 'selected' : '') + '" data-page-demo="' + id + '" ' + (ui.juryBusy || !inspectorAvailable ? 'disabled' : '') + (ui.juryScenario === id ? ' aria-pressed="true"' : ' aria-pressed="false"') + '><span class="jury-case-number">' + n + '</span><b>' + title + '</b><span>' + text + '</span><small class="jury-expect-' + tone + '">' + expected + '</small></button>').join('') + '</div>' +
    (!inspectorAvailable ? '<p class="notice warning">Демонстрация недоступна в этом запуске. Перезапустите локальный сервер обновлённой версии.</p>' : '') +
    (ui.juryBusy ? '<section class="panel jury-loading" role="status">' + icon('clock') + 'Разбираем учебную страницу…</section>' : '') +
    (ui.juryError ? '<p class="notice error" role="alert">' + esc(ui.juryError) + '</p>' : '') +
    (!ui.juryBusy && report ? '<section class="jury-preview"><h3>Как результат выглядит для клиента' + (selected ? ' · ' + selected[2] : '') + '</h3>' + outcomeCard(report, { esc, date }, { preview: true }) + '</section>' : '') +
    '<details class="panel jury-diagnostics"><summary>Для команды: проверить только URL-модель</summary><p>Отдельная проверка строки адреса. Страница не загружается; результат не заменяет анализ сайта.</p><form id="jury-url-form"><label class="field-label" for="jury-url">Ссылка для диагностики</label><input id="jury-url" type="text" inputmode="url" maxlength="2048" required value="' + esc(ui.juryUrl || '') + '" placeholder="https://www.wikipedia.org/" ' + (ui.juryModelBusy ? 'disabled' : '') + '><button type="submit" class="button secondary" ' + (ui.juryModelBusy ? 'disabled' : '') + '>' + (ui.juryModelBusy ? 'Проверяем…' : 'Проверить только адрес') + '</button></form>' +
    (ui.juryModelError ? '<p id="jury-model-error" class="dialog-error" role="alert">' + esc(ui.juryModelError) + '</p>' : '') +
    (ui.juryModelResult ? '<div class="jury-model-result" aria-live="polite"><b>' + (ui.juryModelResult.label === 'phishing' ? 'URL-модель дала предупреждение' : 'По строке URL признаки не найдены') + '</b><p>Оценка класса «фишинг»: ' + Number(ui.juryModelResult.phishing_score).toFixed(4) + ' / 1. Это не доказанная вероятность мошенничества.</p><small>' + esc(ui.juryModelResult.model_version) + '</small></div>' : '') +
    '</details></div>';
}
