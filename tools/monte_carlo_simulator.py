"""
Monte Carlo 模拟器：基于历史交易收益分布，生成概率化未来情景。

两种模式：
1. Bootstrap 重采样：从历史交易中有放回抽样，保持原始分布形态
2. Parametric 参数法：拟合正态/偏态分布后采样（适合交易数较少时）

输出：
- 权益曲线百分位带（5th / 25th / 50th / 75th / 95th）
- 最终权益分布
- VaR95 / CVaR95
- 盈利概率 / 破产概率
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class MonteCarloResult:
    n_simulations: int
    n_trades_per_run: int
    initial_capital: float
    # 最终权益分位数
    final_equity_p5: float
    final_equity_p25: float
    final_equity_p50: float
    final_equity_p75: float
    final_equity_p95: float
    # 最大回撤分位数
    max_dd_p50: float
    max_dd_p95: float
    # 风险指标
    var95_pct: float
    cvar95_pct: float
    prob_profit: float
    prob_ruin_20pct: float  # 回撤超 20% 的概率
    # 权益曲线百分位（用于画图）
    equity_bands: dict[str, list[float]]


def _bootstrap_returns(
    returns: np.ndarray,
    n_trades: int,
    n_simulations: int,
    seed: int = 42,
) -> np.ndarray:
    """Bootstrap 采样：shape (n_simulations, n_trades)"""
    rng = np.random.default_rng(seed)
    indices = rng.integers(0, len(returns), size=(n_simulations, n_trades))
    return returns[indices]


def _build_equity_curves(
    sampled_returns: np.ndarray,
    initial_capital: float,
) -> np.ndarray:
    """将收益率序列转为权益曲线。shape: (n_sim, n_trades+1)"""
    cum_ret = np.cumprod(1 + sampled_returns / 100, axis=1)
    curves = np.zeros((sampled_returns.shape[0], sampled_returns.shape[1] + 1))
    curves[:, 0] = initial_capital
    curves[:, 1:] = initial_capital * cum_ret
    return curves


def _compute_percentile_bands(curves: np.ndarray) -> dict[str, list[float]]:
    """计算权益曲线各百分位带。"""
    p5 = np.percentile(curves, 5, axis=0)
    p25 = np.percentile(curves, 25, axis=0)
    p50 = np.percentile(curves, 50, axis=0)
    p75 = np.percentile(curves, 75, axis=0)
    p95 = np.percentile(curves, 95, axis=0)
    return {
        "p5": [round(float(x), 2) for x in p5],
        "p25": [round(float(x), 2) for x in p25],
        "p50": [round(float(x), 2) for x in p50],
        "p75": [round(float(x), 2) for x in p75],
        "p95": [round(float(x), 2) for x in p95],
    }


def _compute_max_drawdowns(curves: np.ndarray) -> np.ndarray:
    """计算每条权益曲线的最大回撤(%)。"""
    peak = np.maximum.accumulate(curves, axis=1)
    dd = (curves - peak) / peak * 100
    return np.min(dd, axis=1)


def run_monte_carlo(
    trade_returns: list[float],
    n_simulations: int = 5000,
    n_trades_per_run: int = 100,
    initial_capital: float = 100000.0,
    mode: str = "bootstrap",
    seed: int = 42,
) -> dict[str, Any]:
    """
    执行 Monte Carlo 模拟。

    参数
    - trade_returns: 历史交易收益列表（单位：%，如 [5.2, -3.1, 8.7]）
    - n_simulations: 模拟次数（默认 5000）
    - n_trades_per_run: 每次模拟的交易次数
    - initial_capital: 初始资金
    - mode: "bootstrap" | "parametric"

    返回
    - 完整的 MonteCarlo 统计结果
    """
    if not trade_returns or len(trade_returns) < 5:
        return {"error": "交易样本不足（至少需要 5 笔交易）"}

    returns_arr = np.array(trade_returns, dtype=np.float64)
    returns_arr = returns_arr[np.isfinite(returns_arr)]

    if len(returns_arr) < 5:
        return {"error": "有效交易样本不足（去除无效值后 < 5）"}

    if mode == "parametric":
        mu = float(np.mean(returns_arr))
        sigma = float(np.std(returns_arr))
        # 加入偏度调整
        skew = float(_calc_skewness(returns_arr))
        rng = np.random.default_rng(seed)
        # 偏态正态近似: 使用 skew-normal 或 Johnson SU
        # 简化: 用混合法拟合两端肥尾
        sampled = np.zeros((n_simulations, n_trades_per_run))
        for i in range(n_simulations):
            base = rng.normal(mu, sigma, n_trades_per_run)
            # 偏度调整: 对正偏分布加大正收益概率
            adjusted = base + skew * (np.abs(base) / sigma) * 0.3
            sampled[i] = adjusted
    else:
        sampled = _bootstrap_returns(returns_arr, n_trades_per_run, n_simulations, seed)

    curves = _build_equity_curves(sampled, initial_capital)
    final_equities = curves[:, -1]
    equity_bands = _compute_percentile_bands(curves)
    max_dds = _compute_max_drawdowns(curves)

    final_ret_pct = (final_equities - initial_capital) / initial_capital * 100

    return {
        "n_simulations": n_simulations,
        "n_trades_per_run": n_trades_per_run,
        "initial_capital": initial_capital,
        "final_equity_p5": round(float(np.percentile(final_equities, 5)), 2),
        "final_equity_p25": round(float(np.percentile(final_equities, 25)), 2),
        "final_equity_p50": round(float(np.percentile(final_equities, 50)), 2),
        "final_equity_p75": round(float(np.percentile(final_equities, 75)), 2),
        "final_equity_p95": round(float(np.percentile(final_equities, 95)), 2),
        "max_dd_p50_pct": round(float(np.percentile(np.abs(max_dds), 50)), 2),
        "max_dd_p95_pct": round(float(np.percentile(np.abs(max_dds), 95)), 2),
        "var95_pct": round(float(np.percentile(final_ret_pct, 5)), 2),
        "cvar95_pct": round(float(final_ret_pct[final_ret_pct <= np.percentile(final_ret_pct, 5)].mean()), 2),
        "prob_profit_pct": round(float((final_ret_pct > 0).mean() * 100), 2),
        "prob_ruin_20pct_pct": round(float((np.abs(max_dds) > 20).mean() * 100), 2),
        "equity_bands": {k: v[:100] for k, v in equity_bands.items()},  # 截断前100步
        "input_stats": {
            "n_trades_input": len(trade_returns),
            "avg_ret_pct": round(float(np.mean(returns_arr)), 3),
            "std_ret_pct": round(float(np.std(returns_arr)), 3),
            "win_rate_pct": round(float((returns_arr > 0).mean() * 100), 2),
            "skewness": round(float(_calc_skewness(returns_arr)), 3),
        },
    }


def _calc_skewness(arr: np.ndarray) -> float:
    """计算偏度。"""
    n = len(arr)
    if n < 3:
        return 0.0
    mu = np.mean(arr)
    sigma = np.std(arr)
    if sigma == 0:
        return 0.0
    return float(np.sum(((arr - mu) / sigma) ** 3) * n / ((n - 1) * (n - 2)))
