import { timingSafeEqual } from 'node:crypto';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json' } });
}

function sameSecret(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export async function handleRelay(request, runtime = {}, fetcher = fetch) {
  if (request.method === 'GET') return json({ ok: true }, 200);
  if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
  if (!runtime.GROQ_API_KEY || !runtime.RELAY_TOKEN) return json({ error: 'not_configured' }, 503);
  if (!sameSecret(request.headers.get('X-VTB-Relay-Token'), runtime.RELAY_TOKEN)) return json({ error: 'unauthorized' }, 401);
  if (!String(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'json_required' }, 415);
  try {
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length > MAX_REQUEST_BYTES) return json({ error: 'request_too_large' }, 413);
    JSON.parse(body.toString('utf8'));
    const upstream = await fetcher(GROQ_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${runtime.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body,
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (payload.length > MAX_RESPONSE_BYTES) return json({ error: 'upstream_response_too_large' }, 502);
    return new Response(payload, { status: upstream.status, headers: { ...securityHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return json({ error: error instanceof SyntaxError ? 'invalid_json' : 'upstream_unavailable' }, error instanceof SyntaxError ? 400 : 502);
  }
}

const vercelHandler = {
  fetch(request) {
    return handleRelay(request, { GROQ_API_KEY: process.env.GROQ_API_KEY, RELAY_TOKEN: process.env.RELAY_TOKEN });
  },
};

export default vercelHandler;

