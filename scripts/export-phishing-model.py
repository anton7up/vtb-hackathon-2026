"""Mechanically export the reviewed sklearn model without retraining it.

Usage: python -B scripts/export-phishing-model.py --source ../phishing-attacks-reference
Requires the model's Python dependencies. No code from the source checkout is imported.
"""
import argparse
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=2000)
    args = parser.parse_args()
    source = args.source.resolve()
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location('checked_phishing_model', root / 'scripts' / 'phishing_model_reader.py')
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    folder = source / 'backend' / 'main' / 'ml' / 'dataset'
    artifact_path = folder / 'phishing_url_model.pkl'
    model = reader.load_checked(artifact_path)
    vectorizer, classifier = model['tfidf'], model['clf']
    expected = {'analyzer': 'char_wb', 'lowercase': True, 'strip_accents': None, 'norm': 'l2', 'binary': False, 'sublinear_tf': False, 'use_idf': True, 'ngram_range': (3, 5)}
    for key, value in expected.items():
        if getattr(vectorizer, key) != value:
            raise ValueError(f'Unsupported vectorizer parameter: {key}')
    if list(model.classes_) != [0, 1] or classifier.coef_.shape != (1, len(vectorizer.vocabulary_)):
        raise ValueError('Unsupported model shape or label convention')
    vocabulary = [None] * len(vectorizer.vocabulary_)
    for text, index in vectorizer.vocabulary_.items():
        if not 0 <= index < len(vocabulary) or vocabulary[index] is not None:
            raise ValueError('Non-dense vocabulary')
        vocabulary[index] = text
    if any(token is None for token in vocabulary):
        raise ValueError('Incomplete vocabulary')
    sha = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    commit = subprocess.check_output(['git', '-c', f'safe.directory={source.as_posix()}', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    exported = {
        'schema_version': 1,
        'model_version': f'phiusiil-tfidf-lr-{sha[:12]}',
        'source': {'repository': 'https://github.com/vadim5222/phishing_attacks', 'commit': commit, 'artifact_sha256': sha},
        'classes': [0, 1],
        'parameters': {**expected, 'ngram_range': [3, 5]},
        'vocabulary': vocabulary,
        'idf': vectorizer.idf_.tolist(),
        'coef': classifier.coef_[0].tolist(),
        'intercept': float(classifier.intercept_[0]),
    }
    target = root / 'lib' / 'phishing-model.json'
    target.write_text(json.dumps(exported, ensure_ascii=True, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')

    # Public synthetic fixtures are safe to commit; real dataset URLs stay in ignored work/.
    synthetic = [
        'https://shop.example/', 'https://SHOP.EXAMPLE/Login?A=B',
        'https://bank-login.example/confirm?account=test', 'http://192.0.2.1/login',
        'https://пример.рф/оплата', 'https://example.com/😀/İ/ΟΣ',
        'https://example.com/?q=äöü', 'https://example.com/#fragment',
        'https://example.com/a%20b', 'https://example.com/a+b',
        'https://example.com/\u001c\u001d', 'https://example.com/\u00a0\t\npath',
        'https://example.com/\u2003\u202fpath', 'https://example.com/\ufeffpath',
        '', 'a', 'A B', ' \t\n ', 'https://example.com/' + 'a' * 2000,
    ]

    def predictions(urls):
        labels = model.predict(urls)
        scores = model.predict_proba(urls)[:, list(model.classes_).index(0)]
        return [{'url': url, 'label': 'phishing' if int(label) == 0 else 'safe', 'phishing_score': float(score)} for url, label, score in zip(urls, labels, scores)]

    fixtures = root / 'tests' / 'fixtures'
    fixtures.mkdir(exist_ok=True)
    (fixtures / 'phishing-synthetic-parity.json').write_text(json.dumps(predictions(synthetic), ensure_ascii=True, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    with (folder / 'phishing.csv').open(encoding='utf-8-sig', newline='') as stream:
        rows = list(csv.DictReader(stream))
    urls = [row['URL'] for row in random.Random(42).sample(rows, min(args.samples, len(rows)))]
    work = root / 'work'
    work.mkdir(exist_ok=True)
    (work / 'phishing-dataset-parity.json').write_text(json.dumps(predictions(urls), ensure_ascii=True, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    print(json.dumps({'model_version': exported['model_version'], 'features': len(vocabulary), 'export_bytes': target.stat().st_size, 'synthetic_cases': len(synthetic), 'dataset_cases': len(urls)}))


if __name__ == '__main__':
    main()
