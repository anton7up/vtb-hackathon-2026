import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';
import { canonicalAddress, publicAddress, scanTarget, ScanError } from './policy.mjs';

// A fixed DNS service, not a user-controlled URL/proxy. System settings are untouched.
// Only hostnames are sent, never paths, cookies, query strings or submitted HTML.
const ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const BOOTSTRAP_IP = '1.1.1.1';
const MAX_DNS_BYTES = 32768;
const cleanName = value => typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : '';

export function parseDnsAnswers(body, hostname, type) {
  if (!body || body.Status !== 0 || body.TC === true || !Array.isArray(body.Question) || body.Question.length !== 1 || cleanName(body.Question[0]?.name) !== hostname || body.Question[0]?.type !== type) throw new ScanError('dns_failed');
  const answers = body.Answer === undefined ? [] : body.Answer;
  if (!Array.isArray(answers) || answers.length > 64) throw new ScanError('dns_failed');
  const aliases = new Map();
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object') throw new ScanError('dns_failed');
    const name = cleanName(answer.name);
    if (!name || ![1, 5, 28].includes(answer.type)) throw new ScanError('dns_failed');
    if (answer.type === 5) {
      const alias = cleanName(answer.data);
      if (aliases.has(name) && aliases.get(name) !== alias) throw new ScanError('dns_failed');
      try { if (scanTarget(`https://${alias}/`).hostname !== alias) throw new Error(); } catch { throw new ScanError('dns_failed'); }
      aliases.set(name, alias);
    } else {
      if (!publicAddress(answer.data)) throw new ScanError('non_public_dns');
      const family = ipaddr.parse(answer.data).kind() === 'ipv4' ? 4 : 6;
      if (family !== (answer.type === 1 ? 4 : 6)) throw new ScanError('dns_failed');
    }
  }
  const reachable = new Set([hostname]);
  let current = hostname;
  while (aliases.has(current)) {
    current = aliases.get(current);
    if (reachable.has(current) || reachable.size >= 9) throw new ScanError('dns_failed');
    reachable.add(current);
  }
  return answers.filter(a => a.type === type && reachable.has(cleanName(a.name))).map(a => ({ address: a.data, family: type === 1 ? 4 : 6 }));
}

export function queryDns(hostname, type, signal, request = httpsRequest) {
  if (signal?.aborted) return Promise.reject(new ScanError('timeout'));
  return new Promise((resolve, reject) => {
    const fail = code => reject(new ScanError(code));
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ name: hostname, type: type === 1 ? 'A' : 'AAAA' }).toString();
    const req = request(url, {
      method: 'GET', agent: false, signal, rejectUnauthorized: true, maxHeaderSize: 8192,
      lookup(_host, options, callback) { callback(null, ...(options.all ? [[{ address: BOOTSTRAP_IP, family: 4 }]] : [BOOTSTRAP_IP, 4])); },
      headers: { Accept: 'application/dns-json', 'Accept-Encoding': 'identity' },
    }, res => {
      if (!publicAddress(res.socket.remoteAddress) || canonicalAddress(res.socket.remoteAddress) !== BOOTSTRAP_IP || res.statusCode !== 200 || !/^application\/(dns-json|json)(;|$)/i.test(res.headers['content-type'] || '') || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length']) > MAX_DNS_BYTES) { res.destroy(); fail('dns_failed'); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_DNS_BYTES) { res.destroy(); fail('dns_failed'); }
        else chunks.push(chunk);
      });
      res.on('error', () => fail(signal?.aborted ? 'timeout' : 'dns_failed'));
      res.on('aborted', () => fail('dns_failed'));
      res.on('end', () => {
        try { resolve(parseDnsAnswers(JSON.parse(Buffer.concat(chunks).toString('utf8')), hostname, type)); }
        catch (error) { reject(error instanceof ScanError ? error : new ScanError('dns_failed')); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new ScanError('timeout')));
    req.on('error', error => fail(signal?.aborted || error.code === 'ABORT_ERR' || error.code === 'timeout' ? 'timeout' : 'dns_failed'));
    req.end();
  });
}

export function createCloudflareResolver(signal, { request = httpsRequest } = {}) {
  const cache = new Map();
  return async hostname => {
    if (signal?.aborted) throw new ScanError('timeout');
    // Also enforce domain syntax when this function is called outside pinnedDestination.
    if (scanTarget(`https://${hostname}/`).hostname !== hostname) throw new ScanError('dns_failed');
    if (!cache.has(hostname)) cache.set(hostname, Promise.all([queryDns(hostname, 1, signal, request), queryDns(hostname, 28, signal, request)]).then(groups => {
      const records = groups.flat();
      if (!records.length) throw new ScanError('dns_failed');
      return records;
    }));
    return cache.get(hostname);
  };
}
