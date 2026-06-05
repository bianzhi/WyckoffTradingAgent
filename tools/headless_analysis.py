"""Phase 1.2 — Headless stock analysis tool.

Called by the web API to run Wyckoff diagnosis without LLM.
Outputs JSON to stdout.

Usage: python tools/headless_analysis.py 600519
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from datetime import date, timedelta

import pandas as pd

from core.holding_diagnostic import diagnose_one_stock
from integrations.stock_hist_repository import get_stock_hist


def _safe_float(v, default=0.0):
    """安全 float 转换，pd.NA/NaN/None → default。"""
    import builtins

    try:
        if v is None:
            return default
        if pd.isna(v):
            return default
        if isinstance(v, (int, float)):
            try:
                if v != v:
                    return default
            except Exception:
                pass
            return builtins.float(v)
        return builtins.float(v)
    except (TypeError, ValueError, AttributeError):
        return default


def _safe_value(v):
    """Convert numpy/pandas types to JSON-safe Python types."""
    import numpy as np

    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return _safe_float(v)
    if isinstance(v, (pd.Timestamp,)):
        return str(v)
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


def _diag_to_dict(diag):
    """Convert HoldingDiagnostic dataclass to JSON-safe dict."""
    d = asdict(diag)
    return {k: _safe_value(v) for k, v in d.items()}


def run(code: str) -> dict:
    """Run headless diagnosis for a single stock code."""
    code = code.strip()
    if not code:
        return {"error": "code is required"}

    end = date.today()
    start = end - timedelta(days=400)

    try:
        df = get_stock_hist(symbol=code, start=start, end=end)
    except Exception as e:
        return {"error": f"get_stock_hist failed: {e}"}

    if df is None or df.empty:
        return {"error": f"no data for {code}"}

    try:
        diag = diagnose_one_stock(code=code, name=code, cost=0.0, df=df)
    except Exception as e:
        return {"error": f"diagnosis failed: {e}"}

    return {"diagnosis": _diag_to_dict(diag)}


if __name__ == "__main__":
    code = sys.argv[1] if len(sys.argv) > 1 else ""
    result = run(code)
    print(json.dumps(result, default=str, ensure_ascii=False))
