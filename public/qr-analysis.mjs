// Offline interpretation only. This module never fetches a URL, confirms a
// recipient, authorizes a payment, or treats an official hostname as proof.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// Reject direction-changing formatting, not ordinary Arabic/Hebrew text.
// It can reorder the visible account/name while leaving different raw data.
const BIDI_FORMAT = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORMAT_CHARACTER = /\p{Cf}/u;
const hasVisibleText = value => typeof value === 'string' && value.replace(/[\s\p{Cf}]/gu, '').length > 0;
const characterCount = value => [...value].length;
const SBP_HOSTS = new Set(['qr.nspk.ru', 'sub.nspk.ru']);
const LEGACY_KEYS = new Set(['type', 'bank', 'sum', 'cur', 'crc']);
const RECEIPT_KEYS = ['t', 's', 'fn', 'i', 'fp', 'n'];
const GOST_LABELS = new Map([
  ['name', 'Получатель, указанный в коде'], ['personalacc', 'Счёт, указанный в коде'],
  ['bankname', 'Банк, указанный в коде'], ['bic', 'БИК'],
  ['correspacc', 'Корреспондентский счёт'], ['payeeinn', 'ИНН, указанный в коде'],
  ['kpp', 'КПП'], ['sum', 'Сумма, указанная в коде'], ['purpose', 'Назначение платежа'],
]);

