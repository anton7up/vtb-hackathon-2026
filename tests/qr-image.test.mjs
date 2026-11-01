import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { decodeQrImage, inspectQrImageHeader, QR_IMAGE_LIMITS } from '../public/qr-image.mjs';

function png(width = 24, height = 24) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height); bytes[24] = 8; bytes[25] = 6;
  return bytes;
}
function jpeg(width = 24, height = 24) {
  return Uint8Array.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 255, 217]);
}
const file = (bytes = png(), type = 'image/png', size = bytes.byteLength) => ({ size, type, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

function browserMock(t, { reply = { ok: true, text: 'https://example.com/' }, stall = false, workerError = false, bitmapError = false } = {}) {
  const originals = { Worker: globalThis.Worker, document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
  const record = { terminated: 0, closed: 0, workers: [] };
  globalThis.createImageBitmap = async (_file, options) => {
    record.resize = options;
    if (bitmapError) throw new Error('Invalid codec data');
    return { width: options.resizeWidth, height: options.resizeHeight, close() { record.closed++; } };
  };
  globalThis.document = { createElement(type) {
    assert.equal(type, 'canvas');
    const canvas = { width: 0, height: 0, getContext(kind) {
      assert.equal(kind, '2d');
      return { fillRect() {}, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; } };
    } };
    record.canvas = canvas; return canvas;
  } };
  globalThis.Worker = class {
    constructor(path, options) { record.path = path; record.options = options; record.workers.push(this); }
    postMessage(message, transfer) {
      record.posted = message; record.transfer = transfer;
      if (!stall) queueMicrotask(() => { if (workerError) this.onerror?.({ preventDefault() {} }); else this.onmessage?.({ data: reply }); });
    }
    terminate() { record.terminated++; }
  };
  t.after(() => { for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  return record;
}

test('PNG and JPEG magic/headers are inspected before any browser decoding', () => {
  assert.deepEqual(inspectQrImageHeader(png(4000, 4000), 'image/png'), { format: 'png', width: 4000, height: 4000 });
  assert.deepEqual(inspectQrImageHeader(jpeg(320, 240), 'image/jpeg'), { format: 'jpeg', width: 320, height: 240 });
  for (const data of [new TextEncoder().encode('<svg/>'), new TextEncoder().encode('GIF89a'), new TextEncoder().encode('%PDF-1.7')]) assert.throws(() => inspectQrImageHeader(data), { code: 'unsupported_type' });
  assert.throws(() => inspectQrImageHeader(png(), 'image/jpeg'), { code: 'unsupported_type' });
  assert.throws(() => inspectQrImageHeader(png(), 'image/svg+xml'), { code: 'unsupported_type' });
  assert.throws(() => inspectQrImageHeader(png().subarray(0, 24)), { code: 'invalid_image' });
  assert.throws(() => inspectQrImageHeader(jpeg().subarray(0, 16)), { code: 'invalid_image' });
});

test('file, image dimensions and pixel count are bounded before a native codec runs', async () => {
  for (const data of [png(0, 10), png(8193, 10), png(4001, 4000), jpeg(8193, 10)]) assert.throws(() => inspectQrImageHeader(data));
  assert.throws(() => inspectQrImageHeader(new Uint8Array(QR_IMAGE_LIMITS.bytes + 1)), { code: 'too_large' });
  await assert.rejects(decodeQrImage(file(png(), 'image/png', QR_IMAGE_LIMITS.bytes + 1)), { code: 'too_large' });
  await assert.rejects(decodeQrImage(null), { code: 'invalid_file' });
});

test('decoder downscales, transfers only RGBA pixels to a same-origin classic worker and cleans up', async t => {
  const record = browserMock(t), seen = [];
  assert.equal(await decodeQrImage(file(png(4096, 1024)), { onWorker: worker => seen.push(worker) }), 'https://example.com/');
  assert.equal(record.resize.resizeWidth, 2048); assert.equal(record.resize.resizeHeight, 512);
  assert.equal(record.path, '/qr-decoder.worker.js'); assert.equal(record.options?.type, undefined);
  assert.deepEqual(Object.keys(record.posted).sort(), ['buffer', 'height', 'width']);
  assert.equal(record.transfer.length, 1); assert.equal(record.transfer[0], record.posted.buffer);
  assert.equal(record.posted.buffer.byteLength, 2048 * 512 * 4);
  assert.equal(seen.length, 1); assert.equal(record.terminated, 1); assert.equal(record.closed, 1);
  assert.equal(record.canvas.width, 0); assert.equal(record.canvas.height, 0);
});

test('decoder errors are friendly and clean up both bitmap and worker', async t => {
  const record = browserMock(t, { reply: { ok: false, error: 'multiple_qr' } });
  await assert.rejects(decodeQrImage(file()), error => error.code === 'multiple_qr' && /несколько QR/.test(error.message));
  assert.equal(record.terminated, 1); assert.equal(record.closed, 1);
});

test('worker failure and malformed replies never become decoded text', async t => {
  const record = browserMock(t, { workerError: true });
  await assert.rejects(decodeQrImage(file()), { code: 'decode_failed' });
  assert.equal(record.terminated, 1); assert.equal(record.closed, 1);
});

test('worker timeout terminates processing after eight seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const record = browserMock(t, { stall: true });
  const pending = decodeQrImage(file());
  for (let i = 0; i < 12 && !record.posted; i++) await Promise.resolve();
  assert.ok(record.posted);
  t.mock.timers.tick(8001);
  await assert.rejects(pending, { code: 'timeout' });
  assert.equal(record.terminated, 1); assert.equal(record.closed, 1);
});

test('optional cancellation stops the worker and closes the bitmap', async t => {
  const controller = new AbortController(), record = browserMock(t, { stall: true });
  const pending = decodeQrImage(file(), { signal: controller.signal });
  for (let i = 0; i < 12 && !record.posted; i++) await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(record.terminated, 1); assert.equal(record.closed, 1);
});

const workerSource = readFileSync(new URL('../public/qr-decoder.worker.js', import.meta.url), 'utf8');
function runWorker(decoder, payload = {}) {
  const replies = [], imports = [];
  const self = { postMessage: reply => replies.push(reply) };
  runInNewContext(workerSource, { self, importScripts(path) { imports.push(path); self.jsQR = decoder; }, Uint8Array, Uint8ClampedArray, ArrayBuffer, TextDecoder, console: { log() { throw new Error('No image/text logging'); } } });
  self.onmessage({ data: { width: 24, height: 24, buffer: new ArrayBuffer(24 * 24 * 4), ...payload } });
  assert.deepEqual(imports, ['/vendor/jsqr.js']);
  return JSON.parse(JSON.stringify(replies[0]));
}
const code = (data = 'https://example.com/', binaryData) => ({ data, binaryData, location: { topLeftCorner: { x: 8, y: 8 }, topRightCorner: { x: 15, y: 8 }, bottomRightCorner: { x: 15, y: 15 }, bottomLeftCorner: { x: 8, y: 15 } } });

test('worker decodes with inversion support and masks the first QR before a second scan', () => {
  let calls = 0;
  const result = runWorker((pixels, width, height, options) => {
    assert.equal(width, 24); assert.equal(height, 24); assert.equal(options.inversionAttempts, 'attemptBoth');
    calls++;
    if (calls === 1) return code();
    assert.equal(pixels[(10 * width + 10) * 4], 255); assert.equal(pixels[0], 0);
    return null;
  });
  assert.equal(calls, 2); assert.deepEqual(result, { ok: true, text: 'https://example.com/' });
});

test('worker rejects no, empty or multiple QR codes, including identical duplicates', () => {
  assert.deepEqual(runWorker(() => null), { ok: false, error: 'no_qr' });
  let calls = 0;
  assert.deepEqual(runWorker(() => ++calls === 1 ? code(' ') : null), { ok: false, error: 'empty_qr' });
  assert.deepEqual(runWorker(() => code('same value')), { ok: false, error: 'multiple_qr' });
  assert.deepEqual(runWorker(() => code(), { width: 8192 }), { ok: false, error: 'decode_failed' });
});

test('GOST payment QR uses declared binary encoding rather than jsQR replacement text', () => {
  const cases = [
    [Uint8Array.from([...new TextEncoder().encode('ST00011|Name='), 210, 229, 241, 242]), 'ST00011|Name=Тест'],
    [new TextEncoder().encode('ST00012|Name=Тест'), 'ST00012|Name=Тест'],
    [Uint8Array.from([...new TextEncoder().encode('ST00013|Name='), 244, 197, 211, 212]), 'ST00013|Name=Тест'],
  ];
  for (const [bytes, expected] of cases) {
    let calls = 0;
    assert.deepEqual(runWorker(() => ++calls === 1 ? code('broken replacement text', bytes) : null), { ok: true, text: expected });
  }
  let calls = 0;
  const invalidUtf8 = Uint8Array.from([...new TextEncoder().encode('ST00012|Name='), 255]);
  assert.deepEqual(runWorker(() => ++calls === 1 ? code('broken', invalidUtf8) : null), { ok: false, error: 'unsupported_encoding' });
});
