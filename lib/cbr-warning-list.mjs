// Server-only parser for the Bank of Russia public warning list. No target-site fetches.
import { isIP } from 'node:net';

export const CBR_WARNING_SOURCE = Object.freeze({
  name: 'Банк России · список компаний с признаками нелегальной деятельности',
  url: 'https://www.cbr.ru/inside/warning-list/',
  documentationUrl: 'https://cbr.ru/development/warning-list/',
});
export const CBR_WARNING_DATA_URL = 'https://www.cbr.ru/inside/warning-list/black-list-json';

function invalidUrl() {
  return Object.assign(new Error('Введите домен или HTTP(S)-ссылку без логина и пароля.'), { code: 'invalid_url', status: 400 });
}

/** Exact host comparison, with only case, IDNA, trailing dot and one www alias normalized. */
export function normalizeCbrCheckUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) throw invalidUrl();
  const value = input.trim();
  if (!value || /[\s\\\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) throw invalidUrl();
  let url;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); }
  catch { throw invalidUrl(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalidUrl();
  let domain = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(domain.replace(/^\[|\]$/g, '')) || domain.length > 253) throw invalidUrl();
  if (domain.startsWith('www.')) domain = domain.slice(4);
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) || /^\d+$/u.test(labels.at(-1))) throw invalidUrl();
  return { domain, pathname: url.pathname, hasQuery: Boolean(url.search), hasHash: Boolean(url.hash) };
}

function listedDomains(value) {
  const domains = new Set();
  if (!value) return domains;
  // A record such as vk.com/one-company must never mark all of vk.com as listed.
  // Iterate lazily: a malformed comma-heavy field must not allocate millions of tokens.
  for (const match of value.matchAll(/[^,;\s]+/gu)) {
    const token = match[0];
    if (!token || token.length > 4096) continue;
    try {
      const normalized = normalizeCbrCheckUrl(token);
      if (normalized.pathname !== '/' || normalized.hasQuery || normalized.hasHash) continue;
      domains.add(normalized.domain);
    } catch { /* Non-URL contact descriptions and scoped pages are not domain evidence. */ }
  }
  return domains;
}

function field(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/** Current full export shape verified against the official RC / Id / Site / Sign JSON. */
export function parseCbrWarningList(payload, { maxRecords = 100_000 } = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.RC) || !payload.RC.length || payload.RC.length > maxRecords) throw new Error('invalid_dataset');
  const domains = new Map();
  const ids = new Set();
  let indexedRecords = 0;
  for (const row of payload.RC) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.Id) || row.Id <= 0 || ids.has(row.Id) || typeof row.Name !== 'string' || !row.Name.trim() || !Object.hasOwn(row, 'Site') || (row.Site !== null && typeof row.Site !== 'string') || (row.Sign !== null && typeof row.Sign !== 'string')) throw new Error('invalid_dataset');
    ids.add(row.Id);
    const recordDomains = listedDomains(row.Site);
    if (recordDomains.size) indexedRecords += 1;
    for (const domain of recordDomains) {
      const record = Object.freeze({
        id: row.Id, name: field(row.Name, 1000), signs: field(row.Sign, 1500),
        listedAt: field(row.DT, 40), updatedAt: field(row.DateUpdate, 60),
        matchedDomain: domain,
        // Link only to the official catalogue; never make a malicious domain clickable.
        detailUrl: CBR_WARNING_SOURCE.url,
      });
      if (!domains.has(domain)) domains.set(domain, []);
      domains.get(domain).push(record);
    }
  }
  // A missing/changed schema must not silently produce a reassuring empty index.
  if (!domains.size) throw new Error('invalid_dataset');
  return { domains, recordCount: payload.RC.length, indexedRecords };
}

export function lookupCbrWarningDomain(index, domain, { maxMatches = 10 } = {}) {
  const matches = index.domains.get(domain) || [];
  return { matches: matches.slice(0, maxMatches).map(record => ({ ...record })), matchCount: matches.length };
}