function report(kind, title, message, { tone = 'warning', fields = [], warnings = [], checkUrl = null, displayUrl = null } = {}) {
  return { kind, title, tone, message, fields, warnings, checkUrl, displayUrl, recipientVerified: false, amountVerified: false };
}
function unsupported(message = 'Не удалось распознать формат. Не оплачивайте по этому коду без проверки в приложении банка.', options) {
  return report('unsupported', 'Нужна дополнительная проверка', message, options);
}
const field = (label, value) => ({ label, value: String(value), confirmed: false });
const money = cents => `${cents / 100n},${String(cents % 100n).padStart(2, '0')} ₽`;
function kopecks(value, maximumDigits) {
  if (!new RegExp(`^[0-9]{1,${maximumDigits}}$`).test(value)) return null;
  const result = BigInt(value);
  return result > 0n ? result : null;
}
function expectedKopecks(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const text = value.trim();
  if (!/^(?:[0-9]{1,18}|[0-9]{1,3}(?:[ \u00a0\u202f][0-9]{3}){1,5})(?:[.,][0-9]{1,2})?$/.test(text)) return null;
  const [rubles, fraction = ''] = text.replace(/[ \u00a0\u202f]/g, '').split(/[.,]/);
  const cents = BigInt(rubles) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents > 0n ? cents : null;
}
const normalizedName = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
function compareExpected(result, amount, name, options) {
  let mismatch = false;
  if (options.expectedAmount !== '' && options.expectedAmount != null) {
    const expected = expectedKopecks(options.expectedAmount);
    if (expected === null) result.warnings.push('Ожидаемая сумма не распознана: укажите положительную сумму в рублях, не более двух знаков после запятой.');
    else if (amount === null) result.warnings.push('В самом коде нет подтверждаемой суммы для сравнения. Проверьте её в банковском приложении.');
    else if (amount !== expected) { mismatch = true; result.warnings.push(`Сумма в коде (${money(amount)}) не совпадает с ожидаемой (${money(expected)}).`); }
    else result.warnings.push('Суммы в коде и вашем вводе совпадают. Это не подтверждает актуальную сумму у банка.');
  }
  if (options.expectedRecipient !== '' && options.expectedRecipient != null) {
    if (typeof options.expectedRecipient !== 'string' || options.expectedRecipient.length > 300 || CONTROL.test(options.expectedRecipient) || BIDI_FORMAT.test(options.expectedRecipient) || !hasVisibleText(options.expectedRecipient)) result.warnings.push('Ожидаемое имя получателя не распознано.');
    else if (!name) result.warnings.push('Из этого кода нельзя подтвердить имя получателя. Сверьте его в приложении банка.');
    else if (normalizedName(name) !== normalizedName(options.expectedRecipient)) { mismatch = true; result.warnings.push('Название получателя в коде не совпадает с ожидаемым. Различие требует ручной проверки, но само по себе не доказывает мошенничество.'); }
    else result.warnings.push('Название совпало только как текст. Принадлежность счёта этому получателю не проверена.');
  }
  if (mismatch) { result.tone = 'danger'; result.message = 'Есть несоответствие вашим ожиданиям. Не продолжайте оплату, пока не проверите сумму и получателя независимо.'; }
  return result;
}
function wellFormed(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function strippedUrl(url) { return `${url.origin}${url.pathname}`; }
function internalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|invalid|test|example|onion)$/.test(host) || host.endsWith('.home.arpa')) return true;
  // No URL actions for IPv6 literals in this lightweight offline module. The
  // server independently validates every address if it receives any URL.
  if (host.includes(':')) return true;
  if (/^[0-9.]+$/.test(host)) {
    const p = host.split('.').map(Number);
    if (p.length !== 4 || p.some(n => n > 255)) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && (p[1] === 168 || (p[1] === 0 && [0, 2].includes(p[2])) || (p[1] === 88 && p[2] === 99))) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19 || (p[1] === 51 && p[2] === 100))) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  return false;
}
function parseReceipt(params, displayUrl = null) {
  if (!RECEIPT_KEYS.every(key => params.has(key))) return null;
  if (RECEIPT_KEYS.some(key => params.getAll(key).length !== 1)) return unsupported('В данных чека есть повторяющиеся поля. Проверка не выполнена.', { displayUrl });
  if (!/^[0-9]{8}T[0-9]{4}(?:[0-9]{2})?$/.test(params.get('t')) || !/^[0-9]{1,18}(?:\.[0-9]{1,2})?$/.test(params.get('s')) || !/^[0-9]{16}$/.test(params.get('fn')) || !/^[0-9]{1,10}$/.test(params.get('i')) || !/^[0-9]{1,10}$/.test(params.get('fp')) || !/^[1-4]$/.test(params.get('n'))) return unsupported('Строка похожа на фискальный чек, но её формат не распознан.', { displayUrl });
  return report('receipt', 'Это данные фискального чека, не команда оплаты', 'Код содержит данные для проверки чека. Он не подтверждает честность продавца или факт доставки товара.', {
    tone: 'neutral', displayUrl,
    fields: [field('Дата и время, указанные в чеке', params.get('t')), field('Сумма чека, ₽', params.get('s')), field('Фискальный накопитель', params.get('fn')), field('Номер фискального документа', params.get('i')), field('Фискальный признак', params.get('fp')), field('Признак расчёта', params.get('n'))],
    warnings: ['Подлинность чека в ФНС не проверялась. Переходы и платежи не выполнялись.'],
  });
}
function parseSbp(url, options) {
  const displayUrl = strippedUrl(url);
  if (url.protocol !== 'https:' || url.port || !/^\/[a-z0-9]{32}$/i.test(url.pathname) || url.hash) return unsupported('Адрес похож на СБП, но не соответствует поддерживаемому формату. Не открывайте его автоматически.', { displayUrl });
  const values = new Map(); let additional = false;
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (!LEGACY_KEYS.has(lower)) { additional = true; continue; }
    if (key !== lower || values.has(lower)) return unsupported('В платёжной ссылке повторяются или неоднозначно записаны параметры. Значения не выбраны автоматически.', { displayUrl });
    values.set(lower, value);
  }
  const type = values.get('type');
  if ((type !== undefined && !['01', '02', '03'].includes(type)) || (values.has('bank') && !/^[0-9]{12}$/.test(values.get('bank'))) || (values.has('cur') && values.get('cur') !== 'RUB') || (values.has('crc') && !/^[a-f0-9]{4}$/i.test(values.get('crc')))) return unsupported('Параметры платёжной ссылки не соответствуют поддерживаемому формату.', { displayUrl });
  const amount = values.has('sum') ? kopecks(values.get('sum'), 12) : null;
  if ((values.has('sum') && amount === null) || values.has('sum') !== values.has('cur')) return unsupported('Сумма или валюта в ссылке записаны некорректно. Оплата не разрешается автоматически.', { displayUrl });
  const subscription = url.hostname === 'sub.nspk.ru' || type === '03';
  const result = report(subscription ? 'subscription' : 'sbp', subscription ? 'Возможна привязка счёта' : 'Распознана ссылка формата СБП', subscription ? 'Ссылка может оформлять привязку счёта для последующих списаний, а не только разовую оплату. Проверьте условия в банковском приложении.' : 'Распознан формат ссылки, но существование платёжного идентификатора, получатель и текущая сумма не проверены.', {
    displayUrl,
    fields: [field('Домен платёжной ссылки', url.hostname), field('Идентификатор из кода', url.pathname.slice(1))],
    warnings: ['Официальный домен платёжного посредника не подтверждает, что код принадлежит нужному магазину.', 'Данные у НСПК или банка не запрашивались. Автоматический переход и платёж не выполнялись.'],
  });
  if (type) result.fields.push(field('Тип, указанный в ссылке', { '01': 'Статический QR (01)', '02': 'Динамический QR (02)', '03': 'Привязка счёта (03)' }[type]));
  if (values.has('bank')) result.fields.push(field('Идентификатор банка, не получателя', values.get('bank')));
  if (amount !== null) result.fields.push(field('Сумма в старом параметре ссылки', money(amount)));
  else result.warnings.push('Сумма в самом коде не указана. Для современной ссылки это нормально; узнайте её в приложении банка.');
  if (values.has('crc')) result.warnings.push('В ссылке есть контрольная сумма CRC. Её значение не подтверждает честность получателя; CRC здесь не проверялась.');
  if (additional) result.warnings.push('В ссылке присутствуют дополнительные параметры; их назначение не подтверждено.');
  if (subscription && (values.has('sum') || (type && type !== '03'))) { result.tone = 'danger'; result.warnings.push('Параметры оплаты противоречат признакам привязки счёта. Нужна ручная проверка.'); }
  return compareExpected(result, amount, null, options);
}
function parseRequisites(text, options) {
  const parts = text.split('|');
  if (!/^ST0001[123]$/.test(parts.shift()) || parts.length > 64) return unsupported('Формат платёжных реквизитов не распознан.');
  const values = new Map(); let unknown = false;
  for (const part of parts) {
    const split = part.indexOf('=');
    if (split < 1) return unsupported('В реквизитах есть поле без имени или значения.');
    const key = part.slice(0, split).toLowerCase(), value = part.slice(split + 1);
    if (!/^[a-z][a-z0-9]*$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || values.has(key)) return unsupported('Реквизиты содержат повторяющиеся или недопустимые поля.');
    values.set(key, value);
    if (!GOST_LABELS.has(key)) unknown = true;
  }
  // GOST R 56042-2014, Appendix В: Name 160, BankName 45, Purpose 210
  // characters. Preserve values as data; do not silently truncate names.
  if (['name', 'personalacc', 'bankname', 'bic', 'correspacc'].some(key => !hasVisibleText(values.get(key))) || characterCount(values.get('name')) > 160 || characterCount(values.get('bankname')) > 45 || (values.has('purpose') && characterCount(values.get('purpose')) > 210) || !/^[0-9]{20}$/.test(values.get('personalacc')) || !/^[0-9]{9}$/.test(values.get('bic')) || !/^[0-9]{1,20}$/.test(values.get('correspacc')) || (values.has('payeeinn') && !/^(?:[0-9]{10}|[0-9]{12})$/.test(values.get('payeeinn'))) || (values.has('kpp') && !/^[0-9]{9}$/.test(values.get('kpp')))) return unsupported('Не хватает обязательных реквизитов, превышена длина поля или его структура некорректна.');
  const amount = values.has('sum') ? kopecks(values.get('sum'), 18) : null;
  if (values.has('sum') && amount === null) return unsupported('Сумма в платёжных реквизитах некорректна.');
  const result = report('requisites', 'В коде записаны платёжные реквизиты', 'Показаны только сведения из самого кода. Имя получателя можно подменить: принадлежность счёта и подлинность реквизитов не подтверждены.', {
    fields: [...GOST_LABELS].filter(([key]) => values.has(key)).map(([key, label]) => field(label, key === 'sum' ? money(amount) : values.get(key))),
    warnings: ['Проверена только структура полей. Контрольные разряды ИНН и счетов, достоверность БИК, а также сведения в банковских и государственных базах не проверялись.', 'Платёж не создавался и не отправлялся.'],
  });
  if (unknown) result.warnings.push('Дополнительные поля кода не интерпретировались.');
  if ([...values.values()].some(value => FORMAT_CHARACTER.test(value))) result.warnings.push('В тексте есть невидимые форматирующие символы. Они сохранены без изменений; сравните реквизиты в приложении банка, а не только отображаемое название.');
  if (amount === null) result.warnings.push('Сумма в коде не указана.');
  return compareExpected(result, amount, values.get('name'), options);
}

