import artifact from './phishing-model.json' with { type: 'json' };

export class UrlModelError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Python str.split()/re '\s': deliberately not JavaScript's different '\s' set.
const PYTHON_SPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
const sigmoid = value => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));

export function createUrlScorer(model) {
  const p = model?.parameters;
  const size = model?.vocabulary?.length;
  if (model?.schema_version !== 1 || model.classes?.join(',') !== '0,1' || !size || size > 20000 || model.idf?.length !== size || model.coef?.length !== size || typeof model.model_version !== 'string' || !Number.isFinite(model.intercept) || p?.analyzer !== 'char_wb' || p.lowercase !== true || p.strip_accents !== null || p.norm !== 'l2' || p.binary !== false || p.sublinear_tf !== false || p.use_idf !== true || p.ngram_range?.join(',') !== '3,5') throw new UrlModelError('model_unavailable');
  const vocabulary = new Map();
  for (let i = 0; i < size; i++) {
    if (typeof model.vocabulary[i] !== 'string' || vocabulary.has(model.vocabulary[i]) || !Number.isFinite(model.idf[i]) || model.idf[i] <= 0 || !Number.isFinite(model.coef[i])) throw new UrlModelError('model_unavailable');
    vocabulary.set(model.vocabulary[i], i);
  }
  return text => {
    if (typeof text !== 'string' || text.length > 4096) throw new UrlModelError('invalid_url');
    const counts = new Map();
    for (const word of text.toLowerCase().split(PYTHON_SPACE).filter(Boolean)) {
      const padded = [' ', ...word, ' ']; // Python uses Unicode code points, not UTF-16 units.
      for (let n = 3; n <= 5; n++) {
        let offset = 0;
        const add = start => {
          const index = vocabulary.get(padded.slice(start, start + n).join(''));
          if (index !== undefined) counts.set(index, (counts.get(index) || 0) + 1);
        };
        add(0);
        while (offset + n < padded.length) { offset++; add(offset); }
        if (offset === 0) break;
      }
    }
    let normSquared = 0, weightedSum = 0;
    for (const [index, count] of counts) {
      const tfidf = count * model.idf[index];
      normSquared += tfidf * tfidf;
      weightedSum += tfidf * model.coef[index];
    }
    const decision = model.intercept + (normSquared > 0 ? weightedSum / Math.sqrt(normSquared) : 0);
    const score = sigmoid(-decision); // Original label 0 = phishing; label 1 = legitimate.
    if (!Number.isFinite(score)) throw new UrlModelError('model_unavailable');
    return { label: decision > 0 ? 'safe' : 'phishing', phishing_score: score, model_version: model.model_version, source: 'ml', input_type: 'url_only' };
  };
}

let scorer;
export function scoreUrlText(text) {
  scorer ??= createUrlScorer(artifact);
  return scorer(text);
}

export function normalizeCheckUrl(value) {
  if (typeof value !== 'string') throw new UrlModelError('invalid_url');
  const text = value.trim();
  if (!text || text.length > 2048 || /[\u0000-\u0020\u007f-\u009f]/u.test(text) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(text)) throw new UrlModelError('invalid_url');
  let parsed;
  try { parsed = new URL(text); } catch { throw new UrlModelError('invalid_url'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !/^https?:\/\//i.test(text) || !parsed.hostname || parsed.username || parsed.password) throw new UrlModelError('invalid_url');
  // The model receives the input text, not a differently normalized URL.href.
  // No DNS lookup or request to the target is made, including for IP/local hosts.
  return text;
}

export function checkPhishingUrl(value) {
  return { ...scoreUrlText(normalizeCheckUrl(value)), checked_at: Date.now() };
}
