#!/usr/bin/env python3
"""Loopback-only HTTP adapter for the trained transfer fraud model."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pandas as pd

from features import FEATURES, INPUT_COLUMNS, add_features, feature_matrix
from predict_example import MODEL_PATH, load_artifacts

MAX_BODY = 2 * 1024 * 1024
MAX_HISTORY = 10_000
MODEL, T_REVIEW, T_BLOCK = load_artifacts()
MODEL_VERSION = f"fraud-hgb-{hashlib.sha256(Path(MODEL_PATH).read_bytes()).hexdigest()[:12]}"


def _number(value, name: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"invalid_{name}")
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0) or result < 0:
        raise ValueError(f"invalid_{name}")
    return result


def _row(value) -> dict:
    if not isinstance(value, dict) or set(value) != set(INPUT_COLUMNS):
        raise ValueError("invalid_operation")
    timestamp = pd.to_datetime(value["timestamp"], errors="raise", utc=True)
    sender = value["sender_id"]
    receiver = value["receiver_id"]
    if not isinstance(sender, str) or not sender or len(sender) > 80:
        raise ValueError("invalid_sender")
    if not isinstance(receiver, str) or not receiver or len(receiver) > 80:
        raise ValueError("invalid_receiver")
    return {
        "timestamp": timestamp.tz_convert(None),
        "sender_id": sender,
        "sender_balance": _number(value["sender_balance"], "balance"),
        "amount": _number(value["amount"], "amount", positive=True),
        "receiver_id": receiver,
    }


def classify(payload: dict) -> dict:
    if not isinstance(payload, dict) or set(payload) != {"operation", "history"}:
        raise ValueError("invalid_payload")
    history_input = payload["history"]
    if not isinstance(history_input, list) or len(history_input) > MAX_HISTORY:
        raise ValueError("invalid_history")
    operation = _row(payload["operation"])
    history_rows = [_row(item) for item in history_input]
    history = pd.DataFrame(history_rows, columns=INPUT_COLUMNS)
    current = pd.DataFrame([{**operation, "_current": True}])
    history["_current"] = False
    combined = current if history.empty else pd.concat([history[INPUT_COLUMNS + ["_current"]], current], ignore_index=True)
    combined["timestamp"] = pd.to_datetime(combined["timestamp"])
    combined = combined.sort_values(["timestamp", "_current"], kind="stable").reset_index(drop=True)
    scored = add_features(combined)
    last = scored.loc[scored["_current"]].iloc[[-1]]
    probability = float(MODEL.predict_proba(feature_matrix(last))[0, 1])
    if not math.isfinite(probability):
        raise ValueError("invalid_probability")
    decision = 0 if probability < T_REVIEW else 1 if probability < T_BLOCK else 2
    return {
        "decision": decision,
        "p_fraud": probability,
        "model_version": MODEL_VERSION,
        "thresholds": {"review": T_REVIEW, "block": T_BLOCK},
        "features": {name: float(last.iloc[0][name]) for name in FEATURES},
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "TransferModel/1"

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/healthz":
            self._json(404, {"error": "not_found"})
            return
        self._json(200, {"ok": True, "model_version": MODEL_VERSION})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/classify":
            self._json(404, {"error": "not_found"})
            return
        if self.headers.get_content_type() != "application/json":
            self._json(415, {"error": "json_required"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("invalid_size")
            payload = json.loads(self.rfile.read(length))
            self._json(200, classify(payload))
        except (ValueError, TypeError, json.JSONDecodeError):
            self._json(400, {"error": "invalid_request"})
        except Exception:
            self._json(503, {"error": "model_unavailable"})

    def log_message(self, _format: str, *_args) -> None:
        return


def main() -> None:
    host = os.environ.get("TRANSFER_MODEL_HOST", "127.0.0.1")
    port = int(os.environ.get("TRANSFER_MODEL_PORT", "8101"))
    if not ipaddress.ip_address(host).is_loopback:
        raise RuntimeError("TRANSFER_MODEL_HOST must be a loopback address")
    server = ThreadingHTTPServer((host, port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
