/* Classic worker: pixels and decoded text stay local; no upload or QR navigation. */
'use strict';
try { importScripts('/vendor/jsqr.js'); } catch {}
const qrReply = error => self.postMessage({ ok: false, error });
function qrText(code) {
  const raw = code.binaryData;
  const bytes = raw ? Uint8Array.from(raw) : null;
  const prefix = bytes ? String.fromCharCode(...bytes.subarray(0, 7)) : '';
  if (prefix.startsWith('ST0001')) {
    const encoding = { ST00011: 'windows-1251', ST00012: 'utf-8', ST00013: 'koi8-r' }[prefix];
    if (!encoding) throw new Error('unsupported_encoding');
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { throw new Error('unsupported_encoding'); }
  }
  if (/^ST0001[123]/.test(code.data || '')) throw new Error('unsupported_encoding');
  return code.data;
}
self.onmessage = event => {
  try {
    const { width, height, buffer } = event.data || {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || !(buffer instanceof ArrayBuffer) || buffer.byteLength !== width * height * 4) { qrReply('decode_failed'); return; }
    if (typeof self.jsQR !== 'function') { qrReply('unavailable'); return; }
    const pixels = new Uint8ClampedArray(buffer);
    const first = self.jsQR(pixels, width, height, { inversionAttempts: 'attemptBoth' });
    if (!first) { qrReply('no_qr'); return; }
    const corners = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'].map(key => first.location?.[key]);
    if (corners.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) { qrReply('decode_failed'); return; }
    const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x))) - 4);
    const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))) - 4);
    const right = Math.min(width - 1, Math.ceil(Math.max(...corners.map(p => p.x))) + 4);
    const bottom = Math.min(height - 1, Math.ceil(Math.max(...corners.map(p => p.y))) + 4);
    if (left > right || top > bottom) { qrReply('decode_failed'); return; }
    // Best-effort multi-code detection, not a guarantee for overlapping, tiny or
    // unreadable codes. Any second readable QR is rejected, even identical text.
    const masked = new Uint8ClampedArray(pixels);
    for (let y = top; y <= bottom; y++) masked.fill(255, (y * width + left) * 4, (y * width + right + 1) * 4);
    if (self.jsQR(masked, width, height, { inversionAttempts: 'attemptBoth' })) { qrReply('multiple_qr'); return; }
    const text = qrText(first);
    if (typeof text !== 'string' || !text.trim()) { qrReply('empty_qr'); return; }
    if (text.length > 8192) { qrReply('decode_failed'); return; }
    self.postMessage({ ok: true, text });
  } catch (error) { qrReply(error.message === 'unsupported_encoding' ? 'unsupported_encoding' : 'decode_failed'); }
};
