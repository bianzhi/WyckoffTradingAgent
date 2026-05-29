"""信号质量评分模块 — 聚合信号反馈数据生成可读报告。

使用场景：
- Agent 工具 get_signal_quality：查询信号健康状态
- 定期任务：输出信号质量报告推送飞书
"""

from __future__ import annotations

from statistics import mean, median
from typing import Any


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _load_registry() -> list[dict[str, Any]]:
    try:
        from integrations.supabase_signal_feedback import load_signal_registry

        return load_signal_registry("cn")
    except Exception:
        return []


def _load_health_snapshot(limit: int = 1000) -> list[dict[str, Any]]:
    try:
        from integrations.supabase_signal_feedback import load_signal_health_snapshot

        return load_signal_health_snapshot("cn", limit=limit)
    except Exception:
        return []


def _load_recent_outcomes(days: int = 90) -> list[dict[str, Any]]:
    try:
        from integrations.supabase_signal_feedback import load_recent_signal_outcomes

        return load_recent_signal_outcomes(days=days, limit=5000, market="cn")
    except Exception:
        return []


def _registry_summary(registry: list[dict[str, Any]]) -> str:
    if not registry:
        return "（无信号注册数据）\n"
    lines = ["| 信号 | 赛道 | 状态 | 样本数 | 胜率 | 均收益 | 权重 |", "|------|------|------|--------|------|--------|------|"]
    for r in registry:
        signal = r.get("signal_type", "?")
        track = r.get("track", "?")
        status = r.get("status", "?")
        n = r.get("sample_count", 0)
        wr = r.get("win_rate_pct")
        ar = r.get("avg_return_pct")
        w = r.get("weight_multiplier", 1.0)
        wr_s = f"{wr:.1f}%" if wr is not None else "-"
        ar_s = f"{ar:+.2f}%" if ar is not None else "-"
        line = f"| {signal} | {track} | {status} | {n} | {wr_s} | {ar_s} | {w:.2f} |"
        lines.append(line)
    return "\n".join(lines) + "\n"


def _health_trend(rows: list[dict[str, Any]], signal_types: set[str]) -> str:
    """按信号类型 + 赛道汇总最近健康快照。"""
    if not rows or not signal_types:
        return ""
    # 取最近 3 个 as_of_date
    dates = sorted({r.get("as_of_date", "") for r in rows}, reverse=True)[:3]
    if not dates:
        return ""

    lines = []
    for sig in sorted(signal_types):
        sig_rows = [r for r in rows if r.get("signal_type") == sig and r.get("regime") == "ALL"]
        if not sig_rows:
            continue
        latest = max(sig_rows, key=lambda r: str(r.get("as_of_date", "")))
        track = latest.get("track", "?")
        state = latest.get("health_state", "?")
        n = latest.get("sample_count", 0)
        wr = latest.get("win_rate_pct")
        ar = latest.get("avg_return_pct")
        wr_s = f"{wr:.1f}%" if wr is not None else "-"
        ar_s = f"{ar:+.2f}%" if ar is not None else "-"
        icon = {"HEALTHY": "✅", "WATCH": "⚠️", "DECAYED": "❌", "INSUFFICIENT": "📊"}.get(state, "·")
        lines.append(f"- {icon} **{sig}** ({track}): {state} | 样本 {n} | 胜率 {wr_s} | 均收 {ar_s}")
    return "\n".join(lines) + "\n" if lines else ""


def _recent_performance(outcomes: list[dict[str, Any]], limit: int = 20) -> str:
    """最近 N 笔信号的到期收益概览。"""
    done = [r for r in outcomes if r.get("status") == "done" and r.get("return_pct") is not None]
    if not done:
        return "（暂无到期信号样本）\n"

    recent = sorted(done, key=lambda r: str(r.get("trade_date", "")), reverse=True)[:limit]
    returns = [_safe_float(r.get("return_pct")) for r in recent]
    wins = sum(1 for r in returns if r > 0)
    lines = [
        f"最近 {len(recent)} 笔到期信号：",
        f"- 胜率: {wins}/{len(recent)} ({wins / len(recent) * 100:.1f}%)",
        f"- 平均收益: {mean(returns):+.2f}%",
        f"- 中位数收益: {median(returns):+.2f}%",
        f"- 最好: {max(returns):+.2f}%  |  最差: {min(returns):+.2f}%",
    ]
    return "\n".join(lines) + "\n"


def _track_breakdown(outcomes: list[dict[str, Any]]) -> str:
    """按 Trend / Accum 赛道划分信号表现。"""
    done = [r for r in outcomes if r.get("status") == "done" and r.get("return_pct") is not None]
    if not done:
        return ""

    from collections import defaultdict

    groups: dict[str, list[float]] = defaultdict(list)
    for r in done:
        track = str(r.get("track") or "Trend")
        groups[track].append(_safe_float(r.get("return_pct")))

    lines = ["**分赛道表现**："]
    for track in sorted(groups):
        rets = groups[track]
        wr = sum(1 for r in rets if r > 0) / len(rets) * 100
        lines.append(f"- **{track}**: {len(rets)} 笔 | 胜率 {wr:.1f}% | 均收 {mean(rets):+.2f}%")
    return "\n".join(lines) + "\n"


def generate_signal_quality_report() -> str:
    """生成信号质量评分报告。"""
    registry = _load_registry()
    health = _load_health_snapshot(limit=500)
    outcomes = _load_recent_outcomes(days=90)

    signal_types = {r.get("signal_type", "") for r in registry if r.get("signal_type")}
    signal_types |= {r.get("signal_type", "") for r in health if r.get("signal_type")}

    parts: list[str] = []

    # 1. 信号注册状态
    parts.append("## 信号注册表\n")
    parts.append(_registry_summary(registry))

    # 2. 信号健康趋势
    trend = _health_trend(health, signal_types)
    if trend:
        parts.append("## 信号健康趋势\n")
        parts.append(trend)

    # 3. 最近信号表现
    parts.append("## 近期表现\n")
    parts.append(_recent_performance(outcomes))

    # 4. 分赛道表现
    tb = _track_breakdown(outcomes)
    if tb:
        parts.append(tb)

    # 5. 总结
    healthy = sum(1 for r in registry if r.get("status") == "ACTIVE" and r.get("health_state") not in {None, "DECAYED"})
    decayed = sum(1 for r in registry if r.get("health_state") == "DECAYED")
    parts.append(f"信号池: {len(registry)} 种信号 | 健康 {healthy} | 衰减 {decayed}")
    parts.append("\n说明：信号质量基于历史到期收益统计，不构成未来预测。")

    return "\n".join(parts)


__all__ = ["generate_signal_quality_report"]
