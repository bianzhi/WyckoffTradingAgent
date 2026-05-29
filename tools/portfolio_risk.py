"""
组合风险管理工具：VaR/CVaR、相关性矩阵、压力测试、最大回撤。

输入持仓列表 [{code, shares, cost_price}]，输出完整风险报告。
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta

import numpy as np
import pandas as pd

from integrations.data_source import fetch_stock_hist


def _daily_returns(close: pd.Series) -> pd.Series:
    """从收盘价序列计算日收益率。"""
    c = pd.to_numeric(close, errors="coerce").dropna()
    return c.pct_change().dropna()


def _portfolio_value(positions: list[dict], prices: dict[str, float]) -> float:
    """计算组合当前市值。"""
    total = 0.0
    for p in positions:
        code = str(p.get("code", "")).strip()
        shares = float(p.get("shares", 0) or 0)
        price = prices.get(code) or float(p.get("cost_price", 0) or 0)
        total += shares * price
    return total


# ── VaR / CVaR ────────────────────────────────────────────


def historical_var(returns: np.ndarray, confidence: float = 0.95) -> float:
    """历史模拟 VaR：取收益率分布的第 (1-confidence) 分位数。"""
    if len(returns) == 0:
        return 0.0
    return float(np.percentile(returns, (1 - confidence) * 100))


def parametric_var(returns: np.ndarray, confidence: float = 0.95) -> float:
    """参数法 VaR（假设正态分布）：mu - z * sigma。"""
    if len(returns) < 2:
        return 0.0
    from scipy.stats import norm

    mu = float(np.mean(returns))
    sigma = float(np.std(returns, ddof=1))
    z = norm.ppf(1 - confidence)
    return mu - z * sigma


def cvar(returns: np.ndarray, confidence: float = 0.95) -> float:
    """CVaR（条件风险价值/期望损失）：低于 VaR 的均值。"""
    if len(returns) == 0:
        return 0.0
    threshold = historical_var(returns, confidence)
    tail = returns[returns <= threshold]
    if len(tail) == 0:
        return threshold
    return float(tail.mean())


# ── 最大回撤 ──────────────────────────────────────────────


def max_drawdown(values: np.ndarray) -> dict:
    """计算最大回撤：峰值、谷值、幅度、起止日期。"""
    if len(values) < 2:
        return {"max_drawdown_pct": 0.0, "peak": None, "trough": None}

    peak = values[0]
    peak_idx = 0
    mdd = 0.0
    mdd_peak_idx = 0
    mdd_trough_idx = 0

    for i in range(1, len(values)):
        if values[i] > peak:
            peak = values[i]
            peak_idx = i
        dd = (values[i] - peak) / peak
        if dd < mdd:
            mdd = dd
            mdd_peak_idx = peak_idx
            mdd_trough_idx = i

    return {
        "max_drawdown_pct": round(mdd * 100, 2),
        "peak_value": round(float(values[mdd_peak_idx]), 2),
        "trough_value": round(float(values[mdd_trough_idx]), 2),
        "peak_index": int(mdd_peak_idx),
        "trough_index": int(mdd_trough_idx),
    }


# ── 相关性矩阵 ────────────────────────────────────────────


def correlation_matrix(returns_dict: dict[str, np.ndarray]) -> dict:
    """计算持仓间的日收益率相关系数矩阵。"""
    # 对齐长度，取最小公共长度
    min_len = min(len(r) for r in returns_dict.values()) if returns_dict else 0
    if min_len < 5:
        return {"matrix": {}, "pairs": []}

    df = pd.DataFrame({k: v[-min_len:] for k, v in returns_dict.items()})
    corr = df.corr()

    pairs = []
    codes = list(returns_dict.keys())
    for i in range(len(codes)):
        for j in range(i + 1, len(codes)):
            val = float(corr.iloc[i, j]) if not pd.isna(corr.iloc[i, j]) else 0.0
            pairs.append({"code_a": codes[i], "code_b": codes[j], "correlation": round(val, 4)})

    # 高相关警告
    high_corr = [p for p in pairs if abs(p["correlation"]) > 0.7]
    warnings = []
    if high_corr:
        names = [f"{p['code_a']}-{p['code_b']}({p['correlation']:.2f})" for p in high_corr]
        warnings.append(f"⚠️ 高相关对（>{0.7}）：{', '.join(names)}")

    return {"matrix": {k: {kk: round(float(vv), 4) for kk, vv in v.items()} for k, v in corr.items()}, "pairs": pairs, "high_correlation_warnings": warnings}


# ── 压力测试 ──────────────────────────────────────────────


STRESS_SCENARIOS = [
    {"name": "温和回调 (-5%)", "market_drop_pct": -5.0, "beta_multiplier": 1.0},
    {"name": "中度回调 (-10%)", "market_drop_pct": -10.0, "beta_multiplier": 1.0},
    {"name": "深度回调 (-20%)", "market_drop_pct": -20.0, "beta_multiplier": 1.0},
    {"name": "股灾 (-30%)", "market_drop_pct": -30.0, "beta_multiplier": 1.0},
    {"name": "极端事件 (-50%)", "market_drop_pct": -50.0, "beta_multiplier": 1.0},
    {"name": "高波动冲击 (β×2)", "market_drop_pct": -10.0, "beta_multiplier": 2.0},
]


def stress_test(positions: list[dict], total_value: float, returns_dict: dict[str, np.ndarray], index_returns: np.ndarray | None = None) -> list[dict]:
    """对组合进行多情景压力测试。"""
    results = []
    if not positions or total_value <= 0:
        return results

    # 计算每只股票的 beta
    betas: dict[str, float] = {}
    if index_returns is not None and len(index_returns) > 5:
        for code, rets in returns_dict.items():
            min_len = min(len(rets), len(index_returns))
            if min_len < 5:
                betas[code] = 1.0
                continue
            aligned = pd.DataFrame({"stock": rets[-min_len:], "index": index_returns[-min_len:]})
            cov = aligned.cov()
            if cov.iloc[1, 1] > 0:
                betas[code] = float(cov.iloc[0, 1] / cov.iloc[1, 1])
            else:
                betas[code] = 1.0
    else:
        for code in returns_dict:
            betas[code] = 1.0

    for scenario in STRESS_SCENARIOS:
        loss = 0.0
        for p in positions:
            code = str(p.get("code", "")).strip()
            shares = float(p.get("shares", 0) or 0)
            cost_price = float(p.get("cost_price", 0) or 0)
            position_value = shares * cost_price

            beta = betas.get(code, 1.0)
            stock_drop = scenario["market_drop_pct"] / 100.0 * beta * scenario["beta_multiplier"]
            loss += position_value * stock_drop

        remaining = total_value + loss
        loss_pct = (loss / total_value * 100) if total_value > 0 else 0.0
        results.append(
            {
                "scenario": scenario["name"],
                "loss_amount": round(loss, 2),
                "loss_pct": round(loss_pct, 2),
                "remaining_value": round(remaining, 2),
                "remaining_pct": round(remaining / total_value * 100, 2) if total_value > 0 else 0.0,
            }
        )

    return results


# ── 汇总报告 ──────────────────────────────────────────────


def _load_index_returns(days: int = 252) -> np.ndarray | None:
    """加载沪深300日收益率作为市场基准。"""
    try:
        end = date.today()
        start = end - timedelta(days=days + 10)
        df = fetch_stock_hist("000300", start, end, adjust="qfq")
        if df is None or df.empty:
            return None
        close = pd.to_numeric(df["收盘"], errors="coerce").dropna()
        rets = close.pct_change().dropna().values
        return rets
    except Exception:
        return None


def generate_risk_report(positions: list[dict], lookback_days: int = 252) -> dict:
    """
    生成组合风险报告。

    Args:
        positions: [{"code": "000001", "shares": 1000, "cost_price": 12.5}, ...]
        lookback_days: 回看交易日数（默认252≈1年）

    Returns:
        完整风险报告 dict
    """
    if not positions:
        return {"error": "持仓列表为空"}

    end = date.today()
    start = end - timedelta(days=lookback_days + 30)

    # 拉取每只股票的日线
    returns_dict: dict[str, np.ndarray] = {}
    prices: dict[str, float] = {}
    fetch_errors: list[str] = []
    position_details: list[dict] = []

    for p in positions:
        code = str(p.get("code", "")).strip()
        shares = float(p.get("shares", 0) or 0)
        cost_price = float(p.get("cost_price", 0) or 0)

        if not code or shares <= 0:
            continue

        try:
            df = fetch_stock_hist(code, start, end, adjust="qfq")
            if df is None or df.empty:
                fetch_errors.append(f"{code}: 无K线数据")
                position_details.append({"code": code, "shares": shares, "cost_price": cost_price, "latest_price": None, "position_value": 0, "error": "无数据"})
                continue

            close = pd.to_numeric(df["收盘"], errors="coerce").dropna()
            if len(close) < 10:
                fetch_errors.append(f"{code}: K线不足10日")
                position_details.append({"code": code, "shares": shares, "cost_price": cost_price, "latest_price": float(close.iloc[-1]), "position_value": shares * float(close.iloc[-1]), "error": "数据不足"})
                continue

            rets = _daily_returns(close)
            returns_dict[code] = rets.values[-lookback_days:]
            latest_price = float(close.iloc[-1])
            prices[code] = latest_price
            position_value = shares * latest_price
            pnl_pct = (latest_price / cost_price - 1) * 100 if cost_price > 0 else 0

            position_details.append(
                {
                    "code": code,
                    "shares": shares,
                    "cost_price": cost_price,
                    "latest_price": latest_price,
                    "position_value": round(position_value, 2),
                    "pnl_pct": round(pnl_pct, 2),
                }
            )
        except Exception as e:
            fetch_errors.append(f"{code}: {e}")

    if not returns_dict:
        return {"error": "无法获取任何持仓的K线数据", "fetch_errors": fetch_errors}

    total_value = sum(pd["position_value"] for pd_ in position_details)
    all_returns = np.concatenate(list(returns_dict.values()))

    # 组合加权收益率（按持仓市值加权）
    weights = {}
    for pd_ in position_details:
        if pd_["code"] in returns_dict:
            weights[pd_["code"]] = pd_["position_value"] / total_value if total_value > 0 else 1.0 / len(returns_dict)

    portfolio_returns: np.ndarray | None = None
    min_len = min(len(r) for r in returns_dict.values())
    if min_len >= 5 and len(weights) > 0:
        weighted = np.zeros(min_len)
        for code, rets in returns_dict.items():
            if code in weights:
                weighted += rets[-min_len:] * weights[code]
        portfolio_returns = weighted

    # 指数收益率
    index_returns = _load_index_returns(lookback_days)

    # VaR / CVaR
    var_95_hist = historical_var(all_returns, 0.95)
    var_95_param = parametric_var(all_returns, 0.95)
    var_99_hist = historical_var(all_returns, 0.99)
    cvar_95 = cvar(all_returns, 0.95)
    cvar_99 = cvar(all_returns, 0.99)

    # 组合级 VaR
    port_var_95 = 0.0
    port_cvar_95 = 0.0
    if portfolio_returns is not None:
        port_var_95 = historical_var(portfolio_returns, 0.95)
        port_cvar_95 = cvar(portfolio_returns, 0.95)

    # 相关性
    corr = correlation_matrix(returns_dict)

    # 最大回撤
    mdd_result = {"max_drawdown_pct": None, "note": "需要组合市值序列"}
    if portfolio_returns is not None:
        cum_ret = np.cumprod(1 + portfolio_returns)
        mdd_result = max_drawdown(cum_ret)

    # 压力测试
    stress_results = stress_test(position_details, total_value, returns_dict, index_returns)

    # 波动率
    annual_vol = float(np.std(portfolio_returns, ddof=1) * np.sqrt(252)) if portfolio_returns is not None else float(np.std(all_returns, ddof=1) * np.sqrt(252))

    return {
        "portfolio": {
            "total_value": round(total_value, 2),
            "position_count": len(position_details),
            "positions": position_details,
        },
        "var": {
            "historical_95pct": round(var_95_hist * 100, 4),
            "parametric_95pct": round(var_95_param * 100, 4),
            "historical_99pct": round(var_99_hist * 100, 4),
            "cvar_95pct": round(cvar_95 * 100, 4),
            "cvar_99pct": round(cvar_99 * 100, 4),
            "portfolio_var_95pct": round(port_var_95 * 100, 4),
            "portfolio_cvar_95pct": round(port_cvar_95 * 100, 4),
            "confidence": "95%",
            "lookback_days": lookback_days,
        },
        "volatility": {"annualized_vol_pct": round(annual_vol * 100, 2)},
        "max_drawdown": mdd_result,
        "correlation": corr,
        "stress_test": stress_results,
        "fetch_errors": fetch_errors,
    }


# ── CLI 入口 ──────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: python tools/portfolio_risk.py '<json_positions>' [lookback_days]"}), flush=True)
        sys.exit(1)

    try:
        pos = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"JSON 解析失败: {e}"}), flush=True)
        sys.exit(1)

    lookback = int(sys.argv[2]) if len(sys.argv) > 2 else 252
    report = generate_risk_report(pos, lookback)
    print(json.dumps(report, ensure_ascii=False, default=str), flush=True)
