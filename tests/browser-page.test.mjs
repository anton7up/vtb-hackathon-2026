import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readBrowserDocument, MAX_DOM_BYTES, BROWSER_TIMEOUT_MS } from '../server/scanner/browser-page.mjs';

const url = 'https://shop.example/catalog';
const suppliedHtml = '<!doctype html><title>Static example</title><script>throw new Error("must not execute")</script><img src="https://resource.example/image"><h1>Catalogue</h1>';

class TrackingSignal extends EventTarget {
  aborted = false;
  added = 0;
  removed = 0;
  addEventListener(...args) { this.added++; return super.addEventListener(...args); }
  removeEventListener(...args) { this.removed++; return super.removeEventListener(...args); }
  abort() { this.aborted = true; this.dispatchEvent(new Event('abort')); }
}

function mockBrowser(options = {}) {
  const record = { routes: [], fulfillments: [], aborts: [], launchCalls: 0, closeCalls: 0, evaluations: 0, popupCloses: 0, downloadCancels: 0, websocketCloses: 0 };
  const mainFrame = {};
  const page = new EventEmitter();
  page.mainFrame = () => mainFrame;
  page.evaluate = () => { record.evaluations++; throw new Error('Executing page JavaScript is forbidden'); };
  page.content = async () => options.domHtml ?? '<html><head><title>Static example</title></head><body><h1>Catalogue</h1></body></html>';
  const context = new EventEmitter();
  context.route = async (pattern, handler) => { record.routePattern = pattern; record.routeHandler = handler; };
  if (!options.noWebSocketApi) context.routeWebSocket = async (pattern, handler) => { record.websocketPattern = pattern; record.websocketHandler = handler; };
  context.newPage = async () => page;
  const routeFor = (override = {}) => {
    const request = { url: () => override.url ?? url, method: () => override.method ?? 'GET', isNavigationRequest: () => override.navigation ?? true, frame: () => override.frame ?? mainFrame };
    const route = {
      request: () => request,
      fulfill: async value => { record.fulfillments.push({ request, value }); if (options.fulfillError) throw options.fulfillError; },
      abort: async code => { record.aborts.push({ request, code }); },
      continue: () => { throw new Error('Route continuation must never be used'); },
      fetch: () => { throw new Error('Route fetching must never be used'); },
    };
    record.routes.push(route);
    return route;
  };
  page.goto = async (navigationUrl, navigationOptions) => {
    record.navigationUrl = navigationUrl; record.navigationOptions = navigationOptions;
    for (const request of options.beforeRequests || []) await record.routeHandler(routeFor(request));
    await record.routeHandler(routeFor({ url: navigationUrl }));
    for (const request of options.afterRequests || []) await record.routeHandler(routeFor(request));
    if (options.gotoError) throw options.gotoError;
    if (options.gotoHook) await options.gotoHook({ record, page, context, routeFor });
    return {};
  };
  const browser = {
    async newContext(contextOptions) { record.contextOptions = contextOptions; if (options.contextError) throw options.contextError; return context; },
    async close() { record.closeCalls++; },
  };
  const chromium = {
    async launch(launchOptions) {
      record.launchCalls++; record.launchOptions = launchOptions;
      if (options.launchError) throw options.launchError;
      return options.launchPromise ? await options.launchPromise : browser;
    },
    launchPersistentContext() { throw new Error('A personal/persistent profile must never be opened'); },
  };
  return { chromium, browser, page, context, record };
}

