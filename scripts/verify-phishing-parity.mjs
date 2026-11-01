import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreUrlText } from '../lib/url-phishing-model.mjs';

const path = process.argv[2] || resolve('work/phishing-dataset-parity.json');
const cases = JSON.parse(readFileSync(path, 'utf8'));
let maxError = 0, mismatches = 0;
for (const item of cases) {
  const actual = scoreUrlText(item.url);
  const error = Math.abs(actual.phishing_score - item.phishing_score);
  maxError = Math.max(maxError, error);
  if (actual.label !== item.label || error > 1e-10) mismatches++;
}
console.log(JSON.stringify({ cases: cases.length, mismatches, max_absolute_score_error: maxError }));
if (!cases.length || mismatches) process.exitCode = 1;
