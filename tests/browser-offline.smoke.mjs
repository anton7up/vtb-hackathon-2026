// Explicit manual smoke test; not part of npm test. No target network is used.
// Run: node tests/browser-offline.smoke.mjs (requires installed Chrome/Edge/Chromium).
import assert from 'node:assert/strict';
import { readBrowserDocument } from '../server/scanner/browser-page.mjs';
import { browserExecutable } from '../server/scanner/service.mjs';

const executablePath = browserExecutable(process.env.SCANNER_BROWSER_PATH);
const html = `<!doctype html><title>Static smoke OK</title>
  <script>document.title='EXECUTED';fetch('http://127.0.0.1:3000/api/state');</script>
  <h1>Static body</h1><img src="http://127.0.0.1:3000/favicon.svg">
  <iframe src="http://127.0.0.1:3000/"></iframe>`;
const result = await readBrowserDocument({ url: 'https://example.com/', html, executablePath });
assert.equal(result.html.match(/<title>(.*?)<\/title>/s)?.[1], 'Static smoke OK');
assert.ok(result.html.includes('Static body'));
let metaRefresh = 'document';
try {
  const refreshed = await readBrowserDocument({ url: 'https://example.com/', executablePath, html: '<!doctype html><title>Static refresh</title><meta http-equiv="refresh" content="0;url=http://127.0.0.1:3000/"><h1>Static body</h1>' });
  assert.ok(refreshed.html.includes('Static body'));
} catch (error) {
  assert.ok(['browser_failed', 'timeout'].includes(error.code));
  metaRefresh = error.code;
}
console.log(JSON.stringify({ title: 'Static smoke OK', dom_bytes: Buffer.byteLength(result.html), meta_refresh: metaRefresh, javascript_executed: false }));
