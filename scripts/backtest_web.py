#!/usr/bin/env python3
"""
Web 回测轻量包装器 — JSON-in / JSON-out，零文件写入。

供 Node.js API 通过 stdin/stdout 调用，返回格式对齐 web 前端 BacktestResult。
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta  # noqa: F401 (eval 可能用到)

# Ensure project root on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.backtest_runner import _parse_date, run_backtest  # noqa: E402


def build_web_json(trades_df, summary: dict) -> dict:
    """从 run_backtest 返回的 (trades_df, summary) 构建前端兼容 JSON。"""
    nav_df = summary.pop("_nav_df", None)
    bench_df = summary.pop("_benchmark_df", None)
    # Remove internal data-frames (wbt artifacts etc.)
    for key in list(summary.keys()):
        if key.startswith("_") or key.endswith("_df"):
            summary.pop(key, None)

    result: dict = {
        "metrics": _clean_metrics(summary),
    }

    if nav_df is not None and not nav_df.empty:
        result["dates"] = nav_df["date"].apply(lambda d: d.isoformat() if hasattr(d, "isoformat") else str(d)).tolist()
        result["nav"] = nav_df["nav"].tolist()
    else:
        result["dates"] = []
        result["nav"] = []

    if bench_df is not None and not bench_df.empty and "benchmark_nav" in bench_df.columns:
        result["benchmark_nav"] = bench_df["benchmark_nav"].tolist()

    if trades_df is not None and not trades_df.empty:
        result["trades"] = trades_df.to_dict(orient="records")

    return result


def _fmt(v) -> str | float | None:
    """Convert numpy/Decimal values to plain Python types."""
    if v is None:
        return None
    if isinstance(v, (int, float, str)):
        return v
    try:
        fv = float(v)
        return round(fv, 6) if abs(fv) < 1e6 else fv
    except (TypeError, ValueError):
        return str(v)


def _clean_metrics(d: dict) -> dict:
    """Recursively convert all values in dict to JSON-safe types."""
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out[k] = _clean_metrics(v)
        elif isinstance(v, (list, tuple)):
            out[k] = [_fmt(x) for x in v]
        else:
            out[k] = _fmt(v)
    return out


def _parse_backtest_config(cfg: dict) -> dict:
    """从 JSON 配置中提取回测参数，返回规范化的参数字典。"""
    return {
        "start_dt": _parse_date(cfg.get("start", "")),
        "end_dt": _parse_date(cfg.get("end", "")),
        "hold_days": int(cfg.get("hold_days", 30) or 30),
        "top_n": int(cfg.get("top_n", 0) or 0),
        "board": str(cfg.get("board", "main_chinext") or "main_chinext").strip().lower(),
        "sample_size": int(cfg.get("sample_size", 0) or 0),
        "trading_days": int(cfg.get("trading_days", 320) or 320),
        "max_workers": int(cfg.get("max_workers", 8) or 8),
        "exit_mode": str(cfg.get("exit_mode", "sltp") or "sltp").strip().lower(),
        "stop_loss_pct": float(cfg.get("stop_loss_pct", -7.0) if cfg.get("stop_loss_pct") is not None else -7.0),
        "take_profit_pct": float(cfg.get("take_profit_pct", 18.0) if cfg.get("take_profit_pct") is not None else 18.0),
        "trailing_stop_pct": float(
            cfg.get("trailing_stop_pct", 0.0) if cfg.get("trailing_stop_pct") is not None else 0.0
        ),
        "trailing_activate_pct": float(
            cfg.get("trailing_activate_pct", 0.0) if cfg.get("trailing_activate_pct") is not None else 0.0
        ),
        "regime_filter": bool(cfg.get("regime_filter", False)),
    }


def main() -> int:
    try:
        raw = sys.stdin.read()
        cfg = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError) as exc:
        result = {"error": f"Invalid input JSON: {exc}"}
        print(json.dumps(result, ensure_ascii=False))
        return 1

    try:
        params = _parse_backtest_config(cfg)
    except (ValueError, TypeError) as exc:
        result = {"error": f"Invalid date format (use YYYY-MM-DD): {exc}"}
        print(json.dumps(result, ensure_ascii=False))
        return 1

    trades_df, summary = run_backtest(**params)

    result = build_web_json(trades_df, summary)
    print(json.dumps(result, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
