"""
Phase 2.3 — 高级出场策略模块（独立、可插拔）

提供 6 种出场策略 + 基准对比器 + Agent 分析工具。
每种策略独立函数，输入 OHLC 数据 + 入场参数，返回 (exit_price, exit_date, reason)。

策略列表:
  atr_trailing_stop   — Chandelier Exit: N×ATR 从最高点动态止盈
  time_stop           — 时间止损：横盘 N 天无进展则离场
  volatility_stop     — 波动率扩张止损：当前 ATR 超过入场日 N 倍
  ma_exit             — 移动均线出场：收盘跌破 MA 离场
  parabolic_sar_exit  — PSAR 抛物线出场
  hybrid_exit         — 混合出场：ATR trailing + time stop + volatility stop

Agent 工具:
  benchmark_exit_strategies  — 批量对比所有策略，排名输出
  analyze_exit_quality       — 对已有出场记录做质量评估
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable

logger = logging.getLogger(__name__)

# ── 类型定义 ─────────────────────────────────────────────

@dataclass
class ExitResult:
    exit_price: float
    exit_date: date
    reason: str  # 触发原因标签
    entry_price: float = 0.0
    ret_pct: float = 0.0
    hold_days: int = 0

@dataclass
class StrategyScore:
    name: str
    avg_ret: float
    win_rate: float
    avg_win: float
    avg_loss: float
    profit_factor: float
    max_drawdown_pct: float
    sharpe_approx: float
    exit_rate: float  # 出场触发率（非到期离场的比例）
    trade_count: int

# OHLC lookup: {date: (open, high, low, close)}
OHLCLookup = dict[date, tuple[float, float, float, float]]

StrategyFunc = Callable[..., ExitResult | None]

# ── 内部辅助 ─────────────────────────────────────────────

def _calc_true_range(
    high: float, low: float, prev_close: float,
) -> float:
    return max(high - low, abs(high - prev_close), abs(low - prev_close))


def _calc_atr(
    ohlc: OHLCLookup,
    sorted_dates: list[date],
    as_of: date,
    period: int = 14,
) -> float | None:
    """从 OHLC 计算截止 as_of 的 ATR（SMA）。"""
    import bisect

    right = bisect.bisect_right(sorted_dates, as_of)
    if right < period + 1:
        return None
    window = sorted_dates[right - period - 1 : right]
    trs: list[float] = []
    for i in range(1, len(window)):
        _, h, l, _ = ohlc[window[i]]
        _, _, _, prev_c = ohlc[window[i - 1]]
        trs.append(_calc_true_range(h, l, prev_c))
    return sum(trs) / len(trs) if trs else None


def _calc_ema(series: list[float], period: int) -> list[float]:
    """返回 EMA 序列。"""
    if len(series) < period:
        return [series[-1]] * len(series) if series else []
    multiplier = 2.0 / (period + 1)
    result = [sum(series[:period]) / period]
    for v in series[period:]:
        result.append((v - result[-1]) * multiplier + result[-1])
    return [result[0]] * (period - 1) + result


def _is_limit_locked(candle: tuple[float, float, float, float], prev_close: float) -> bool:
    """检查是否一字跌停（无法卖出）。"""
    o, h, l, _ = candle
    if o <= 0:
        return False
    tol = o * 1e-6
    return abs(h - o) <= tol and abs(l - o) <= tol and o < prev_close


def _exit_price_for_trigger(
    trigger_price: float, open_px: float, is_stop: bool = True,
) -> float:
    """计算触发价格的实际执行价。止损用 min(trigger, open)，止盈用 max。"""
    if is_stop:
        return trigger_price if open_px >= trigger_price else open_px
    else:
        return trigger_price if open_px <= trigger_price else open_px


# ═══════════════════════════════════════════════════════
# 策略 1: ATR Trailing Stop (Chandelier Exit)
# ═══════════════════════════════════════════════════════

def atr_trailing_stop(
    ohlc: OHLCLookup,
    sorted_dates: list[date],
    entry_date: date,
    entry_price: float,
    atr_mult: float = 3.0,
    atr_period: int = 14,
    activation_pct: float = 3.0,
    max_hold_days: int = 120,
) -> ExitResult | None:
    """Chandelier Exit: N×ATR 从最高点动态止盈（ratchet up only）。

    Args:
        ohlc: OHLC lookup
        sorted_dates: 预排序的日期列表
        entry_date: 入场日期
        entry_price: 入场价
        atr_mult: ATR 倍数（默认 3.0）
        atr_period: ATR 周期
        activation_pct: 激活门槛(%)，浮盈达此百分比后才启用
        max_hold_days: 最大持有天数（安全网）

    Returns:
        ExitResult | None — None 表示无法判定（数据不足等）
    """
    try:
        entry_idx = sorted_dates.index(entry_date)
    except ValueError:
        return None

    window_start = entry_idx + 1
    window_end = min(len(sorted_dates) - 1, entry_idx + max_hold_days)
    if window_start > window_end:
        return None

    activate_price = entry_price * (1.0 + activation_pct / 100.0)
    trailing_activated = activation_pct <= 0
    peak_high = entry_price
    trailing_stop: float | None = None

    for i in range(window_start, window_end + 1):
        mkt_day = sorted_dates[i]
        candle = ohlc.get(mkt_day)
        if candle is None:
            continue
        o, h, l, c = candle

        # 更新 ATR trailing stop（ratchet up only）
        atr_val = _calc_atr(ohlc, sorted_dates, mkt_day, atr_period)
        if atr_val and atr_val > 0:
            new_stop = peak_high - atr_mult * atr_val
            trailing_stop = new_stop if trailing_stop is None else max(trailing_stop, new_stop)

        # 激活门槛
        if not trailing_activated and h >= activate_price:
            trailing_activated = True

        if trailing_stop and trailing_activated and l <= trailing_stop:
            exit_px = _exit_price_for_trigger(trailing_stop, o, is_stop=True)
            return ExitResult(
                exit_price=exit_px,
                exit_date=mkt_day,
                reason=f"ATR{atr_mult}x_trailing",
                entry_price=entry_price,
                ret_pct=(exit_px - entry_price) / entry_price * 100.0,
                hold_days=i - entry_idx,
            )

        peak_high = max(peak_high, h)

    # 安全网到期
    last_day = sorted_dates[window_end]
    last_candle = ohlc.get(last_day)
    if last_candle:
        exit_px = last_candle[3]
        return ExitResult(
            exit_price=exit_px,
            exit_date=last_day,
            reason="max_hold_expired",
            entry_price=entry_price,
            ret_pct=(exit_px - entry_price) / entry_price * 100.0,
            hold_days=window_end - entry_idx,
        )
    return None


# ═══════════════════════════════════════════════════════
# 策略 2: 时间止损 (Time Stop)
# ═══════════════════════════════════════════════════════

def time_stop(
    ohlc: OHLCLookup,
    sorted_dates: list[date],
    entry_date: date,
    entry_price: float,
    patience_days: int = 10,
    min_return_pct: float = 2.0,
    max_hold_days: int = 60,
) -> ExitResult | None:
    """时间止损：持仓超过 patience_days 天且收益未达 min_return_pct 则离场。

    避免资金在横盘股中无效占用。
    """
    try:
        entry_idx = sorted_dates.index(entry_date)
    except ValueError:
        return None

    window_start = entry_idx + 1
    window_end = min(len(sorted_dates) - 1, entry_idx + max_hold_days)
    if window_start > window_end:
        return None

    patience_end = min(entry_idx + patience_days, window_end)

    for i in range(window_start, window_end + 1):
        mkt_day = sorted_dates[i]
        candle = ohlc.get(mkt_day)
        if candle is None:
            continue
        _, h, _, c = candle
        current_ret = (c - entry_price) / entry_price * 100.0

        # 过了耐心窗口后，检查是否横盘
        if i >= patience_end and current_ret < min_return_pct:
            return ExitResult(
                exit_price=c,
                exit_date=mkt_day,
                reason=f"time_stop_{patience_days}d_ret<{min_return_pct}%",
                entry_price=entry_price,
                ret_pct=current_ret,
                hold_days=i - entry_idx,
            )

        # 如果达到目标，不退场（让利润跑，交给其他策略处理）
        if current_ret >= min_return_pct:
            return None  # 时间止损不触发，由上层混合决策

    return None  # 不触发（留给安全网）


# ═══════════════════════════════════════════════════════
# 策略 3: 波动率扩张止损
# ═══════════════════════════════════════════════════════

def volatility_stop(
    ohlc: OHLCLookup,
    sorted_dates: list[date],
    entry_date: date,
    entry_price: float,
    vol_expansion_mult: float = 2.5,
    atr_period: int = 14,
    max_hold_days: int = 60,
) -> ExitResult | None:
    """波动率扩张止损：当前 ATR 超过入场日 ATR 的 N 倍时离场。

    原理：波动率异常扩张通常伴随趋势反转或坏消息冲击。
    """
    try:
        entry_idx = sorted_dates.index(entry_date)
    except ValueError:
        return None

    entry_atr = _calc_atr(ohlc, sorted_dates, entry_date, atr_period)
    if entry_atr is None or entry_atr <= 0:
        return None

    window_start = entry_idx + 1
    window_end = min(len(sorted_dates) - 1, entry_idx + max_hold_days)
    if window_start > window_end:
        return None

    for i in range(window_start, window_end + 1):
        mkt_day = sorted_dates[i]
        candle = ohlc.get(mkt_day)
        if candle is None:
            continue
        o, _, _, c = candle

        current_atr = _calc_atr(ohlc, sorted_dates, mkt_day, atr_period)
        if current_atr and current_atr > entry_atr * vol_expansion_mult:
            exit_px = c  # 收盘离场（波动率扩张通常伴随跳空，按收盘更稳）
            return ExitResult(
                exit_price=exit_px,
                exit_date=mkt_day,
                reason=f"vol_expansion_{vol_expansion_mult}x",
                entry_price=entry_price,
                ret_pct=(exit_px - entry_price) / entry_price * 100.0,
                hold_days=i - entry_idx,
            )

    return None


# ═══════════════════════════════════════════════════════
# 策略 4: 移动均线出场
# ═══════════════════════════════════════════════════════

def ma_exit(
    ohlc: OHLCLookup,
    sorted_dates: list[date],
    entry_date: date,
    entry_price: float,
    ma_period: int = 20,
    max_hold_days: int = 120,
    min_hold_days: int = 3,
) -> ExitResult | None:
    """移动均线出场：收盘价跌破 MA 且次日未收复时离场。

    适用于趋势跟踪策略的保利出场。
    """
    try:
        entry_idx = sorted_dates.index(entry_date)
    except ValueError:
        return None

    window_start = entry_idx + min_hold_days
    window_end = min(len(sorted_dates) - 1, entry_idx + max_hold_days)
    if window_start > window_end:
        return None

    prev_below = False  # 上一日是否已跌破 MA

    for i in range(window_start, window_end + 1):
        mkt_day = sorted_dates[i]
        candle = ohlc.get(mkt_day)
        if candle is None:
            continue
        o, _, _, c = candle

        # 计算当日 MA（使用截止当日的数据）
        ma_start = max(0, i - ma_period + 1)
        closes = [ohlc[sorted_dates[j]][3] for j in range(ma_start, i + 1)]
        if len(closes) < ma_period:
            continue
        ma_val = sum(closes) / len(closes)

        below_ma = c < ma_val
        if below_ma and prev_below:
            # 连续两日跌破 → 离场
            exit_px = o  # 按开盘离场
            return ExitResult(
                exit_price=exit_px,
                exit_date=mkt_day,
                reason=f"MA{ma_period}_breakdown",
                entry_price=entry_price,
                ret_pct=(exit_px - entry_price) / entry_price * 100.0,
                hold_days=i - entry_idx,
            )

        prev_below = below_ma

    return None


# ═══════════════════════════════════════════════════════
# 策略 5: Parabolic SAR 出场
# ═══════════════════════════════════════════════════════

def parabolic_sar_exit(
    ohlc: OHLCLookup,
    sorted_dates: list[date],
    entry_date: date,
    entry_price: float,
    acceleration_factor: float = 0.02,
    max_acceleration: float = 0.20,
    max_hold_days: int = 120,
) -> ExitResult | None:
    """PSAR 出场：价格跌破 PSAR 点即离场。

    从入场日起重新计算 PSAR（上行趋势），当 low <= PSAR 时触发。
    """
    try:
        entry_idx = sorted_dates.index(entry_date)
    except ValueError:
        return None

    window_start = entry_idx + 1
    window_end = min(len(sorted_dates) - 1, entry_idx + max_hold_days)
    if window_start > window_end:
        return None

    # PSAR 初始化（基于入场日前 5 日的极值）
    init_start = max(0, entry_idx - 5)
    ep = ohlc[sorted_dates[init_start]][2]  # extreme point = 期间最高 high
    af = acceleration_factor
    sar = ohlc[sorted_dates[init_start]][3]  # 初始 SAR = 期间最低 low
    for j in range(init_start + 1, entry_idx + 1):
        _, h, l, _ = ohlc[sorted_dates[j]]
        ep = max(ep, h)
        sar = sar + af * (ep - sar)
    # 确保初始 SAR 在入场价下方
    sar = min(sar, entry_price * 0.98)

    for i in range(window_start, window_end + 1):
        mkt_day = sorted_dates[i]
        candle = ohlc.get(mkt_day)
        if candle is None:
            continue
        o, h, l, c = candle

        # PSAR 加速
        _, _, pl, _ = ohlc.get(sorted_dates[max(entry_idx, i - 1)], (o, h, l, c))
        if i > window_start:
            sar = sar + af * (ep - sar)
            af = min(af + acceleration_factor, max_acceleration)
            ep = max(ep, h)

        if l <= sar:
            exit_px = _exit_price_for_trigger(sar, o, is_stop=True)
            return ExitResult(
                exit_price=exit_px,
                exit_date=mkt_day,
                reason="PSAR_break",
                entry_price=entry_price,
                ret_pct=(exit_px - entry_price) / entry_price * 100.0,
                hold_days=i - entry_idx,
            )

    return None


# ═══════════════════════════════════════════════════════
# 策略 6: 混合出场 (Hybrid)
# ═══════════════════════════════════════════════════════

def hybrid_exit(
    ohlc: OHLCLookup,
    sorted_dates: list[date],
    entry_date: date,
    entry_price: float,
    atr_mult: float = 3.0,
    atr_period: int = 14,
    patience_days: int = 10,
    min_return_pct: float = 2.0,
    vol_expansion_mult: float = 2.5,
    max_hold_days: int = 120,
) -> ExitResult | None:
    """混合出场：ATR trailing + 时间止损 + 波动率扩张，任一触发即离场。

    优先级: 波动率扩张 > ATR trailing > 时间止损 > 安全网
    """
    try:
        entry_idx = sorted_dates.index(entry_date)
    except ValueError:
        return None

    entry_atr = _calc_atr(ohlc, sorted_dates, entry_date, atr_period)

    window_start = entry_idx + 1
    window_end = min(len(sorted_dates) - 1, entry_idx + max_hold_days)
    if window_start > window_end:
        return None

    peak_high = entry_price
    trailing_stop: float | None = None
    patience_end = min(entry_idx + patience_days, window_end)

    for i in range(window_start, window_end + 1):
        mkt_day = sorted_dates[i]
        candle = ohlc.get(mkt_day)
        if candle is None:
            continue
        o, h, l, c = candle

        # 1. 波动率扩张（最高优先级）
        if entry_atr and entry_atr > 0:
            current_atr = _calc_atr(ohlc, sorted_dates, mkt_day, atr_period)
            if current_atr and current_atr > entry_atr * vol_expansion_mult:
                return ExitResult(
                    exit_price=c, exit_date=mkt_day,
                    reason=f"hybrid_vol_{vol_expansion_mult}x",
                    entry_price=entry_price,
                    ret_pct=(c - entry_price) / entry_price * 100.0,
                    hold_days=i - entry_idx,
                )

        # 2. ATR trailing stop
        peak_high = max(peak_high, h)
        atr_val = _calc_atr(ohlc, sorted_dates, mkt_day, atr_period)
        if atr_val and atr_val > 0:
            new_stop = peak_high - atr_mult * atr_val
            trailing_stop = new_stop if trailing_stop is None else max(trailing_stop, new_stop)

        if trailing_stop and l <= trailing_stop:
            exit_px = _exit_price_for_trigger(trailing_stop, o, is_stop=True)
            return ExitResult(
                exit_price=exit_px, exit_date=mkt_day,
                reason=f"hybrid_ATR{atr_mult}x",
                entry_price=entry_price,
                ret_pct=(exit_px - entry_price) / entry_price * 100.0,
                hold_days=i - entry_idx,
            )

        # 3. 时间止损
        if i >= patience_end:
            current_ret = (c - entry_price) / entry_price * 100.0
            if current_ret < min_return_pct:
                return ExitResult(
                    exit_price=c, exit_date=mkt_day,
                    reason=f"hybrid_time_{patience_days}d",
                    entry_price=entry_price,
                    ret_pct=current_ret,
                    hold_days=i - entry_idx,
                )

    # 安全网
    last_day = sorted_dates[window_end]
    last_candle = ohlc.get(last_day)
    if last_candle:
        exit_px = last_candle[3]
        return ExitResult(
            exit_price=exit_px, exit_date=last_day,
            reason="hybrid_max_hold",
            entry_price=entry_price,
            ret_pct=(exit_px - entry_price) / entry_price * 100.0,
            hold_days=window_end - entry_idx,
        )
    return None


# ═══════════════════════════════════════════════════════
# 基准对比器
# ═══════════════════════════════════════════════════════

STRATEGY_REGISTRY: dict[str, StrategyFunc] = {
    "atr_trailing": atr_trailing_stop,
    "time_stop": time_stop,
    "volatility_stop": volatility_stop,
    "ma_exit": ma_exit,
    "psar_exit": parabolic_sar_exit,
    "hybrid": hybrid_exit,
}


def benchmark_exit_strategies(
    ohlc_data: dict[str, OHLCLookup],
    sorted_dates_map: dict[str, list[date]],
    trades: list[dict[str, Any]],
    strategies: list[str] | None = None,
    extra_params: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """对一批交易运行所有出场策略，输出排名对比表。

    Args:
        ohlc_data: {code: OHLC lookup}
        sorted_dates_map: {code: sorted dates}
        trades: [{code, entry_date, entry_price, ...}]
        strategies: 要对比的策略列表（默认全部）
        extra_params: {strategy_name: {param: value}} 覆盖默认参数

    Returns:
        {
            rankings: [{name, avg_ret, win_rate, profit_factor, sharpe, ...}],
            strategy_details: {name: {trades: [...], scores: {...}}},
            best_strategy: str,
            best_sharpe: float,
        }
    """
    import math

    names = strategies or list(STRATEGY_REGISTRY.keys())
    param_overrides = extra_params or {}
    results: dict[str, list[ExitResult]] = {}

    for name in names:
        fn = STRATEGY_REGISTRY.get(name)
        if fn is None:
            continue
        params = param_overrides.get(name, {})
        exits: list[ExitResult] = []

        for t in trades:
            code = str(t.get("code", ""))
            entry_date_val = t.get("entry_date")
            entry_price_val = float(t.get("entry_price", 0))
            if not code or entry_date_val is None or entry_price_val <= 0:
                continue
            ohlc = ohlc_data.get(code)
            sdates = sorted_dates_map.get(code)
            if ohlc is None or sdates is None:
                continue
            try:
                result = fn(ohlc, sdates, entry_date_val, entry_price_val, **params)
                if result is not None:
                    exits.append(result)
            except Exception:
                logger.debug("策略 %s 在 %s 上执行失败，跳过", name, code)
                continue

        results[name] = exits

    # 评分
    scores: dict[str, dict[str, Any]] = {}
    for name, exits in results.items():
        if not exits:
            scores[name] = {"avg_ret": 0, "win_rate": 0, "profit_factor": 0, "sharpe_approx": 0, "exit_rate": 0, "trade_count": 0}
            continue
        rets = [e.ret_pct for e in exits]
        wins = [r for r in rets if r > 0]
        losses = [r for r in rets if r <= 0]
        avg_ret = sum(rets) / len(rets)
        win_rate = len(wins) / len(rets) * 100 if rets else 0
        avg_win = sum(wins) / len(wins) if wins else 0
        avg_loss = sum(losses) / len(losses) if losses else 0
        profit_factor = abs(sum(wins) / sum(losses)) if losses and sum(losses) != 0 else (999 if wins else 0)
        # 近似 Sharpe（无 risk-free rate）
        mean_r = sum(rets) / len(rets)
        var_r = sum((r - mean_r) ** 2 for r in rets) / len(rets) if len(rets) > 1 else 0
        sharpe = mean_r / math.sqrt(var_r) if var_r > 0 else 0
        # Max drawdown
        peak = -1e9
        max_dd = 0.0
        cum = 0.0
        for r in rets:
            cum += r
            peak = max(peak, cum)
            max_dd = min(max_dd, cum - peak)
        # Exit rate: 非 max_hold 触发的比例
        non_expired = sum(1 for e in exits if "max_hold" not in e.reason)
        exit_rate = non_expired / len(exits) * 100 if exits else 0

        scores[name] = {
            "avg_ret": round(avg_ret, 2),
            "win_rate": round(win_rate, 1),
            "avg_win": round(avg_win, 2),
            "avg_loss": round(avg_loss, 2),
            "profit_factor": round(profit_factor, 2),
            "max_drawdown_pct": round(max_dd, 2),
            "sharpe_approx": round(sharpe, 3),
            "exit_rate": round(exit_rate, 1),
            "trade_count": len(exits),
        }

    # 排名（按 Sharpe）
    rankings = sorted(
        [{"name": k, **v} for k, v in scores.items()],
        key=lambda x: x["sharpe_approx"],
        reverse=True,
    )

    return {
        "rankings": rankings,
        "strategy_details": {k: {"scores": v} for k, v in scores.items()},
        "best_strategy": rankings[0]["name"] if rankings else "none",
        "best_sharpe": rankings[0]["sharpe_approx"] if rankings else 0.0,
        "total_trades": len(trades),
    }


def analyze_exit_quality(
    exits: list[dict[str, Any]],
) -> dict[str, Any]:
    """对已有出场记录做质量评估：过早离场/利润回吐/最优离场点分析。

    Args:
        exits: [{exit_price, exit_date, entry_price, peak_high, ...}]

    Returns:
        {
            early_exit_rate: float,     # 过早离场比例
            profit_giveback_avg: float,  # 平均利润回吐%
            mfe_avg: float,              # 平均最大有利偏移
            mae_avg: float,              # 平均最大不利偏移
            grade: str,                  # A/B/C/D/F
            advice: [str],
        }
    """
    if not exits:
        return {"error": "无出场记录", "grade": "N/A"}

    early_count = 0
    givebacks: list[float] = []
    mfe_list: list[float] = []
    mae_list: list[float] = []
    hold_days_list: list[int] = []

    for e in exits:
        entry = float(e.get("entry_price", 0))
        exit_px = float(e.get("exit_price", 0))
        peak = float(e.get("peak_high", exit_px))
        trough = float(e.get("trough_low", entry))
        hold = int(e.get("hold_days", 0))

        if entry <= 0:
            continue

        mfe = (peak - entry) / entry * 100.0
        mae = (trough - entry) / entry * 100.0
        mfe_list.append(mfe)
        mae_list.append(mae)
        hold_days_list.append(hold)

        # 利润回吐 = MFE - 实际收益
        actual_ret = (exit_px - entry) / entry * 100.0
        if mfe > 0:
            giveback = mfe - max(actual_ret, 0)
            givebacks.append(giveback)
            if giveback > mfe * 0.5:  # 回吐超过 MFE 的 50%
                early_count += 1

    n = len(exits)
    avg_giveback = sum(givebacks) / len(givebacks) if givebacks else 0
    avg_mfe = sum(mfe_list) / n if n else 0
    avg_mae = sum(mae_list) / n if n else 0

    # 评级
    giveback_ratio = avg_giveback / avg_mfe if avg_mfe > 0 else 1.0
    if giveback_ratio < 0.2:
        grade = "A"
    elif giveback_ratio < 0.35:
        grade = "B"
    elif giveback_ratio < 0.5:
        grade = "C"
    elif giveback_ratio < 0.7:
        grade = "D"
    else:
        grade = "F"

    advice: list[str] = []
    if avg_giveback > 3:
        advice.append(f"平均利润回吐 {avg_giveback:.1f}%，建议收紧 trailing stop")
    if avg_mfe > 5 and giveback_ratio > 0.5:
        advice.append(f"MFE {avg_mfe:.1f}% 但回吐率 {giveback_ratio:.0%}，出场纪律需加强")
    if early_count / n > 0.3:
        advice.append(f"过早离场比例 {early_count / n:.0%}，考虑放宽 patience_days 或扩大 ATR 倍数")

    return {
        "early_exit_rate": round(early_count / n * 100, 1),
        "profit_giveback_avg": round(avg_giveback, 2),
        "mfe_avg": round(avg_mfe, 2),
        "mae_avg": round(avg_mae, 2),
        "grade": grade,
        "giveback_ratio": round(giveback_ratio, 2),
        "advice": advice,
        "sample_size": n,
    }
