"""
自适应参数调优工具：根据大盘水温自动调整漏斗参数。

分析基准指数（上证/小盘），计算市场广度，输出 regime 分类
和漏斗参数调优建议。提供"原始 vs 调优后"参数对照。
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta

import pandas as pd

from core.wyckoff_engine import FunnelConfig
from integrations.data_source import fetch_stock_hist
from tools.market_regime import (
    analyze_benchmark_and_tune_cfg,
    calc_market_breadth,
)

BENCH_CODE = "000001"  # 上证指数
SMALLCAP_CODE = "399006"  # 创业板指（小盘代表）


def _default_cfg() -> FunnelConfig:
    """构建默认 FunnelConfig（调优前基准）。"""
    c = FunnelConfig()
    return c


def _cfg_before_after(cfg_original: FunnelConfig, cfg_tuned: FunnelConfig) -> dict:
    """提取核心调优参数的前后对比。"""
    keys = [
        "min_avg_amount_wan",
        "rs_min_long",
        "rs_min_short",
        "rps_fast_min",
        "rps_slow_min",
        "enable_evr_trigger",
    ]
    before = {}
    after = {}
    changed = {}
    for k in keys:
        v_before = getattr(cfg_original, k, None)
        v_after = getattr(cfg_tuned, k, None)
        before[k] = v_before
        after[k] = v_after
        changed[k] = v_before != v_after
    return {"before": before, "after": after, "changed": changed}


def _compute_breadth_or_none(
    bench_df: pd.DataFrame | None, smallcap_df: pd.DataFrame | None
) -> tuple[dict | None, str | None]:
    """计算市场广度，若数据不足则返回 None + 说明。"""
    if bench_df is None or bench_df.empty or smallcap_df is None or smallcap_df.empty:
        return None, "市场广度数据不足，使用纯指数分析"
    try:
        df_map = {BENCH_CODE: bench_df, SMALLCAP_CODE: smallcap_df}
        return calc_market_breadth(df_map), None
    except Exception:
        return None, "市场广度数据不足，使用纯指数分析"


def _build_tuning_payload(context: dict, cfg_original: FunnelConfig, cfg_tuned: FunnelConfig, breadth_msg: str | None) -> dict:
    """从 context 构建标准化调优报告 payload。"""
    return {
        "regime": context.get("regime", "UNKNOWN"),
        "market_context": {
            "main_code": context.get("main_code"),
            "close": context.get("close"),
            "ma50": context.get("ma50"),
            "ma200": context.get("ma200"),
            "ma50_slope_5d": context.get("ma50_slope_5d"),
            "recent3_cum_pct": context.get("recent3_cum_pct"),
            "main_volume_state": context.get("main_volume_state"),
            "main_vol_ratio_5_20": context.get("main_vol_ratio_5_20"),
            "smallcap_code": context.get("smallcap_code"),
            "smallcap_close": context.get("smallcap_close"),
            "smallcap_today_pct": context.get("smallcap_today_pct"),
            "smallcap_recent3_cum_pct": context.get("smallcap_recent3_cum_pct"),
        },
        "panic": {"triggered": context.get("panic_triggered", False), "reasons": context.get("panic_reasons", [])},
        "repair": {"triggered": context.get("repair_triggered", False), "reasons": context.get("repair_reasons", [])},
        "breadth": context.get("breadth", {}),
        "breadth_note": breadth_msg,
        "outlook": context.get("market_pv_outlook", ""),
        "outlook_summary": context.get("market_pv_summary", ""),
        "tuned_params": context.get("tuned", {}),
        "before_after": _cfg_before_after(cfg_original, cfg_tuned),
    }


def generate_tuning_report(
    bench_df: pd.DataFrame | None = None,
    smallcap_df: pd.DataFrame | None = None,
) -> dict:
    """生成自适应参数调优报告。"""
    cfg_original = _default_cfg()
    cfg_tuned = FunnelConfig()

    breadth, breadth_msg = _compute_breadth_or_none(bench_df, smallcap_df)

    context = analyze_benchmark_and_tune_cfg(
        bench_df=bench_df, smallcap_df=smallcap_df, cfg=cfg_tuned, breadth=breadth,
    )
    return _build_tuning_payload(context, cfg_original, cfg_tuned, breadth_msg)


def fetch_and_tune(
    bench_code: str = BENCH_CODE,
    smallcap_code: str = SMALLCAP_CODE,
    lookback_days: int = 252,
) -> dict:
    """
    拉取数据 + 调优一步完成。

    供 API 层直接调用。
    """
    end = date.today()
    start = end - timedelta(days=lookback_days + 30)

    bench_df = None
    smallcap_df = None
    fetch_errors = []

    try:
        df = fetch_stock_hist(bench_code, start, end, adjust="qfq")
        if df is not None and not df.empty:
            bench_df = df
        else:
            fetch_errors.append(f"{bench_code}: 无数据")
    except Exception as e:
        fetch_errors.append(f"{bench_code}: {e}")

    try:
        df = fetch_stock_hist(smallcap_code, start, end, adjust="qfq")
        if df is not None and not df.empty:
            smallcap_df = df
        else:
            fetch_errors.append(f"{smallcap_code}: 无数据")
    except Exception as e:
        fetch_errors.append(f"{smallcap_code}: {e}")

    if bench_df is None and smallcap_df is None:
        return {"error": "无法获取任何基准指数数据", "fetch_errors": fetch_errors}

    report = generate_tuning_report(bench_df, smallcap_df)
    report["fetch_errors"] = fetch_errors
    return report


# ── CLI 入口 ──────────────────────────────────────────────

if __name__ == "__main__":
    bc = sys.argv[1] if len(sys.argv) > 1 else BENCH_CODE
    sc = sys.argv[2] if len(sys.argv) > 2 else SMALLCAP_CODE
    ld = int(sys.argv[3]) if len(sys.argv) > 3 else 252

    report = fetch_and_tune(bc, sc, ld)
    print(json.dumps(report, ensure_ascii=False, default=str), flush=True)
