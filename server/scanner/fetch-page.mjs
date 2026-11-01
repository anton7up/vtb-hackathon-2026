import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { scanTarget, pinnedDestination, publicAddress, canonicalAddress, displayAddress, ScanError } from './policy.mjs';

export const MAX_HTML_BYTES = 768 * 1024;
export function requestPinned(target, destination, signal, transports = { httpRequest, httpsRequest }) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === 'https:' ? transports.httpsRequest : transports.httpRequest;
    const fail = code => reject(new ScanError(code));
    const req = transport(target.url, {
      method: 'GET', agent: false, signal, maxHeaderSize: 16384,
      rejectUnauthorized: true,
      lookup(_host, options, callback) {
        callback(null, ...(options.all ? [[destination]] : [destination.address, destination.family]));
      },
      headers: { 'User-Agent': 'AntiScamHackathon/1.0 (static page inspection)', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
    }, res => {
      const remote = res.socket.remoteAddress;
      if (!remote || !publicAddress(remote) || canonicalAddress(remote) !== canonicalAddress(destination.address)) { res.destroy(); fail('blocked_target'); return; }
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location; res.destroy();
        if (!location || location.length > 2048) fail('invalid_redirect');
        else resolve({ status, location });
        return;
      }
      if (status < 200 || status >= 300) { res.destroy(); fail(status === 403 || status === 429 ? 'access_restricted' : 'http_error'); return; }
      const type = res.headers['content-type'] || '';
      if (!/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(type)) { res.destroy(); fail('not_html'); return; }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); fail('unsupported_encoding'); return; }
      if (Number(res.headers['content-length']) > MAX_HTML_BYTES) { res.destroy(); fail('too_large'); return; }
      const chunks = []; let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_HTML_BYTES) { res.destroy(); fail('too_large'); }
        else chunks.push(chunk);
      });
      res.on('error', () => fail(signal.aborted ? 'timeout' : 'network_failed'));
      res.on('aborted', () => fail('network_failed'));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const headerCharset = type.match(/charset\s*=\s*["']?([a-z0-9_-]+)/i)?.[1];
        const metaCharset = bytes.subarray(0, 4096).toString('latin1').match(/charset\s*=\s*["']?([a-z0-9_-]+)/i)?.[1];
        try { resolve({ status, html: new TextDecoder(headerCharset || metaCharset || 'utf-8').decode(bytes), bytes: length }); }
        catch { fail('unsupported_encoding'); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new ScanError('timeout')));
    req.on('error', error => fail(signal.aborted || error.code === 'ABORT_ERR' || error.code === 'timeout' ? 'timeout' : /CERT|TLS|SSL|ALTNAME/.test(error.code || '') ? 'tls_error' : 'network_failed'));
    req.end();
  });
}
export async function fetchPage(input, { signal = AbortSignal.timeout(12000), resolver, requester = requestPinned } = {}) {
  let current = input;
  const trace = [], seen = new Set();
  for (let count = 0; count <= 4; count++) {
    if (signal.aborted) throw new ScanError('timeout');
    const target = scanTarget(current);
    if (seen.has(target.url.href)) throw new ScanError('redirect_loop');
    seen.add(target.url.href);
    const destination = await pinnedDestination(target, signal, resolver);
    const response = await requester(target, destination, signal);
    trace.push({ url: displayAddress(target.url.href), status: response.status });
    if (response.location) {
      if (count === 4) throw new ScanError('too_many_redirects');
      try { current = new URL(response.location, target.url).href; } catch { throw new ScanError('invalid_redirect'); }
      continue;
    }
    return { ...response, finalUrl: target.url.href, trace };
  }
  throw new ScanError('too_many_redirects');
}
