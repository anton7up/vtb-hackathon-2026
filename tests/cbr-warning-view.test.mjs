import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCbrWarningCheck, renderCbrWarningResult } from '../public/cbr-warning-view.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const helpers = { esc };
const report = overrides => ({ status: 'not_listed', domain: 'invest.example', message: 'Совпадение не найдено. Это не гарантия безопасности.', checkedAt: '2026-10-30T10:00:00.000Z', dataFetchedAt: '2026-10-30T09:00:00.000Z', matches: [], matchCount: 0, ...overrides });

test('independent investment form uses no automatic remote form action and explains data boundaries', () => {
  const html = renderCbrWarningCheck({ cbrUrl: 'example.com' }, helpers);
  assert.match(html, /id="cbr-warning-form"/);
  assert.match(html, /id="cbr-warning-url"/);
  assert.match(html, /открытому списку Банка России/u);
  assert.match(html, /Указанный сайт не открываем/u);
  assert.match(html, /Ссылка не передаётся в ЦБ или Qwen/u);
  assert.equal(/\b(?:action|method|formaction)\s*=/i.test(html), false);
});

test('negative and unavailable states are neutral rather than a safety approval', () => {
  for (const status of ['not_listed', 'unavailable']) {
    const html = renderCbrWarningResult(report({ status }), helpers);
    assert.match(html, /outcome-neutral/);
    assert.match(html, /Отсутствие записи не гарантирует безопасность/u);
    assert.equal(/outcome-safe|outcome-success|Сайт безопасен/u.test(html), false);
  }
  const unavailable = renderCbrWarningResult(report({ status: 'unavailable' }), helpers);
  assert.match(unavailable, /Предыдущая копия \(не использована для решения\)/u);
});

test('matched result renders official reason and dates with no clickable target URL', () => {
  const html = renderCbrWarningResult(report({ status: 'matched', matchCount: 12, matches: [{ id: 123, name: 'Учебный проект', matchedDomain: 'invest.example', signs: 'Признаки финансовой пирамиды', listedAt: '2026-10-29', updatedAt: '2026-10-30T10:00:00', detailUrl: 'https://evil.example/' }] }), helpers);
  assert.match(html, /outcome-danger/);
  assert.match(html, /Признаки финансовой пирамиды/u);
  assert.match(html, /запись № 123/u);
  assert.match(html, /Всего совпадений: 12/u);
  const links = [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(links, ['https://www.cbr.ru/inside/warning-list/']);
  assert.equal(html.includes('href="https://evil.example'), false);
});

test('all values including field input, errors and external dataset text are escaped', () => {
  const attack = '"><img src=x onerror=alert(1)></textarea><script>alert(2)</script>';
  const html = renderCbrWarningCheck({ cbrUrl: attack, cbrError: attack, cbrReport: report({ status: 'matched', domain: attack, message: attack, matches: [{ id: attack, name: attack, signs: attack, matchedDomain: attack, listedAt: attack, updatedAt: attack }] }) }, helpers);
  assert.equal(/<(?:script|img|iframe)\b/i.test(html), false);
  assert.match(html, /&lt;script&gt;/);
});

test('busy form remains visibly bounded and disables repeated submissions', () => {
  const html = renderCbrWarningCheck({ cbrBusy: true }, helpers);
  assert.match(html, /id="cbr-warning-url"[^>]*disabled/);
  assert.match(html, /<button[^>]*disabled/);
  assert.match(html, /до 15 секунд/u);
});
