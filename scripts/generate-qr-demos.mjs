// Development-only generator. No remote QR service or real payment data.
// npm pack qrcode-generator@1.4.4 --pack-destination .sites-runtime
// Extract into .sites-runtime/qrcode-generator; then run this script.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { QR_DEMOS } from '../public/qr-view.mjs';

const require = createRequire(import.meta.url);
const qrcode = require('../.sites-runtime/qrcode-generator/package/qrcode.js');
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
const decoderContext = {};
runInNewContext(await readFile(new URL('../public/vendor/jsqr.js', import.meta.url), 'utf8'), decoderContext);
const jsQR = decoderContext.jsQR;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
for (const [key, demo] of Object.entries(QR_DEMOS)) {
  const qr = qrcode(0, 'M'); qr.addData(demo.text, 'Byte'); qr.make();
  const count = qr.getModuleCount(), scale = 6, margin = 4, size = (count + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  const scanlines = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y++) {
    scanlines[y * (size + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / scale) - margin, col = Math.floor(x / scale) - margin;
      const value = row >= 0 && row < count && col >= 0 && col < count && qr.isDark(row, col) ? 0 : 255;
      scanlines[y * (size + 1) + 1 + x] = value;
      pixels.set([value, value, value, 255], (y * size + x) * 4);
    }
  }
  const decoded = jsQR(pixels, size, size, { inversionAttempts: 'attemptBoth' });
  assert.ok(decoded, key);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(decoded.binaryData)), demo.text, key);
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 0;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
  await writeFile(new URL(`../public/qr-demo-${key}.png`, import.meta.url), png);
  console.log(`QR demo: ${key}, ${size}x${size}, ${png.length} bytes`);
}
