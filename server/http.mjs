import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { bankApi, sessionUser } from '../lib/bank-api.mjs';
import { loginPage, dashboardPage } from './pages.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/app.mjs', ['app.mjs', 'text/javascript']], ['/login.mjs', ['login.mjs', 'text/javascript']],
  ['/request-id.mjs', ['request-id.mjs', 'text/javascript']],
  ['/review-assistant.mjs', ['review-assistant.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/redesign.css', ['redesign.css', 'text/css']],
  ['/site-inspection.mjs', ['site-inspection.mjs', 'text/javascript']],
  ['/qr-analysis.mjs', ['qr-analysis.mjs', 'text/javascript']], ['/qr-view.mjs', ['qr-view.mjs', 'text/javascript']],
  ['/qr-image.mjs', ['qr-image.mjs', 'text/javascript']], ['/qr-decoder.worker.js', ['qr-decoder.worker.js', 'text/javascript']],
  ['/qr.css', ['qr.css', 'text/css']],
  ['/complaints-view.mjs', ['complaints-view.mjs', 'text/javascript']], ['/complaints.css', ['complaints.css', 'text/css']],
  ['/case-risk-card.mjs', ['case-risk-card.mjs', 'text/javascript']], ['/case-risk-card.css', ['case-risk-card.css', 'text/css']],
  ['/trusted-view.mjs', ['trusted-view.mjs', 'text/javascript']], ['/trusted.css', ['trusted.css', 'text/css']],
  ['/purchase-view.mjs', ['purchase-view.mjs', 'text/javascript']], ['/purchase.css', ['purchase.css', 'text/css']],
  ['/recovery-view.mjs', ['recovery-view.mjs', 'text/javascript']], ['/recovery.css', ['recovery.css', 'text/css']],
  ['/qr-payment-view.mjs', ['qr-payment-view.mjs', 'text/javascript']], ['/cbr-warning-view.mjs', ['cbr-warning-view.mjs', 'text/javascript']],
  ['/vendor/jsqr.js', ['vendor/jsqr.js', 'text/javascript']], ['/vendor/jsqr-LICENSE.txt', ['vendor/jsqr-LICENSE.txt', 'text/plain']],
  ...['sbp', 'subscription', 'spoof', 'mismatch', 'normal', 'shared'].map(name => [`/qr-demo-${name}.png`, [`qr-demo-${name}.png`, 'image/png']]),
  ['/shield.svg', ['shield.svg', 'image/svg+xml']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
export function parseOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN must be an http(s) origin without path or credentials');
  return url.origin;
}
function readBody(request, maxBytes = 48000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { chunks.length = 0; reject(Object.assign(new Error('Body too large'), { status: 413 })); }
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Request aborted')));
  });
}
export function createAppServer({ db, runtime = {}, publicOrigin }) {
  const configuredOrigin = publicOrigin ? parseOrigin(publicOrigin) : null;
  const server = createServer(async (incoming, outgoing) => {
    const send = async response => {
      outgoing.writeHead(response.status, { ...securityHeaders, ...Object.fromEntries(response.headers) });
      outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    };
    try {
      const port = server.address().port;
      const host = incoming.headers.host || '';
      // Never trust arbitrary Host or X-Forwarded-* headers (DNS rebinding / IP quota bypass).
      const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      if (configuredOrigin) allowed.add(new URL(configuredOrigin).host);
      if (!allowed.has(host.toLowerCase())) return await send(new Response('Invalid host', { status: 421 }));
      const origin = configuredOrigin || `http://${host}`;
      const url = new URL(incoming.url, origin);
      if (url.origin !== origin) return await send(new Response('Invalid request target', { status: 400 }));
      const method = incoming.method;
      if (!['GET', 'HEAD', 'POST'].includes(method)) return await send(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } }));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      headers.set('CF-Connecting-IP', incoming.socket.remoteAddress || 'local');
      for (const key of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) headers.delete(key);
      const body = method === 'POST' ? await readBody(incoming) : undefined;
      const request = new Request(url, { method, headers, body });
      if (url.pathname.startsWith('/api/')) return await send(await bankApi(request, db, runtime));
      if (method === 'POST') return await send(new Response('Method not allowed', { status: 405 }));
      if (url.pathname === '/healthz') return await send(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
      if (url.pathname === '/shell.css') {
        const css = (await readFile(new URL('../app/globals.css', import.meta.url), 'utf8'))
          .replace("@import '../public/style.css';", "@import '/style.css';")
          .replace("@import '../public/redesign.css';", "@import '/redesign.css';");
        return await send(new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8' } }));
      }
      if (assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        return await send(new Response(await readFile(new URL(file, publicRoot)), { headers: { 'Content-Type': `${type}; charset=utf-8` } }));
      }
      if (!['/', '/login', '/client', '/employee'].includes(url.pathname)) return await send(new Response('Not found', { status: 404 }));
      let user;
      try { user = await sessionUser(request, db); }
      catch (error) { if (error.status !== 401) throw error; }
      const target = user ? `/${user.role === 'employee' ? 'employee' : 'client'}` : '/login';
      if (url.pathname !== target) return await send(new Response(null, { status: 303, headers: { Location: target } }));
      return await send(new Response(user ? dashboardPage(user) : loginPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    } catch (error) {
      // Do not log user bodies, URLs, cookies or environment secrets.
      console.error(error.status === 413 ? 'Request size limit exceeded' : 'Local HTTP request failed');
      if (!outgoing.headersSent) await send(new Response(error.status === 413 ? 'Request too large' : 'Service unavailable', { status: error.status === 413 ? 413 : 503 }));
      else outgoing.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}
