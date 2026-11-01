import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';

export class ScanError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function publicAddress(value) {
  try {
    let ip = ipaddr.parse(value);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast' && (ip.kind() !== 'ipv6' || ip.match(ipaddr.parse('2000::'), 3));
  } catch { return false; }
}
export function canonicalAddress(value) {
  let ip = ipaddr.parse(value);
  if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
  return ip.toNormalizedString();
}
export function scanTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new ScanError('invalid_url'); }
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value) || !/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ScanError('invalid_url');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new ScanError('blocked_target');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || /(^|\.)(localhost|local|internal|invalid|example|test|onion)$/.test(hostname) || hostname.endsWith('.home.arpa')) throw new ScanError('blocked_target');
  if (ipaddr.isValid(hostname)) { if (!publicAddress(hostname)) throw new ScanError('blocked_target'); }
  else if (!hostname.includes('.') || !/^[a-z0-9.-]+$/.test(hostname) || hostname.split('.').some(s => !s || s.length > 63 || s.startsWith('-') || s.endsWith('-'))) throw new ScanError('blocked_target');
  url.hash = '';
  return { url, hostname };
}
export function displayAddress(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`.slice(0, 400); }
  catch { return 'Адрес не распознан'; }
}
export async function pinnedDestination(target, signal, resolver = lookup) {
  if (signal?.aborted) throw new ScanError('timeout');
  if (ipaddr.isValid(target.hostname)) return { address: target.hostname, family: ipaddr.parse(target.hostname).kind() === 'ipv4' ? 4 : 6 };
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(new ScanError('timeout'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    const addresses = await Promise.race([resolver(target.hostname, { all: true, verbatim: true }), aborted]);
    // Reject mixed public/private answers too; no unchecked DNS lookup at connect time.
    if (!addresses?.length || addresses.some(a => !publicAddress(a.address))) throw new ScanError('non_public_dns');
    return addresses.find(a => a.family === 4) || addresses[0];
  } catch (error) { if (error instanceof ScanError) throw error; throw new ScanError('dns_failed'); }
  finally { signal?.removeEventListener('abort', abort); }
}
