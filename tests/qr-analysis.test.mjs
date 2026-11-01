import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQr } from '../public/qr-analysis.mjs';

const id = 'AS10003P3RH0LJ2A9ROO038L6NT5RU1M';
const sbp = `https://qr.nspk.ru/${id}`;
const requisites = 'ST00012|Name=ООО Ромашка|PersonalAcc=40702810100010000001|BankName=Банк|BIC=044525225|CorrespAcc=30101810400000000225';
function unverified(result) {
  assert.equal(result.recipientVerified, false); assert.equal(result.amountVerified, false);
  assert.ok(result.fields.every(item => item.confirmed === false && typeof item.value === 'string'));
  assert.ok(!('allowed' in result)); assert.ok(!('safe' in result));
}

test('modern SBP URL keeps opaque ID opaque and never supplies a URL action', () => {
  const result = analyzeQr(sbp);
  assert.equal(result.kind, 'sbp'); assert.equal(result.checkUrl, null);
  assert.equal(result.displayUrl, sbp); assert.ok(result.warnings.some(s => /Сумма.*не указана/.test(s)));
  assert.ok(!result.fields.some(item => /Тип|Сумма/.test(item.label))); unverified(result);
});
test('legacy SBP amount is kopecks; bank ID is not recipient; comparisons do not verify identity', () => {
  const result = analyzeQr(`${sbp}?type=02&bank=100000000001&sum=100050&cur=RUB&crc=C08B`, { expectedAmount: '1 000,50', expectedRecipient: 'Магазин' });
  assert.equal(result.kind, 'sbp'); assert.equal(result.tone, 'warning');
  assert.ok(result.fields.some(item => item.value === '1000,50 ₽'));
  assert.ok(result.fields.some(item => /не получателя/.test(item.label)));
  assert.ok(result.warnings.some(s => /нельзя подтвердить имя/.test(s))); unverified(result);
});
test('subscription domain and explicit type 03 warn about account binding', () => {
  for (const url of [`https://sub.nspk.ru/${id}`, `${sbp}?type=03`]) {
    const result = analyzeQr(url); assert.equal(result.kind, 'subscription');
    assert.match(result.message, /привязку счёта/); assert.equal(result.checkUrl, null); unverified(result);
  }
  assert.equal(analyzeQr(`https://sub.nspk.ru/${id}?type=02&sum=500&cur=RUB`).tone, 'danger');
});
test('malformed SBP variants, duplicate fields, unsafe credentials and protocols never offer actions', () => {
  for (const url of [
    `${sbp}?sum=1&sum=1&cur=RUB`, `${sbp}?type=01&type=02`, `${sbp}?SUM=1&cur=RUB`,
    `${sbp}?sum=0&cur=RUB`, `${sbp}?sum=-1&cur=RUB`, `${sbp}?sum=1000000000000&cur=RUB`,
    `${sbp}?sum=100`, `${sbp}?cur=RUB`, `${sbp}?sum=100&cur=USD`, `${sbp}?bank=123`,
    `${sbp}?type=04`, `${sbp}?crc=notcrc`, `${sbp}#change`, `${sbp}/`,
    sbp.replace('https:', 'http:'), sbp.replace('nspk.ru/', 'nspk.ru:444/'),
    sbp.replace('https://', 'https://user:pass@'), 'javascript:alert(1)',
  ]) { const result = analyzeQr(url); assert.equal(result.kind, 'unsupported', url); assert.equal(result.checkUrl, null); unverified(result); }
});
test('NSPK lookalikes are ordinary suspicious URLs, not verified SBP links', () => {
  const result = analyzeQr(`https://qr.nspk.ru.evil.org/${id}?token=private#fragment`);
  assert.equal(result.kind, 'url'); assert.equal(result.tone, 'danger');
  assert.equal(result.displayUrl, `https://qr.nspk.ru.evil.org/${id}`);
  assert.ok(result.checkUrl.includes('token=private')); assert.ok(result.warnings.some(s => /имитация/.test(s)));
  for (const host of ['multiqr.nspk.ru', 'qr.nspk.ru.']) assert.equal(analyzeQr(`https://${host}/${id}`).checkUrl, null);
});
test('generic URL privacy, internal literals, alternative IPv4 spellings and IPv6 have no internal action', () => {
  const result = analyzeQr('https://www.wikipedia.org/path?token=secret#section');
  assert.equal(result.kind, 'url'); assert.equal(result.displayUrl, 'https://www.wikipedia.org/path');
  assert.equal(result.checkUrl, 'https://www.wikipedia.org/path?token=secret#section'); unverified(result);
  for (const host of ['localhost', '127.0.0.1', '2130706433', '0x7f000001', '10.1.1.1', '169.254.169.254', '192.168.0.1', '100.64.0.1', '198.18.0.1', '[::1]', '[::ffff:127.0.0.1]', '[2606:4700:4700::1111]', 'demo.internal', 'router.home.arpa']) assert.equal(analyzeQr(`http://${host}/`).checkUrl, null, host);
});
test('GOST codes parse present fields without inventing or trusting recipient identity', () => {
  for (const prefix of ['ST00011', 'ST00012', 'ST00013']) {
    const result = analyzeQr(requisites.replace('ST00012', prefix));
    assert.equal(result.kind, 'requisites'); assert.equal(result.checkUrl, null);
    assert.equal(result.fields.find(item => /Получатель/.test(item.label)).value, 'ООО Ромашка');
    assert.ok(!result.fields.some(item => /ИНН|Сумма/.test(item.label))); unverified(result);
  }
  const matching = analyzeQr(`${requisites}|Sum=123456|PayeeINN=7707083893|Purpose=Оплата`, { expectedAmount: '1234.56', expectedRecipient: '  ООО   РОМАШКА ' });
  assert.equal(matching.tone, 'warning'); assert.ok(matching.warnings.some(s => /только как текст/.test(s))); unverified(matching);
});
test('amount comparison uses BigInt beyond Number precision and reports expectation mismatch', () => {
  const large = analyzeQr(`${requisites}|Sum=999999999999999999`, { expectedAmount: '9999999999999999.98' });
  assert.equal(large.kind, 'requisites'); assert.equal(large.tone, 'danger');
  assert.ok(large.fields.some(item => item.value === '9999999999999999,99 ₽'));
  const mismatch = analyzeQr(`${sbp}?sum=150&cur=RUB`, { expectedAmount: '1.51' });
  assert.equal(mismatch.tone, 'danger');
  assert.equal(analyzeQr(requisites, { expectedRecipient: 'Другая компания' }).tone, 'danger');
  assert.equal(analyzeQr(requisites, { expectedAmount: '100' }).tone, 'warning');
});
test('GOST malformed duplicates and prototype keys are rejected without prototype mutation', () => {
  for (const text of [
    `${requisites}|Name=Иное`, `${requisites}|name=Иное`, `${requisites}|__proto__=x`, `${requisites}|constructor=x`,
    `${requisites}|Sum=0`, `${requisites}|Sum=1000000000000000000`, `${requisites}|PayeeINN=123`,
    requisites.replace('40702810100010000001', '123'), requisites.replace('|BIC=044525225', ''),
  ]) { assert.equal(analyzeQr(text).kind, 'unsupported', text); }
  assert.equal({}.polluted, undefined);
});
test('XSS-looking field remains plain data and never turns into a URL action', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const result = analyzeQr(requisites.replace('ООО Ромашка', payload));
  assert.equal(result.kind, 'requisites'); assert.equal(result.fields[0].value, payload);
  assert.equal(result.checkUrl, null); unverified(result);
});
test('fiscal receipt data is not interpreted as a payment or URL action', () => {
  const data = 't=20261030T1200&s=123.45&fn=9287440300123456&i=123&fp=123456&n=1';
  for (const input of [data, `https://receipt.example.org/?${data}`]) {
    const result = analyzeQr(input); assert.equal(result.kind, 'receipt'); assert.equal(result.checkUrl, null); unverified(result);
  }
  assert.equal(analyzeQr(`${data}&s=2`).kind, 'unsupported');
});
test('unknown, oversized and control-bearing inputs return unavailable reports without throwing or networking', () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network must not be used'); };
  try {
    for (const value of [null, {}, 2, '', 'ordinary text', 'x'.repeat(4097), 'https://example.org/a\nb', 'https://example.org/\u0000', 'https://example.org/\ud800', 'https://example.org/a\\b', 'https://example.org/' + 'a'.repeat(2048)]) {
      const result = analyzeQr(value); assert.equal(result.kind, 'unsupported'); assert.equal(result.checkUrl, null); unverified(result);
    }
    assert.equal(analyzeQr(`  ${sbp}  `).kind, 'sbp');
    assert.equal(analyzeQr(`${sbp}?sum=100&cur=RUB`, { expectedAmount: '1.001' }).tone, 'warning');
  } finally { globalThis.fetch = previous; }
});
test('missing or unusual optional arguments do not throw', () => {
  assert.equal(analyzeQr(sbp, null).kind, 'sbp');
  assert.equal(analyzeQr(sbp, 42).kind, 'sbp');
  assert.equal(analyzeQr(sbp, { get expectedAmount() { throw new Error('bad option'); } }).kind, 'unsupported');
});
test('required GOST names must contain visible text, including Unicode whitespace and invisible formatting', () => {
  for (const blank of ['   ', '\u00a0\u202f', '\u200b\u200c\u200d\u2060']) {
    for (const original of ['ООО Ромашка', 'Банк']) assert.equal(analyzeQr(requisites.replace(original, blank)).kind, 'unsupported');
  }
  const expectedBlank = analyzeQr(requisites, { expectedRecipient: '\u200b' });
  assert.equal(expectedBlank.tone, 'warning');
  assert.ok(expectedBlank.warnings.some(value => /Ожидаемое имя.*не распознано/.test(value)));
});
test('GOST text lengths are bounded without truncation, at 160/45/210 Unicode characters', () => {
  const boundary = requisites.replace('ООО Ромашка', 'Я'.repeat(160)).replace('Банк', 'Б'.repeat(45)) + '|Purpose=' + 'О'.repeat(210);
  assert.equal(analyzeQr(boundary).kind, 'requisites');
  for (const input of [requisites.replace('ООО Ромашка', 'Я'.repeat(161)), requisites.replace('Банк', 'Б'.repeat(46)), requisites + '|Purpose=' + 'О'.repeat(211)]) assert.equal(analyzeQr(input).kind, 'unsupported');
  const supplementary = requisites.replace('Банк', '𐐀'.repeat(45));
  assert.equal(analyzeQr(supplementary).kind, 'requisites');
});
test('direction-changing Unicode controls cannot reorder displayed QR data; ordinary RTL names remain data', () => {
  for (const control of ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']) {
    const result = analyzeQr(requisites.replace('ООО Ромашка', `ООО ${control}123`));
    assert.equal(result.kind, 'unsupported'); assert.equal(result.checkUrl, null);
  }
  assert.equal(analyzeQr(requisites.replace('ООО Ромашка', 'شركة')).kind, 'requisites');
  const invisible = analyzeQr(requisites.replace('ООО Ромашка', 'ООО Ро\u200bмашка'));
  assert.equal(invisible.kind, 'requisites');
  assert.ok(invisible.warnings.some(value => /невидимые форматирующие/.test(value)));
  assert.equal(invisible.fields[0].value, 'ООО Ро\u200bмашка'); unverified(invisible);
  const badExpected = analyzeQr(requisites, { expectedRecipient: 'ООО \u202eРомашка' });
  assert.equal(badExpected.tone, 'warning'); assert.ok(badExpected.warnings.some(value => /Ожидаемое имя.*не распознано/.test(value)));
});
