import { ScanError } from './policy.mjs';

export const MAX_DOM_BYTES = 768 * 1024;
export const BROWSER_TIMEOUT_MS = 8000;

const documentPolicy = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox";
const launchEnvironment = () => Object.fromEntries(['SystemRoot', 'TEMP', 'TMP']
  .filter(key => typeof process.env[key] === 'string' && process.env[key])
  .map(key => [key, process.env[key]]));
const timedOut = error => error?.name === 'TimeoutError' || error?.name === 'AbortError';
const ignoreFailure = operation => { try { Promise.resolve(operation()).catch(() => {}); } catch {} };

// The caller has already downloaded and limited this HTML with fetchPage.
// Chromium only parses this supplied document: no JavaScript, form submissions,
// subresources, WebSockets or browser-initiated target requests are allowed.
// These browser controls are not an OS/network sandbox or dynamic-site rendering.
export async function readBrowserDocument({ url, html, signal, executablePath }, { chromium } = {}) {
  if (signal?.aborted) throw new ScanError('timeout');
  if (typeof html !== 'string') throw new ScanError('browser_failed');
  if (Buffer.byteLength(html, 'utf8') > MAX_DOM_BYTES) throw new ScanError('too_large');
  let target;
  try {
    target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid document URL');
    target.hash = '';
  } catch { throw new ScanError('browser_failed'); }
  const exactUrl = target.href;
  let browser, closing, stopped = false, timer, onAbort;
  const closeBrowser = () => {
    if (!browser) return Promise.resolve();
    if (!closing) {
      try { closing = Promise.resolve(browser.close()).catch(() => {}); }
      catch { closing = Promise.resolve(); }
    }
    return closing;
  };
  const assertActive = () => { if (stopped || signal?.aborted) throw new ScanError('timeout'); };
  const cancelled = new Promise((_, reject) => {
    onAbort = () => {
      stopped = true;
      reject(new ScanError('timeout'));
      void closeBrowser();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(onAbort, BROWSER_TIMEOUT_MS);
  });
  const run = async () => {
    try {
      let engine = chromium;
      if (!engine) {
        try { ({ chromium: engine } = await import('playwright-core')); }
        catch { throw new ScanError('browser_unavailable'); }
      }
      assertActive();
      try {
        browser = await engine.launch({
          headless: true,
          chromiumSandbox: true,
          timeout: BROWSER_TIMEOUT_MS,
          env: launchEnvironment(),
          ...(executablePath ? { executablePath } : {}),
          args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--no-first-run'],
        });
      } catch (error) {
        throw new ScanError(timedOut(error) || signal?.aborted || stopped ? 'timeout' : 'browser_unavailable');
      }
      assertActive();
      const context = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: 'block',
        acceptDownloads: false,
        offline: true,
        permissions: [],
        ignoreHTTPSErrors: false,
      });
      assertActive();
      let page, fulfilled = false, documentProvided = false;
      const abortRoute = async route => { try { await route.abort('blockedbyclient'); } catch {} };
      await context.route('**/*', async route => {
        let request;
        try { request = route.request(); }
        catch { await abortRoute(route); return; }
        let mainDocument = false;
        try {
          mainDocument = !stopped && !signal?.aborted && !fulfilled && !!page &&
            request.isNavigationRequest() && request.frame() === page.mainFrame() &&
            request.method() === 'GET' && request.url() === exactUrl;
        } catch {}
        if (!mainDocument) { await abortRoute(route); return; }
        // Consume the only permit before awaiting so concurrent requests cannot
        // obtain a second document, even at the same URL.
        fulfilled = true;
        try {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            headers: { 'Content-Security-Policy': documentPolicy, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
            body: html,
          });
          documentProvided = true;
        } catch { await abortRoute(route); }
      });
      assertActive();
      if (typeof context.routeWebSocket === 'function') {
        await context.routeWebSocket('**/*', socket => { ignoreFailure(() => socket.close()); });
      }
      assertActive();
      page = await context.newPage();
      assertActive();
      const closePage = otherPage => { ignoreFailure(() => otherPage.close()); };
      context.on('page', otherPage => { if (otherPage !== page) closePage(otherPage); });
      page.on('popup', closePage);
      page.on('download', download => { ignoreFailure(() => download.cancel()); });
      await page.goto(exactUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
      assertActive();
      if (!documentProvided) throw new ScanError('browser_failed');
      const domHtml = await page.content();
      assertActive();
      if (typeof domHtml !== 'string') throw new ScanError('browser_failed');
      if (Buffer.byteLength(domHtml, 'utf8') > MAX_DOM_BYTES) throw new ScanError('too_large');
      return { html: domHtml };
    } finally {
      // A launch may finish after cancellation. Close that late browser too.
      if (stopped) await closeBrowser();
    }
  };
  try { return await Promise.race([run(), cancelled]); }
  catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(timedOut(error) || signal?.aborted || stopped ? 'timeout' : 'browser_failed');
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await closeBrowser();
  }
}
