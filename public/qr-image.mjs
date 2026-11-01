// The image never leaves this browser. Only a same-origin, classic decoder worker
// receives its bounded RGBA pixels; this module does not submit or open QR text.
export const QR_IMAGE_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, pixels: 16000000, side: 8192, decodeSide: 2048, workerTimeout: 8000 });
const messages = {
  invalid_file: 'Выберите изображение с одним QR-кодом.',
  too_large: 'Изображение слишком большое. Максимальный размер файла — 5 МБ.',
  unsupported_type: 'Поддерживаются только PNG и JPEG. SVG, GIF и PDF не подходят.',
  invalid_image: 'Не удалось прочитать изображение. Сохраните его заново в PNG или JPEG.',
  dimensions: 'Изображение слишком большое: максимум 16 мегапикселей и 8192 пикселя по стороне.',
  unavailable: 'Распознавание QR недоступно в этом браузере. Попробуйте актуальную версию Chrome или Edge.',
  timeout: 'Распознавание заняло слишком много времени. Обрежьте изображение до одного QR-кода и повторите.',
  aborted: 'Распознавание отменено.',
  no_qr: 'QR-код не найден. Загрузите более чёткое изображение без лишних полей.',
  empty_qr: 'QR-код не содержит текста для проверки.',
  multiple_qr: 'На изображении найдено несколько QR-кодов. Оставьте только один.',
  unsupported_encoding: 'Не удалось прочитать кодировку платёжного QR. Попросите другой QR-код или ссылку.',
  decode_failed: 'Не удалось распознать QR-код. Попробуйте другое изображение.',
};
const fail = code => Object.assign(new Error(messages[code] || messages.decode_failed), { code });
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw fail('invalid_image');
  if (width > QR_IMAGE_LIMITS.side || height > QR_IMAGE_LIMITS.side || width * height > QR_IMAGE_LIMITS.pixels) throw fail('dimensions');
  return { width, height };
}

// Header inspection bounds allocation before invoking a native image codec. It
// does not certify the whole file: the browser must still successfully decode it.
export function inspectQrImageHeader(input, mime = '') {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes) throw fail('invalid_image');
  if (bytes.byteLength > QR_IMAGE_LIMITS.bytes) throw fail('too_large');
  mime = String(mime || '').toLowerCase();
  if (mime && !['image/png', 'image/jpeg'].includes(mime)) throw fail('unsupported_type');
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (png) {
    if (mime && mime !== 'image/png') throw fail('unsupported_type');
    if (bytes.length < 33) throw fail('invalid_image');
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (data.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw fail('invalid_image');
    return { format: 'png', ...dimensions(data.getUint32(16), data.getUint32(20)) };
  }
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw fail('unsupported_type');
  if (mime && mime !== 'image/jpeg') throw fail('unsupported_type');
  let offset = 2, size = null;
  const sof = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) throw fail('invalid_image');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0 || marker === 216) throw fail('invalid_image');
    if (marker === 217) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > bytes.length) throw fail('invalid_image');
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw fail('invalid_image');
    if (sof.has(marker)) {
      if (size || length < 8 || !bytes[offset + 7] || bytes[offset + 7] > 4 || length !== 8 + 3 * bytes[offset + 7]) throw fail('invalid_image');
      size = dimensions((bytes[offset + 5] << 8) | bytes[offset + 6], (bytes[offset + 3] << 8) | bytes[offset + 4]);
    }
    if (marker === 218) {
      if (!size) throw fail('invalid_image');
      return { format: 'jpeg', ...size };
    }
    offset += length;
  }
  throw fail('invalid_image');
}

export async function decodeQrImage(file, { onWorker, signal } = {}) {
  let bitmap, canvas, worker, timer, onAbort;
  const active = () => { if (signal?.aborted) throw fail('aborted'); };
  try {
    active();
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1) throw fail('invalid_file');
    if (file.size > QR_IMAGE_LIMITS.bytes) throw fail('too_large');
    const bytes = new Uint8Array(await file.arrayBuffer());
    active();
    const info = inspectQrImageHeader(bytes, file.type);
    if (typeof globalThis.createImageBitmap !== 'function' || typeof globalThis.Worker !== 'function' || !globalThis.document?.createElement) throw fail('unavailable');
    const scale = Math.min(1, QR_IMAGE_LIMITS.decodeSide / Math.max(info.width, info.height));
    const width = Math.max(1, Math.round(info.width * scale)), height = Math.max(1, Math.round(info.height * scale));
    try { bitmap = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }); }
    catch { throw fail('invalid_image'); }
    active();
    if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1 || bitmap.width > QR_IMAGE_LIMITS.decodeSide || bitmap.height > QR_IMAGE_LIMITS.decodeSide) throw fail('dimensions');
    canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!context) throw fail('unavailable');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!(pixels instanceof Uint8ClampedArray) || pixels.byteLength !== canvas.width * canvas.height * 4) throw fail('decode_failed');
    const buffer = pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength ? pixels.buffer : pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
    try { worker = new Worker('/qr-decoder.worker.js'); } catch { throw fail('unavailable'); }
    onWorker?.(worker);
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, text) => { if (settled) return; settled = true; error ? reject(error) : resolve(text); };
      worker.onmessage = event => {
        const result = event.data;
        if (result?.ok === true && typeof result.text === 'string' && result.text.trim() && result.text.length <= 8192) finish(null, result.text);
        else finish(fail(result?.ok === true ? 'empty_qr' : Object.hasOwn(messages, result?.error) ? result.error : 'decode_failed'));
      };
      worker.onerror = event => { event.preventDefault?.(); finish(fail('decode_failed')); };
      worker.onmessageerror = () => finish(fail('decode_failed'));
      onAbort = () => finish(fail('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(fail('timeout')), QR_IMAGE_LIMITS.workerTimeout);
      if (signal?.aborted) { onAbort(); return; }
      try { worker.postMessage({ width: canvas.width, height: canvas.height, buffer }, [buffer]); }
      catch { finish(fail('decode_failed')); }
    });
  } catch (error) { throw error?.code && Object.hasOwn(messages, error.code) ? error : fail('decode_failed'); }
  finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; try { worker.terminate(); } catch {} }
    try { bitmap?.close(); } catch {}
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
