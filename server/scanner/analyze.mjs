import { parse } from 'parse5';
import { getDomain } from 'tldts';
import { domainToUnicode } from 'node:url';
import brandList from './brands.json' with { type: 'json' };
import { checkPhishingUrl } from '../../lib/url-phishing-model.mjs';
import { displayAddress, ScanError } from './policy.mjs';

const trim = (text, max = 220) => String(text || '').replace(/\s+/gu, ' ').trim().slice(0, max);
const attrs = node => Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
const ignoredTags = new Set(['script', 'style', 'template', 'noscript', 'svg']);
const hidden = node => 'hidden' in attrs(node) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs(node).style || '');
const kindNames = { password: 'пароль', card: 'номер карты', cvv: 'CVV/CVC', otp: 'код подтверждения' };
const describeKinds = kinds => [...kinds].map(k => kindNames[k] || k).join(', ');
function textOf(root, max = 12000) {
  const stack = [root], parts = []; let size = 0;
  while (stack.length && size < max) {
    const node = stack.pop();
    if (node.nodeName === '#text') { const text = node.value.slice(0, max - size); parts.push(text); size += text.length; }
    else if (!ignoredTags.has(node.tagName) && !hidden(node)) stack.push(...(node.childNodes || []).toReversed());
  }
  return trim(parts.join(' '), max);
}
const domainOf = value => { try { const h = new URL(value).hostname; return getDomain(h, { allowPrivateDomains: true }) || h; } catch { return null; } };
const knownDomain = (hostname, domains) => domains.some(d => hostname === d || hostname.endsWith(`.${d}`));
const containsWord = (text, word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
function destination(raw, base) {
  try { const u = new URL(raw, base); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u : null; }
  catch { return null; }
}
function fieldKinds(node, labels) {
  const a = attrs(node);
  if ('disabled' in a || a.type === 'hidden' || ['submit', 'button', 'reset'].includes(a.type)) return [];
  const hint = `${a.type || ''} ${a.name || ''} ${a.id || ''} ${a.autocomplete || ''} ${a.placeholder || ''} ${a['aria-label'] || ''} ${labels.get(a.id) || ''} ${node.parentNode?.tagName === 'label' ? textOf(node.parentNode, 160) : ''}`;
  const kinds = [];
  if (/password|парол[ья]/i.test(hint)) kinds.push('password');
  if (/cc-number|card.?number|cardnumber|номер\s*карт|\bpan\b/i.test(hint)) kinds.push('card');
  if (/cc-csc|\bcvv\b|\bcvc\b|security.?code|код.{0,8}обратн/i.test(hint)) kinds.push('cvv');
  if (/one-time-code|sms.?code|otp|код.{0,12}(sms|смс)|код\s+подтвержд/i.test(hint)) kinds.push('otp');
  return kinds;
}
const LIMITATIONS = [
  'Проверена одна загруженная страница и HTTP-перенаправления, не весь сайт.',
  'JavaScript не выполнялся. Фактическая отправка данных, переходы из JS и содержимое iframe не проверены; формы не отправлялись.',
  'Возраст домена, внешние базы угроз, подлинность компании, доставка товара и визуальное сходство логотипов не проверялись.',
  'Справочник брендов и платёжных доменов неполный. Результат не разрешает перевод и не снимает ограничения счёта.',
];
export function unavailableReport(input, code, source = 'live') {
  const reasons = {
    blocked_target: 'Этот адрес запрещён для сетевой проверки: локальная/служебная сеть, неподдерживаемый порт или специальный домен.',
    non_public_dns: 'DNS вернул непубличный адрес. Такое возможно при VPN/прокси с Fake-IP. Сетевая проверка остановлена; это не означает, что сайт мошеннический.',
    timeout: 'Сайт не ответил за отведённое время.', dns_failed: 'Не удалось определить публичный сетевой адрес сайта.',
    browser_unavailable: 'Браузерный обработчик не запустился. Установите Chrome/Edge/Chromium или настройте статический режим сервера.',
    browser_failed: 'Браузерный обработчик не завершил разбор HTML. Проверка не выполнена.',
    access_restricted: 'Сайт ограничил доступ сканеру (HTTP 403/429).', http_error: 'Сайт вернул ошибку HTTP.',
    not_html: 'Адрес вернул не HTML-страницу.', too_large: 'Размер страницы превышает лимит проверки.',
    tls_error: 'Не удалось установить соединение с проверенным TLS-сертификатом.', unsupported_encoding: 'Сайт вернул неподдерживаемую кодировку или сжатие.',
    redirect_loop: 'Обнаружен цикл перенаправлений.', too_many_redirects: 'Слишком много перенаправлений.',
    challenge: 'Вместо содержимого получена CAPTCHA или страница защиты от роботов.', dynamic_page: 'Страница требует выполнения JavaScript; доступного HTML недостаточно.',
  };
  return { version: 'static-scan-v1', source, status: 'unavailable', verdict: null, checked_at: Date.now(), input_url: displayAddress(input), error_code: code, explanation: reasons[code] || 'Проверка страницы не завершена. Это не означает, что сайт безопасен.', findings: [], limitations: ['Анализ содержимого не завершён. Положительного заключения о сайте нет.', ...LIMITATIONS.slice(1)] };
}
export function analyzePage({ inputUrl, finalUrl, html, trace = [], bytes = Buffer.byteLength(html), source = 'live' }) {
  const doc = parse(html), nodes = [], stack = [doc];
  while (stack.length) {
    const node = stack.pop(); nodes.push(node);
    if (nodes.length > 30000) throw new ScanError('too_large');
    if (!ignoredTags.has(node.tagName) && !hidden(node)) stack.push(...(node.childNodes || []).toReversed());
  }
  const titleNode = nodes.find(n => n.tagName === 'title');
  const title = titleNode ? textOf(titleNode, 180) : '';
  const body = nodes.find(n => n.tagName === 'body') || doc;
  const text = textOf(body, 60000);
  if (/just a moment|attention required|checking your browser|проверка браузера/i.test(title) || (text.length < 700 && /verify (you are|that you are) human|checking your browser|captcha challenge|подтвердите.{0,20}не робот/i.test(text))) return unavailableReport(inputUrl, 'challenge', source);
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  if (text.length < 50 && scriptCount && !nodes.some(n => n.tagName === 'form')) return unavailableReport(inputUrl, 'dynamic_page', source);
  if (!text && !title) return unavailableReport(inputUrl, 'dynamic_page', source);

  const final = new URL(finalUrl), findings = [];
  const add = (code, severity, message, evidence) => { if (findings.length < 30) findings.push({ code, severity, message, evidence: trim(evidence) }); };
  const baseRaw = nodes.find(n => n.tagName === 'base' && attrs(n).href)?.attrs.find(a => a.name === 'href')?.value;
  const base = destination(baseRaw || finalUrl, finalUrl)?.href || finalUrl;
  const labels = new Map(nodes.filter(n => n.tagName === 'label' && attrs(n).for).map(n => [attrs(n).for, textOf(n, 180)]));
  const formNodes = nodes.filter(n => n.tagName === 'form');
  const formById = new Map(formNodes.filter(n => attrs(n).id).map(n => [attrs(n).id, n]));
  const fieldsByForm = new Map(formNodes.map(n => [n, []]));
  const ownerForm = node => {
    const a = attrs(node); if ('form' in a) return formById.get(a.form);
    let parent = node.parentNode;
    while (parent && parent.tagName !== 'form') parent = parent.parentNode;
    return parent;
  };
  const sensitive = new Set();
  for (const node of nodes.filter(n => ['input', 'textarea', 'select'].includes(n.tagName))) {
    const kinds = fieldKinds(node, labels); kinds.forEach(k => sensitive.add(k));
    const parent = ownerForm(node);
    if (fieldsByForm.has(parent)) fieldsByForm.get(parent).push(...kinds);
  }
  const forms = formNodes.slice(0, 12).map((node, index) => {
    const a = attrs(node), kinds = [...new Set(fieldsByForm.get(node))];
    const action = destination(a.action || finalUrl, base);
    const method = (a.method || 'get').toLowerCase();
    const overrides = nodes.filter(n => ['button', 'input'].includes(n.tagName) && ownerForm(n) === node && !('disabled' in attrs(n)));
    const declaredTargets = [...new Set(overrides.filter(n => attrs(n).formaction).map(n => attrs(n).formaction))];
    const targets = [action, ...declaredTargets.map(raw => destination(raw, base))];
    const external = targets.some(u => u && domainOf(u.href) !== domainOf(finalUrl));
    const unknownExternal = targets.some(u => u && domainOf(u.href) !== domainOf(finalUrl) && !knownDomain(u.hostname, brandList.paymentDomains));
    const insecure = targets.some(u => u?.protocol === 'http:');
    if (kinds.length && (final.protocol === 'http:' || insecure)) add(`FORM_HTTP_${index}`, 'high', 'Чувствительные данные запрашиваются на странице или отправляются по незащищённому HTTP.', `Форма ${index + 1}; поля: ${describeKinds(kinds)}; адрес: ${action ? displayAddress(action.href) : 'не распознан'}`);
    if (kinds.length && (method === 'get' || overrides.some(n => /^get$/i.test(attrs(n).formmethod || '')))) add(`FORM_GET_${index}`, 'medium', 'Форма или её кнопка с чувствительными полями объявляет GET: данные могут попасть в URL.', `Форма ${index + 1}; метод GET`);
    if (kinds.length && unknownExternal) add(`FORM_EXTERNAL_${index}`, 'medium', 'Заявленный адрес отправки чувствительных полей находится на другом домене вне небольшого справочника платёжных сервисов.', `Форма ${index + 1}; ${targets.filter(Boolean).map(u => displayAddress(u.href)).join('; ')}`);
    if (kinds.length && targets.some(u => !u)) add(`FORM_TARGET_${index}`, 'medium', 'Не удалось определить безопасный HTTP(S)-адрес отправки формы.', `Форма ${index + 1}; поведение JavaScript не проверено`);
    return { index: index + 1, method: method.toUpperCase(), sensitive_fields: kinds, action: action ? displayAddress(action.href) : 'Не определён', external, unknown_external: unknownExternal, insecure, override_count: declaredTargets.length };
  });
  if (sensitive.size) add('SENSITIVE_FIELDS', 'info', 'В HTML найдены поля для чувствительных данных. Само наличие формы не доказывает фишинг.', describeKinds(sensitive));
  const identity = [title, ...nodes.filter(n => n.tagName === 'h1').slice(0, 3).map(n => textOf(n, 200)), ...nodes.filter(n => n.tagName === 'meta' && attrs(n).property === 'og:site_name').map(n => attrs(n).content), ...nodes.filter(n => n.tagName === 'img').slice(0, 4).map(n => attrs(n).alt || '')].join(' ');
  const officialClaim = /официальн.{0,25}(сайт|магазин|кабинет)|official.{0,20}(store|site|website)/iu.test(identity);
  const brands = brandList.brands.filter(b => b.aliases.some(alias => containsWord(identity, alias))).map(b => ({ name: b.name, domain_match: knownDomain(final.hostname, b.domains), official_domains: b.domains, source: b.source }));
  for (const brand of brands) {
    if (!brand.domain_match) {
      add('BRAND_MISMATCH', 'medium', `Название или подпись логотипа указывает на ${brand.name}, но домен не совпадает со справочником. Это может быть и независимый продавец.`, `${brand.name}; домен: ${final.hostname}; ${officialClaim ? 'есть заявление об официальности' : 'принадлежность не подтверждена'}`);
      if ((['ВТБ', 'Сбер'].includes(brand.name) && sensitive.has('password')) || (officialClaim && sensitive.size && forms.some(f => f.unknown_external))) add('BRAND_CREDENTIALS', 'high', 'Совокупность признаков подмены: известный бренд на другом домене и запрос/отправка чувствительных данных.', `${brand.name}; поля: ${describeKinds(sensitive)}`);
    }
  }
  const scenarios = [
    ['SAFE_ACCOUNT', /безопасн[а-яё]*\s+сч[её]т[а-яё]*/iu, 'Найдена формулировка «безопасный счёт». Проверьте контекст: страница может быть и предупреждением о мошенниках.'],
    ['REMOTE_ACCESS', /установите.{0,45}(anydesk|rustdesk|teamviewer)|отключите.{0,25}(антивирус|защиту)/iu, 'Найдены требования установить удалённый доступ или отключить защиту.'],
    ['PERSONAL_TRANSFER', /перев[ео]д.{0,35}(личную карт|физическ.{0,8}лиц|частн.{0,8}лиц)/iu, 'Найдены указания на оплату переводом частному лицу.'],
  ];
  for (const [code, regex, message] of scenarios) { const match = text.match(regex); if (match) add(code, 'medium', message, match[0]); }
  const domains = [...new Set(trace.map(t => domainOf(t.url)).filter(Boolean))];
  if (domains.length > 1) add('REDIRECT_DOMAIN', 'info', 'HTTP-перенаправление изменило домен. Это бывает легально; проверьте конечный адрес.', domains.join(' → '));
  if (trace.some((t, i) => i && trace[i - 1].url.startsWith('https:') && t.url.startsWith('http:'))) add('HTTPS_DOWNGRADE', 'medium', 'При перенаправлении защищённое HTTPS-соединение сменилось на HTTP.', final.origin);
  if (/xn--/i.test(final.hostname)) add('IDN', 'info', 'Домен содержит международные символы. Проверьте написание; это само по себе не признак мошенничества.', domainToUnicode(final.hostname));
  const metaRefresh = nodes.find(n => n.tagName === 'meta' && /^refresh$/i.test(attrs(n)['http-equiv'] || ''));
  if (metaRefresh) add('META_REFRESH', 'medium', 'В HTML объявлено автоматическое перенаправление meta refresh; оно не выполнялось.', 'Конечная страница такого перехода не проверена');
  const frames = nodes.filter(n => n.tagName === 'iframe').length;
  const scriptOnly = nodes.filter(n => n.tagName === 'input' && attrs(n).type === 'password').length && !forms.length;
  if (scriptOnly) add('JS_FORM', 'medium', 'Есть поле пароля без обычной HTML-формы. Направление отправки из JavaScript неизвестно.', 'Чужой JavaScript не выполнялся');
  const ml = checkPhishingUrl(inputUrl);
  if (ml.label === 'phishing') add('URL_MODEL', 'medium', 'URL-модель дала предупреждение. У этой модели бывают ложные срабатывания; это не доказательство.', `Оценка ${ml.phishing_score.toFixed(4)}, ${ml.model_version}`);
  const verdict = findings.some(f => f.severity === 'high') ? 'high_risk' : findings.some(f => f.severity === 'medium') ? 'review' : 'no_signals';
  return { version: 'static-scan-v1', source, status: 'completed', verdict, checked_at: Date.now(), input_url: displayAddress(inputUrl), final_url: displayAddress(finalUrl), domain: final.hostname, title,
    findings, forms, brands, ml, redirects: trace, summary: { html_bytes: bytes, form_count: formNodes.length, script_count: scriptCount, iframe_count: frames, page_count: 1 },
    shop: { contacts_mentioned: /контакт|contacts?|mailto:|телефон/iu.test(text + html.slice(0, 10000)), delivery_mentioned: /доставк|delivery|shipping/iu.test(text), returns_mentioned: /возврат|refund|returns/iu.test(text), company_details_mentioned: /\bинн\b|\bогрн\b|company\s+(number|registration)/iu.test(text) },
    limitations: LIMITATIONS, brand_registry_version: brandList.version };
}
