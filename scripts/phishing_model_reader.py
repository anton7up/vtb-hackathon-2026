"""Restricted offline reader for the specific reviewed TF-IDF/LogReg artifact.

Not a general pickle sandbox. Never expose this as an upload endpoint.
Unknown globals and object arrays are rejected; only trusted team artifacts
should be processed, under normal OS resource limits.
"""
import collections
import math
import numpy as np
from joblib.numpy_pickle import NumpyArrayWrapper, NumpyUnpickler
from sklearn.feature_extraction.text import TfidfTransformer, TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline


class NumericArrayWrapper(NumpyArrayWrapper):
    def read_array(self, unpickler, *args, **kwargs):
        if self.dtype.hasobject or len(self.shape) > 2 or math.prod(self.shape) > 2_000_000:
            raise ValueError('Unsupported array in model artifact')
        return super().read_array(unpickler, *args, **kwargs)


class PipelineUnpickler(NumpyUnpickler):
    def find_class(self, module, name):
        allowed = {
            ('sklearn.pipeline', 'Pipeline'): Pipeline,
            ('sklearn.feature_extraction.text', 'TfidfVectorizer'): TfidfVectorizer,
            ('sklearn.feature_extraction.text', 'TfidfTransformer'): TfidfTransformer,
            ('sklearn.linear_model._logistic', 'LogisticRegression'): LogisticRegression,
            ('joblib.numpy_pickle', 'NumpyArrayWrapper'): NumericArrayWrapper,
            ('numpy', 'ndarray'): np.ndarray,
            ('numpy', 'dtype'): np.dtype,
            ('numpy', 'float64'): np.float64,
            ('numpy', 'int64'): np.int64,
            ('numpy._core.multiarray', 'scalar'): np._core.multiarray.scalar,
            ('numpy.core.multiarray', 'scalar'): np._core.multiarray.scalar,
            ('numpy._core.multiarray', '_reconstruct'): np._core.multiarray._reconstruct,
            ('numpy.core.multiarray', '_reconstruct'): np._core.multiarray._reconstruct,
            ('collections', 'defaultdict'): collections.defaultdict,
            ('builtins', 'set'): set,
            ('builtins', 'frozenset'): frozenset,
            ('builtins', 'int'): int,
        }
        if (module, name) not in allowed:
            raise ValueError(f'Unsupported model global: {module}.{name}')
        return allowed[module, name]


def load_checked(path):
    if path.stat().st_size > 5_000_000:
        raise ValueError('Unexpected artifact size')
    with path.open('rb') as stream:
        model = PipelineUnpickler(str(path), stream, ensure_native_byte_order=True).load()
    if type(model) is not Pipeline or [name for name, _ in model.steps] != ['tfidf', 'clf']:
        raise ValueError('Unexpected pipeline')
    if type(model['tfidf']) is not TfidfVectorizer or type(model['clf']) is not LogisticRegression:
        raise ValueError('Unexpected estimator types')
    if model['tfidf'].analyzer != 'char_wb' or model['tfidf'].preprocessor is not None or model['tfidf'].tokenizer is not None:
        raise ValueError('Unexpected text processing')
    return model