test('browser-static parsing uses a fresh sandboxed offline context and only a fulfilled supplied document', async () => {
  const mock = mockBrowser();
  const signal = new TrackingSignal();
  const result = await readBrowserDocument({ url, html: suppliedHtml, signal, executablePath: 'C:/Browser/chrome.exe' }, mock);
  assert.match(result.html, /Catalogue/);
  const launch = mock.record.launchOptions;
  assert.equal(launch.headless, true); assert.equal(launch.chromiumSandbox, true);
  assert.equal(launch.executablePath, 'C:/Browser/chrome.exe');
  assert.equal(launch.timeout, BROWSER_TIMEOUT_MS);
  assert.equal(launch.args.some(x => /no-sandbox|disable-setuid-sandbox|user-data-dir/i.test(x)), false);
  assert.ok(Object.keys(launch.env).every(key => ['SystemRoot', 'TEMP', 'TMP'].includes(key)));
  assert.equal('GROQ_API_KEY' in launch.env, false); assert.equal('PATH' in launch.env, false);
  assert.deepEqual(mock.record.contextOptions, { javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, offline: true, permissions: [], ignoreHTTPSErrors: false });
  assert.equal(mock.record.routePattern, '**/*');
  assert.deepEqual(mock.record.navigationOptions, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
  assert.equal(mock.record.fulfillments.length, 1);
  const response = mock.record.fulfillments[0].value;
  assert.equal(response.body, suppliedHtml); assert.equal(response.status, 200);
  assert.match(response.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.match(response.headers['Content-Security-Policy'], /sandbox/);
  assert.match(response.headers['Content-Security-Policy'], /form-action 'none'/);
  assert.equal(mock.record.evaluations, 0); assert.equal(mock.record.closeCalls, 1);
  assert.equal(signal.added, 1); assert.equal(signal.removed, 1);
});

test('only one exact main-frame GET is fulfilled; every other request is aborted', async () => {
  const requests = [
    { url: 'https://other.example/', navigation: true },
    { url, method: 'POST' },
    { url, frame: {} },
    { url, navigation: false },
  ];
  const mock = mockBrowser({ beforeRequests: requests, afterRequests: [{ url }, { url: 'http://127.0.0.1/private' }, { url: 'https://resource.example/image', navigation: false }] });
  await readBrowserDocument({ url, html: suppliedHtml }, mock);
  assert.equal(mock.record.fulfillments.length, 1);
  assert.equal(mock.record.aborts.length, 7);
  assert.ok(mock.record.aborts.every(x => x.code === 'blockedbyclient'));
  assert.equal(mock.record.closeCalls, 1);
});

test('supported WebSockets, downloads and popups are closed without executing page code', async () => {
  const mock = mockBrowser({ gotoHook: async ({ record, page, context }) => {
    await record.websocketHandler({ close: async () => { record.websocketCloses++; }, connectToServer: () => { throw new Error('Network forbidden'); } });
    page.emit('download', { cancel: async () => { record.downloadCancels++; } });
    page.emit('popup', { close: async () => { record.popupCloses++; } });
    context.emit('page', { close: async () => { record.popupCloses++; } });
  } });
  await readBrowserDocument({ url, html: suppliedHtml }, mock);
  assert.equal(mock.record.websocketPattern, '**/*'); assert.equal(mock.record.websocketCloses, 1);
  assert.equal(mock.record.downloadCancels, 1); assert.equal(mock.record.popupCloses, 2);
  assert.equal(mock.record.evaluations, 0); assert.equal(mock.record.closeCalls, 1);
});

test('older browser APIs without WebSocket routing still keep JavaScript and all network routes disabled', async () => {
  const mock = mockBrowser({ noWebSocketApi: true });
  await readBrowserDocument({ url, html: suppliedHtml }, mock);
  assert.equal(mock.record.contextOptions.javaScriptEnabled, false);
  assert.equal(mock.record.contextOptions.offline, true); assert.equal(mock.record.routePattern, '**/*');
  assert.equal(mock.record.closeCalls, 1);
});

test('input and returned DOM have independent UTF-8 byte limits', async () => {
  const tooLarge = 'я'.repeat(MAX_DOM_BYTES / 2 + 1);
  const early = mockBrowser();
  await assert.rejects(readBrowserDocument({ url, html: tooLarge }, early), { code: 'too_large' });
  assert.equal(early.record.launchCalls, 0);
  const expanded = mockBrowser({ domHtml: tooLarge });
  await assert.rejects(readBrowserDocument({ url, html: suppliedHtml }, expanded), { code: 'too_large' });
  assert.equal(expanded.record.closeCalls, 1);
});

test('launch failure is unavailable; a failure after launch is browser_failed and cleans up', async () => {
  const unavailable = mockBrowser({ launchError: new Error('No executable') });
  await assert.rejects(readBrowserDocument({ url, html: suppliedHtml }, unavailable), { code: 'browser_unavailable' });
  const failed = mockBrowser({ contextError: new Error('Context unavailable') });
  await assert.rejects(readBrowserDocument({ url, html: suppliedHtml }, failed), { code: 'browser_failed' });
  assert.equal(failed.record.closeCalls, 1);
});

test('a failed document fulfillment never produces a successful empty-page result', async () => {
  const mock = mockBrowser({ fulfillError: new Error('Route already closed') });
  await assert.rejects(readBrowserDocument({ url, html: suppliedHtml }, mock), { code: 'browser_failed' });
  assert.equal(mock.record.aborts.length, 1); assert.equal(mock.record.closeCalls, 1);
});

test('aborted requests do not launch; mid-navigation cancellation closes the browser and removes its listener', async () => {
  const earlySignal = new TrackingSignal(); earlySignal.abort();
  const early = mockBrowser();
  await assert.rejects(readBrowserDocument({ url, html: suppliedHtml, signal: earlySignal }, early), { code: 'timeout' });
  assert.equal(early.record.launchCalls, 0);
  const signal = new TrackingSignal();
  const running = mockBrowser({ gotoHook: async () => signal.abort() });
  await assert.rejects(readBrowserDocument({ url, html: suppliedHtml, signal }, running), { code: 'timeout' });
  assert.equal(running.record.closeCalls, 1); assert.equal(signal.removed, 1);
});

test('a browser that finishes launching after cancellation is also closed', async () => {
  let finishLaunch;
  const launchPromise = new Promise(resolve => { finishLaunch = resolve; });
  const signal = new TrackingSignal(), mock = mockBrowser({ launchPromise });
  const pending = readBrowserDocument({ url, html: suppliedHtml, signal }, mock);
  signal.abort();
  await assert.rejects(pending, { code: 'timeout' });
  finishLaunch(mock.browser);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(mock.record.closeCalls, 1);
});

test('navigation timeouts are reported as timeout and close the browser', async () => {
  const timeout = new Error('Navigation timeout'); timeout.name = 'TimeoutError';
  const mock = mockBrowser({ gotoError: timeout });
  await assert.rejects(readBrowserDocument({ url, html: suppliedHtml }, mock), { code: 'timeout' });
  assert.equal(mock.record.closeCalls, 1);
});

test('overall deadline also interrupts a stalled DOM operation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mock = mockBrowser({ gotoHook: () => new Promise(() => {}) });
  const pending = readBrowserDocument({ url, html: suppliedHtml }, mock);
  for (let i = 0; i < 24 && !mock.record.navigationUrl; i++) await Promise.resolve();
  assert.equal(mock.record.navigationUrl, url);
  t.mock.timers.tick(BROWSER_TIMEOUT_MS + 1);
  await assert.rejects(pending, { code: 'timeout' });
  assert.equal(mock.record.closeCalls, 1);
});
