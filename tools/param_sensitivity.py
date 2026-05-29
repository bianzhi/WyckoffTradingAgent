"""
参数敏感性分析：逐参数变动 → 观察胜率/夏普/最大回撤变化。
用于回测策略的参数健壮性评估。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ── 内部指标计算 ────────────────────────────────────────


def _calc_metrics(trades: pd.DataFrame) -> dict[str, float]:
    """计算胜率/夏普/最大回撤。"""
    if trades.empty or "ret_pct" not in trades.columns:
        return {"win_rate": 0, "sharpe": 0, "max_dd": 0, "avg_ret": 0, "n_trades": 0}
    rets = trades["ret_pct"].dropna().astype(float)
    n = len(rets)
    if n == 0:
        return {"win_rate": 0, "sharpe": 0, "max_dd": 0, "avg_ret": 0, "n_trades": 0}
    wr = float((rets > 0).mean() * 100)
    avg = float(rets.mean())
    std = float(rets.std())
    sharpe = float(avg / std * np.sqrt(252)) if std > 0 else 0.0
    # 最大回撤：用累计收益曲线
    cum = (1 + rets / 100).cumprod()
    peak = cum.expanding().max()
    dd = (cum / peak - 1) * 100
    mdd = float(dd.min())
    return {
        "win_rate": round(wr, 2),
        "sharpe": round(sharpe, 3),
        "max_dd": round(mdd, 2),
        "avg_ret": round(avg, 3),
        "n_trades": n,
    }


# ── 过滤交易 ───────────────────────────────────────────


def _filter_trades(trades: pd.DataFrame, params: dict[str, float]) -> pd.DataFrame:
    """根据参数过滤交易（score 阈值等）。"""
    df = trades.copy()
    if "score" in df.columns and "min_score" in params:
        df = df[df["score"] >= params["min_score"]]
    if "min_vol_ratio" in params and "vol_ratio" in df.columns:
        df = df[df["vol_ratio"] >= params["min_vol_ratio"]]
    if "max_ret_pct" in params:
        df = df[df["ret_pct"] <= params["max_ret_pct"]]
    if "min_ret_pct" in params:
        df = df[df["ret_pct"] >= params["min_ret_pct"]]
    return df


# ── 参数分布 ───────────────────────────────────────────


@dataclass
class SensitivityPoint:
    param_name: str
    param_value: float
    win_rate: float
    sharpe: float
    max_dd: float
    avg_ret: float
    n_trades: int


def _run_single_param_sweep(
    trades: pd.DataFrame,
    param_name: str,
    values: list[float],
    baseline_params: dict[str, float],
) -> list[SensitivityPoint]:
    """对单个参数做 sweep。"""
    points: list[SensitivityPoint] = []
    for v in values:
        test_params = {**baseline_params, param_name: v}
        filtered = _filter_trades(trades, test_params)
        m = _calc_metrics(filtered)
        points.append(
            SensitivityPoint(
                param_name=param_name,
                param_value=v,
                win_rate=m["win_rate"],
                sharpe=m["sharpe"],
                max_dd=m["max_dd"],
                avg_ret=m["avg_ret"],
                n_trades=m["n_trades"],
            )
        )
    return points


# ── 主分析函数 ─────────────────────────────────────────


def _default_param_grid() -> dict[str, list[float]]:
    """默认参数搜索空间。"""
    return {
        "min_score": [0.0, 0.05, 0.10, 0.15, 0.20, 0.25],
        "min_vol_ratio": [0.0, 0.5, 1.0, 1.5, 2.0],
        "max_ret_pct": [5, 10, 15, 20, 999],
        "min_ret_pct": [-999, -5, -3, 0],
    }


def _sweep_all_params(
    trades: pd.DataFrame,
    param_grid: dict[str, list[float]],
    baseline: dict[str, float],
) -> tuple[list[dict], dict[str, float]]:
    """对所有参数逐项 sweep，返回 sensitivity 列表和 impact 分数。"""
    sensitivity: list[dict] = []
    impacts: dict[str, float] = {}
    for param_name, values in param_grid.items():
        points = _run_single_param_sweep(trades, param_name, values, baseline)
        if not points:
            continue
        sharpes = [p.sharpe for p in points]
        sharpe_range = max(sharpes) - min(sharpes)
        wr_range = max(p.win_rate for p in points) - min(p.win_rate for p in points)
        impacts[param_name] = round(sharpe_range + wr_range * 0.1, 3)
        sensitivity.append(_build_sweep_result(param_name, points, sharpe_range, wr_range))
    return sensitivity, impacts


def _build_sweep_result(
    param_name: str,
    points: list[SensitivityPoint],
    sharpe_range: float,
    wr_range: float,
) -> dict:
    """构建单个参数的 sweep 结果。"""
    return {
        "param": param_name,
        "points": [
            {
                "value": p.param_value,
                "win_rate": p.win_rate,
                "sharpe": p.sharpe,
                "max_dd": p.max_dd,
                "avg_ret": p.avg_ret,
                "n_trades": p.n_trades,
            }
            for p in points
        ],
        "sharpe_range": round(sharpe_range, 3),
        "win_rate_range": round(wr_range, 2),
    }


def run_param_sensitivity(
    trades: list[dict] | pd.DataFrame,
    param_grid: dict[str, list[float]] | None = None,
) -> dict[str, Any]:
    """执行参数敏感性分析。

    Args:
        trades: 回测交易记录 [{ret_pct, score, vol_ratio}, ...]
        param_grid: 参数搜索空间，如 {"min_score": [0.05, 0.1, 0.15]}
    """
    if isinstance(trades, list):
        if not trades:
            return {"error": "交易记录为空"}
        trades = pd.DataFrame(trades)
    if trades.empty:
        return {"error": "交易记录为空"}
    if "ret_pct" not in trades.columns:
        return {"error": "缺少 ret_pct 列"}

    grid = param_grid or _default_param_grid()
    baseline_metrics = _calc_metrics(trades)
    baseline_params = {k: grid[k][0] for k in grid}
    sensitivity, impacts = _sweep_all_params(trades, grid, baseline_params)
    ranked = sorted(impacts.items(), key=lambda x: x[1], reverse=True)

    return {
        "baseline": baseline_metrics,
        "sensitivity": sensitivity,
        "param_sensitivity_rank": [{"param": p, "impact_score": v} for p, v in ranked],
        "most_sensitive": ranked[0][0] if ranked else None,
        "least_sensitive": ranked[-1][0] if ranked else None,
    }
