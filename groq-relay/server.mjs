import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function sameSecret(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function send(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { ...headers, ...extraHeaders });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function handleRelayRequest(request, response, { groqApiKey, relayToken, fetcher = fetch } = {}) {
  try {
    const url = new URL(request.url, 'http://relay.internal');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return send(response, 200, '{"ok":true}', { 'Content-Type': 'application/json' });
    }
    if (!groqApiKey || !relayToken) return send(response, 503, '{"error":"not_configured"}', { 'Content-Type': 'application/json' });
    if (request.method !== 'POST' || url.pathname !== '/openai/v1/chat/completions') {
      return send(response, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (!sameSecret(request.headers['x-vtb-relay-token'], relayToken)) {
      return send(response, 401, '{"error":"unauthorized"}', { 'Content-Type': 'application/json' });
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return send(response, 415, '{"error":"json_required"}', { 'Content-Type': 'application/json' });
    }
    const body = await readBody(request);
    JSON.parse(body.toString('utf8'));
    const upstream = await fetcher(GROQ_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (payload.length > MAX_RESPONSE_BYTES) return send(response, 502, '{"error":"upstream_response_too_large"}', { 'Content-Type': 'application/json' });
    return send(response, upstream.status, payload, { 'Content-Type': 'application/json' });
  } catch (error) {
    const status = error?.status === 413 ? 413 : error instanceof SyntaxError ? 400 : 502;
    return send(response, status, JSON.stringify({ error: status === 413 ? 'request_too_large' : status === 400 ? 'invalid_json' : 'upstream_unavailable' }), { 'Content-Type': 'application/json' });
  }
}

export function createRelayServer(options = {}) {
  if (!options.groqApiKey || !options.relayToken) throw new Error('GROQ_API_KEY and RELAY_TOKEN are required');
  return createServer((request, response) => handleRelayRequest(request, response, options));
}

export default function vercelRelay(request, response) {
  return handleRelayRequest(request, response, {
    groqApiKey: process.env.GROQ_API_KEY,
    relayToken: process.env.RELAY_TOKEN,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createRelayServer({ groqApiKey: process.env.GROQ_API_KEY, relayToken: process.env.RELAY_TOKEN });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`Groq relay listening on ${port}`));
}
