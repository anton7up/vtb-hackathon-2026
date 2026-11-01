import { CBR_WARNING_DATA_URL, CBR_WARNING_SOURCE, normalizeCbrCheckUrl, parseCbrWarningList, lookupCbrWarningDomain } from '../lib/cbr-warning-list.mjs';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

async function readLimitedJson(response, maxBytes, signal) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) throw new Error('response_too_large');
  const type = response.headers.get('content-type') || '';
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/iu.test(type)) throw new Error('invalid_content_type');
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('invalid_response');
  const reader = response.body.getReader();
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abortRead, { once: true });
  const chunks = [];
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      if (signal.aborted) throw new Error('timeout');
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('response_too_large');
      chunks.push(value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
  } finally {
    signal.removeEventListener('abort', abortRead);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fixed official origin only. User input is looked up locally and is never sent upstream. */
export function createCbrWarningService({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15_000, maxBytes = DEFAULT_MAX_BYTES, cacheTtlMs = 6 * 60 * 60 * 1000, failureBackoffMs = 60_000 } = {}) {
  let snapshot = null;
  let pending = null;
  let retryAt = 0;
  let lastErrorCode = 'unavailable';

  async function refresh() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
    });
    try {
      const result = await Promise.race([timeout, (async () => {
        const response = await fetchImpl(CBR_WARNING_DATA_URL, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (response.status !== 200 || response.redirected || (response.url && response.url !== CBR_WARNING_DATA_URL)) throw new Error('official_source_unavailable');
        const payload = await readLimitedJson(response, maxBytes, controller.signal);
        return parseCbrWarningList(payload);
      })()]);
      snapshot = { index: result, fetchedAt: now() };
      retryAt = 0;
      return snapshot;
    } catch (error) {
      lastErrorCode = ['timeout', 'response_too_large', 'invalid_dataset', 'invalid_content_type'].includes(error?.message) ? error.message : 'official_source_unavailable';
      retryAt = now() + failureBackoffMs;
      throw error;
    } finally {
      clearTimeout(timer);
      // Close unread bodies on rejected status/headers too, not just timed-out reads.
      controller.abort();
    }
  }

  async function freshSnapshot() {
    if (snapshot && now() - snapshot.fetchedAt < cacheTtlMs) return snapshot;
    if (pending) return pending;
    if (now() < retryAt) throw new Error('backoff');
    pending = refresh();
    try { return await pending; }
    finally { pending = null; }
  }

  return {
    async checkUrl(input) {
      // Invalid input is an HTTP 400 contract, not an authoritative negative lookup.
      const { domain } = normalizeCbrCheckUrl(input);
      const base = { domain, source: { ...CBR_WARNING_SOURCE }, checkedAt: new Date(now()).toISOString() };
      try {
        const data = await freshSnapshot();
        const found = lookupCbrWarningDomain(data.index, domain);
        return {
          ...base, status: found.matchCount ? 'matched' : 'not_listed',
          dataFetchedAt: new Date(data.fetchedAt).toISOString(), ...found,
          message: found.matchCount
            ? 'Домен указан Банком России в списке компаний с признаками нелегальной деятельности. Не переводите деньги до независимой проверки.'
            : 'Точного совпадения домена в загруженном списке не найдено. Это не означает, что сайт или инвестиции безопасны.',
        };
      } catch {
        return {
          ...base, status: 'unavailable', dataFetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
          matches: [], matchCount: 0, errorCode: lastErrorCode,
          message: 'Не удалось получить актуальный список Банка России. Проверка не завершена; вывод о безопасности не сделан.',
        };
      }
    },
  };
}