export function analyzeQr(input, suppliedOptions = {}) {
  try {
    const { expectedAmount = '', expectedRecipient = '' } = suppliedOptions ?? {};
    if (typeof input !== 'string' || input.length > 4096) return unsupported('Код пустой, слишком длинный или имеет неподдерживаемый формат.');
    const text = input.trim(), options = { expectedAmount, expectedRecipient };
    if (!text || CONTROL.test(text) || !wellFormed(text)) return unsupported('Код содержит пустые или недопустимые данные.');
    if (BIDI_FORMAT.test(text)) return unsupported('Код содержит символы изменения направления текста, которые могут искажать отображение реквизитов. Нужна ручная проверка без автоматического перехода.');
    if (/^ST/i.test(text)) return parseRequisites(text, options);
    if (!/^https?:\/\//i.test(text)) return parseReceipt(new URLSearchParams(text)) || unsupported();
    if (text.length > 2048 || /\s|\\/u.test(text)) return unsupported('Адрес в коде слишком длинный или неоднозначный.');
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return unsupported('Адрес содержит недопустимый протокол или встроенные учётные данные.');
    const displayUrl = strippedUrl(url);
    if (SBP_HOSTS.has(url.hostname)) return parseSbp(url, options);
    if (url.hostname === 'nspk.ru' || url.hostname.endsWith('.nspk.ru') || url.hostname.replace(/\.$/, '') === 'nspk.ru' || url.hostname.replace(/\.$/, '').endsWith('.nspk.ru')) return unsupported('Это адрес в доменной зоне НСПК, но данный платёжный формат не поддерживается. Получатель и сумма не подтверждены.', { displayUrl });
    const receipt = parseReceipt(url.searchParams, displayUrl);
    if (receipt) return receipt;
    const internal = internalHostname(url.hostname);
    const looksLikeNspk = /nspk|нспк/i.test(url.hostname);
    const result = report('url', 'В QR находится ссылка', 'Код содержит адрес сайта, а не подтверждённые платёжные реквизиты. При желании отдельно проверьте адрес на признаки фишинга.', {
      tone: looksLikeNspk ? 'danger' : 'neutral', displayUrl, checkUrl: internal ? null : url.href,
      fields: [field('Домен ссылки', url.hostname)],
      warnings: ['Сам QR не подтверждает безопасность сайта, честность продавца, получателя или сумму платежа.'],
    });
    if (looksLikeNspk) result.warnings.push('В имени есть «nspk», но это не поддерживаемый официальный домен платёжной ссылки НСПК. Возможна имитация адреса.');
    if (internal) result.warnings.push('Локальные, служебные, тестовые адреса и IP-литералы IPv6 не отправляются на проверку. Сервер также должен независимо защищаться от SSRF и подмены DNS.');
    return result;
  } catch { return unsupported('Не удалось корректно разобрать код. Проверка не является разрешением на оплату.'); }
}
