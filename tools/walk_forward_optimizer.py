"""
Walk-Forward 优化器：滚动窗口参数寻优 + 样本外验证。

核心算法：
1. 将历史区间切分为 N 个滚动窗口（训练窗 / 测试窗）
2. 在每个训练窗内网格搜索最优参数（最大化夏普比）
3. 用训练窗最优参数在测试窗运行回测
4. 聚合全部样本外结果，报告参数稳定性
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class WalkForwardWindow:
    train_start: date
    train_end: date
    test_start: date
    test_end: date
    best_params: dict[str, float] = field(default_factory=dict)
    train_sharpe: float = 0.0
    train_win_rate: float = 0.0
    test_sharpe: float = 0.0
    test_win_rate: float = 0.0
    test_trades: int = 0
    test_max_dd: float = 0.0


def _generate_windows(
    start: date,
    end: date,
    train_months: int = 12,
    test_months: int = 3,
    step_months: int = 3,
) -> list[WalkForwardWindow]:
    """生成滚动窗口列表。"""
    windows: list[WalkForwardWindow] = []
    cursor = start
    while True:
        train_end = cursor + timedelta(days=train_months * 30)
        test_end = train_end + timedelta(days=test_months * 30)
        if test_end > end:
            break
        windows.append(WalkForwardWindow(
            train_start=cursor,
            train_end=train_end,
            test_start=train_end + timedelta(days=1),
            test_end=test_end,
        ))
        cursor += timedelta(days=step_months * 30)
    return windows


def _grid_search_single_window(
    trades_df: pd.DataFrame,
    param_grid: dict[str, list[float]],
    train_start: date,
    train_end: date,
) -> tuple[dict[str, float], float, float]:
    """在单个训练窗内网格搜索最优参数。返回 (best_params, sharpe, win_rate)。"""
    train = trades_df[
        (trades_df["signal_date"] >= pd.Timestamp(train_start))
        & (trades_df["signal_date"] <= pd.Timestamp(train_end))
    ]
    if len(train) < 10:
        return ({}, 0.0, 0.0)

    param_keys = list(param_grid.keys())
    if not param_keys:
        return ({}, _calc_sharpe(train["ret_pct"]), _calc_win_rate(train["ret_pct"]))

    best_score = -999.0
    best_params: dict[str, float] = {}
    best_sharpe = 0.0
    best_wr = 0.0

    grids = [param_grid[k] for k in param_keys]
    from itertools import product as _product

    for combo in _product(*grids):
        params = dict(zip(param_keys, combo))
        filtered = _apply_params(train, params)
        if len(filtered) < 5:
            continue
        sharpe = _calc_sharpe(filtered["ret_pct"])
        wr = _calc_win_rate(filtered["ret_pct"])
        score = sharpe * 0.6 + wr * 0.4  # 权衡夏普 + 胜率
        if score > best_score:
            best_score = score
            best_params = params
            best_sharpe = sharpe
            best_wr = wr

    return (best_params, best_sharpe, best_wr)


def _apply_params(trades: pd.DataFrame, params: dict[str, float]) -> pd.DataFrame:
    """根据参数过滤/调整交易记录（模拟参数对信号的影响）。"""
    filtered = trades.copy()
    if "min_score" in params and "score" in filtered.columns:
        filtered = filtered[filtered["score"] >= params["min_score"]]
    if "max_dd_filter" in params and "ret_pct" in filtered.columns:
        filtered = filtered[filtered["ret_pct"] >= params["max_dd_filter"] / 100]
    return filtered


def _calc_sharpe(returns: pd.Series) -> float:
    s = pd.to_numeric(returns, errors="coerce").dropna()
    if len(s) < 2 or s.std() == 0:
        return 0.0
    return float(s.mean() / s.std() * np.sqrt(252))


def _calc_win_rate(returns: pd.Series) -> float:
    s = pd.to_numeric(returns, errors="coerce").dropna()
    if len(s) == 0:
        return 0.0
    return float((s > 0).sum() / len(s) * 100)


def _calc_max_drawdown(returns: pd.Series) -> float:
    s = pd.to_numeric(returns, errors="coerce").dropna()
    if len(s) == 0:
        return 0.0
    cum = (1 + s / 100).cumprod()
    peak = cum.cummax()
    dd = (cum - peak) / peak * 100
    return float(abs(dd.min()))


def run_walk_forward(
    trades_df: pd.DataFrame,
    param_grid: dict[str, list[float]],
    start: date,
    end: date,
    train_months: int = 12,
    test_months: int = 3,
    step_months: int = 3,
) -> dict[str, Any]:
    """
    执行 Walk-Forward 优化。

    参数
    - trades_df: 回测交易记录，需含 signal_date / ret_pct / score 列
    - param_grid: 参数搜索空间，如 {"min_score": [0.1, 0.15, 0.2]}
    - start/end: 整体时间区间

    返回
    - windows: 各窗口明细
    - oos_sharpe: 样本外平均夏普比
    - oos_win_rate: 样本外平均胜率
    - param_stability: 各参数标准差的均值（越小越稳定）
    - recommendation: 推荐参数（各窗口中位数）
    """
    if trades_df.empty or "ret_pct" not in trades_df.columns:
        return {"error": "trades_df 为空或缺少 ret_pct 列"}
    if "signal_date" not in trades_df.columns:
        return {"error": "trades_df 缺少 signal_date 列"}

    trades_df = trades_df.copy()
    trades_df["signal_date"] = pd.to_datetime(trades_df["signal_date"], errors="coerce")
    trades_df = trades_df.dropna(subset=["signal_date"])

    windows = _generate_windows(start, end, train_months, test_months, step_months)
    if len(windows) < 2:
        return {"error": f"时间区间不够拆分窗口，至少需要 {train_months + test_months} 个月"}

    oos_returns: list[float] = []
    all_params: dict[str, list[float]] = {}

    for w in windows:
        best_p, train_sharpe, train_wr = _grid_search_single_window(
            trades_df, param_grid, w.train_start, w.train_end
        )
        w.best_params = best_p
        w.train_sharpe = train_sharpe
        w.train_win_rate = train_wr

        test_trades = trades_df[
            (trades_df["signal_date"] >= pd.Timestamp(w.test_start))
            & (trades_df["signal_date"] <= pd.Timestamp(w.test_end))
        ]
        filtered_test = _apply_params(test_trades, best_p)
        if len(filtered_test) >= 3:
            w.test_sharpe = _calc_sharpe(filtered_test["ret_pct"])
            w.test_win_rate = _calc_win_rate(filtered_test["ret_pct"])
            w.test_max_dd = _calc_max_drawdown(filtered_test["ret_pct"])
            w.test_trades = len(filtered_test)
            oos_returns.append(filtered_test["ret_pct"].mean())

        for k, v in best_p.items():
            all_params.setdefault(k, []).append(v)

    n_windows = len(windows)
    oos_sharpe = float(np.mean([w.test_sharpe for w in windows])) if n_windows else 0.0
    oos_win_rate = float(np.mean([w.test_win_rate for w in windows])) if n_windows else 0.0

    param_stability = {}
    recommendation = {}
    for k, vals in all_params.items():
        if len(vals) >= 2:
            param_stability[k] = float(np.std(vals))
        recommendation[k] = float(np.median(vals))

    return {
        "n_windows": n_windows,
        "oos_sharpe": round(oos_sharpe, 3),
        "oos_win_rate_pct": round(oos_win_rate, 2),
        "param_stability": {k: round(v, 4) for k, v in param_stability.items()},
        "recommendation": {k: round(v, 4) for k, v in recommendation.items()},
        "windows": [
            {
                "train": f"{w.train_start} ~ {w.train_end}",
                "test": f"{w.test_start} ~ {w.test_end}",
                "best_params": w.best_params,
                "train_sharpe": round(w.train_sharpe, 3),
                "train_wr_pct": round(w.train_win_rate, 2),
                "test_sharpe": round(w.test_sharpe, 3),
                "test_wr_pct": round(w.test_win_rate, 2),
                "test_trades": w.test_trades,
                "test_max_dd_pct": round(w.test_max_dd, 2),
            }
            for w in windows
        ],
    }
