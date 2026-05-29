"""条件预警引擎 — 评估自定义规则 → 飞书推送。

规则存储在 ~/.wyckoff/alerts.yml，格式：

alerts:
  - id: "price-break"
    name: "茅台突破2000"
    enabled: true
    conditions:
      - type: price_above
        symbol: "600519"
        threshold: 2000.0
    notify:
      webhook_url: "${FEISHU_WEBHOOK_URL}"
      title: "【价格预警】茅台突破2000"
    cooldown_minutes: 60
  - id: "volume-spike"
    name: "放量异动"
    enabled: true
    conditions:
      - type: volume_spike
        symbol: "000001"
        multiplier: 2.5
    notify:
      webhook_url: "${FEISHU_WEBHOOK_URL}"
      title: "【成交量预警】平安放量"
    cooldown_minutes: 30

条件类型：
- price_above:      symbol, threshold     → 最新价 > 阈值
- price_below:      symbol, threshold     → 最新价 < 阈值
- pct_change:       symbol, threshold     → 涨跌幅绝对值 > 阈值
- volume_spike:     symbol, multiplier    → 成交量 > N × 20日均量
- index_pct:        index_code, threshold → 指数涨跌幅绝对值 > 阈值
- regime:           regime_value           → 市场水温匹配

CLI 用法：
  python3 tools/alert_engine.py          # 评估所有启用的规则
  python3 tools/alert_engine.py --dry-run  # 只输出不推送
  python3 tools/alert_engine.py --rule price-break  # 只评估指定规则
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

# ── 配置 ────────────────────────────────────────────────

ALERTS_YML = Path.home() / ".wyckoff" / "alerts.yml"
COOLDOWN_TRACKER = Path.home() / ".wyckoff" / "alert_cooldowns.json"

DEFAULT_ALERTS_YML = """\
# 条件预警规则 — 修改后保存，引擎自动重载
# 条件类型：price_above, price_below, pct_change, volume_spike, index_pct, regime
alerts: []
"""

# ── 数据模型 ────────────────────────────────────────────


@dataclass
class AlertCondition:
    type: str
    symbol: str = ""
    threshold: float = 0.0
    multiplier: float = 1.0
    index_code: str = ""
    regime_value: str = ""


@dataclass
class AlertNotify:
    webhook_url: str = ""
    title: str = ""


@dataclass
class AlertRule:
    id: str
    name: str = ""
    enabled: bool = True
    conditions: list[AlertCondition] = field(default_factory=list)
    notify: AlertNotify = field(default_factory=AlertNotify)
    cooldown_minutes: int = 30


# ── 规则加载 ────────────────────────────────────────────


def _ensure_default_config() -> None:
    ALERTS_YML.parent.mkdir(parents=True, exist_ok=True)
    if not ALERTS_YML.exists():
        ALERTS_YML.write_text(DEFAULT_ALERTS_YML, encoding="utf-8")


def load_alerts() -> list[AlertRule]:
    """加载并解析 alerts.yml。"""
    _ensure_default_config()
    try:
        raw = yaml.safe_load(ALERTS_YML.read_text(encoding="utf-8")) or {}
        items = raw.get("alerts", []) or []
        rules: list[AlertRule] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            conditions = [
                AlertCondition(
                    type=str(c.get("type", "")),
                    symbol=str(c.get("symbol", "")),
                    threshold=float(c.get("threshold", 0)),
                    multiplier=float(c.get("multiplier", 1.0)),
                    index_code=str(c.get("index_code", "")),
                    regime_value=str(c.get("regime_value", "")),
                )
                for c in (item.get("conditions") or [])
            ]
            notify_raw = item.get("notify") or {}
            notify = AlertNotify(
                webhook_url=_resolve_env(str(notify_raw.get("webhook_url", ""))),
                title=str(notify_raw.get("title", "")),
            )
            rules.append(
                AlertRule(
                    id=str(item.get("id", "")),
                    name=str(item.get("name", "")),
                    enabled=bool(item.get("enabled", True)),
                    conditions=conditions,
                    notify=notify,
                    cooldown_minutes=int(item.get("cooldown_minutes", 30)),
                )
            )
        return rules
    except Exception as e:
        print(f"[alert_engine] 加载规则失败: {e}")
        return []


def save_alerts(rules: list[AlertRule]) -> None:
    """将规则列表写回 alerts.yml。"""
    _ensure_default_config()
    items: list[dict[str, Any]] = []
    for r in rules:
        items.append(
            {
                "id": r.id,
                "name": r.name,
                "enabled": r.enabled,
                "conditions": [
                    {
                        "type": c.type,
                        "symbol": c.symbol,
                        "threshold": c.threshold,
                        "multiplier": c.multiplier,
                        "index_code": c.index_code,
                        "regime_value": c.regime_value,
                    }
                    for c in r.conditions
                ],
                "notify": {"webhook_url": r.notify.webhook_url, "title": r.notify.title},
                "cooldown_minutes": r.cooldown_minutes,
            }
        )
    ALERTS_YML.write_text(
        yaml.safe_dump({"alerts": items}, allow_unicode=True, default_flow_style=False),
        encoding="utf-8",
    )


def _resolve_env(value: str) -> str:
    """解析 ${ENV_VAR} 占位符。"""
    import re

    def _replacer(m: re.Match) -> str:
        return os.environ.get(m.group(1), "")

    return re.sub(r"\$\{(\w+)\}", _replacer, value)


# ── 冷却追踪 ────────────────────────────────────────────


def _load_cooldowns() -> dict[str, float]:
    try:
        if COOLDOWN_TRACKER.exists():
            return json.loads(COOLDOWN_TRACKER.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_cooldowns(data: dict[str, float]) -> None:
    COOLDOWN_TRACKER.parent.mkdir(parents=True, exist_ok=True)
    COOLDOWN_TRACKER.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _is_cooling_down(rule_id: str, cooldown_minutes: int) -> bool:
    cooldowns = _load_cooldowns()
    last_fired = cooldowns.get(rule_id, 0)
    if last_fired <= 0:
        return False
    elapsed = time.time() - last_fired
    return elapsed < (cooldown_minutes * 60)


def _mark_fired(rule_id: str) -> None:
    cooldowns = _load_cooldowns()
    cooldowns[rule_id] = time.time()
    _save_cooldowns(cooldowns)


# ── 条件评估器 ──────────────────────────────────────────


def _fetch_latest_price(symbol: str) -> float | None:
    """获取个股最新价（优先 spot snapshot，回退日线）。"""
    try:
        from integrations.data_source import fetch_stock_spot_snapshot, fetch_stock_hist

        snap = fetch_stock_spot_snapshot(symbol)
        if snap and snap.get("close") is not None:
            return float(snap["close"])

        today = datetime.now().strftime("%Y%m%d")
        start = (datetime.now() - timedelta(days=10)).strftime("%Y%m%d")
        df = fetch_stock_hist(symbol, start=start, end=today, adjust="qfq")
        if df is not None and not df.empty and "收盘" in df.columns:
            return float(df["收盘"].iloc[-1])
    except Exception as e:
        print(f"[alert_engine] 获取 {symbol} 价格失败: {e}")
    return None


def _fetch_volume_avg(symbol: str, days: int = 20) -> float | None:
    """获取个股 N 日均量。"""
    try:
        from integrations.data_source import fetch_stock_hist

        start = (datetime.now() - timedelta(days=days + 5)).strftime("%Y%m%d")
        end = datetime.now().strftime("%Y%m%d")
        df = fetch_stock_hist(symbol, start=start, end=end, adjust="qfq")
        if df is not None and not df.empty and "成交量" in df.columns:
            vols = df["成交量"].tail(days).astype(float)
            if len(vols) >= max(days // 2, 3):
                return float(vols.mean())
    except Exception as e:
        print(f"[alert_engine] 获取 {symbol} 均量失败: {e}")
    return None


def _fetch_index_pct(index_code: str) -> float | None:
    """获取指数涨跌幅（近 2 日）。"""
    try:
        from integrations.data_source import fetch_stock_hist

        start = (datetime.now() - timedelta(days=5)).strftime("%Y%m%d")
        end = datetime.now().strftime("%Y%m%d")
        df = fetch_stock_hist(index_code, start=start, end=end, adjust="qfq")
        if df is not None and not df.empty and "收盘" in df.columns:
            closes = df["收盘"].tail(2).astype(float)
            if len(closes) >= 2:
                return float((closes.iloc[-1] - closes.iloc[-2]) / closes.iloc[-2] * 100)
    except Exception as e:
        print(f"[alert_engine] 获取指数 {index_code} 涨跌幅失败: {e}")
    return None


def _get_regime() -> str | None:
    """获取当前市场水温。"""
    try:
        from tools.market_regime import detect_regime

        return detect_regime()
    except Exception:
        pass
    return None


def _evaluate_condition(cond: AlertCondition) -> tuple[bool, str]:
    """评估单个条件，返回 (是否满足, 描述)。"""
    t = cond.type

    if t == "price_above":
        price = _fetch_latest_price(cond.symbol)
        if price is None:
            return (False, f"{cond.symbol}: 无法获取价格")
        ok = price > cond.threshold
        return (ok, f"{cond.symbol}: {price:.2f} {'>' if ok else '<='} {cond.threshold:.2f}")

    if t == "price_below":
        price = _fetch_latest_price(cond.symbol)
        if price is None:
            return (False, f"{cond.symbol}: 无法获取价格")
        ok = price < cond.threshold
        return (ok, f"{cond.symbol}: {price:.2f} {'<' if ok else '>='} {cond.threshold:.2f}")

    if t == "pct_change":
        price_now = _fetch_latest_price(cond.symbol)
        if price_now is None:
            return (False, f"{cond.symbol}: 无法获取价格")
        try:
            from integrations.data_source import fetch_stock_hist

            start = (datetime.now() - timedelta(days=5)).strftime("%Y%m%d")
            end = datetime.now().strftime("%Y%m%d")
            df = fetch_stock_hist(cond.symbol, start=start, end=end, adjust="qfq")
            prev_close = float(df["收盘"].iloc[-2]) if df is not None and not df.empty and len(df) >= 2 else None
            if prev_close is None or prev_close == 0:
                return (False, f"{cond.symbol}: 无法获取前收盘价")
            pct = abs((price_now - prev_close) / prev_close * 100)
            ok = pct > cond.threshold
            return (ok, f"{cond.symbol}: |{pct:+.2f}%| {'>' if ok else '<='} {cond.threshold}%")
        except Exception as e:
            return (False, f"{cond.symbol}: 计算涨跌幅失败 ({e})")

    if t == "volume_spike":
        vol_avg = _fetch_volume_avg(cond.symbol)
        if vol_avg is None:
            return (False, f"{cond.symbol}: 无法获取均量")
        try:
            from integrations.data_source import fetch_stock_hist

            start = (datetime.now() - timedelta(days=3)).strftime("%Y%m%d")
            end = datetime.now().strftime("%Y%m%d")
            df = fetch_stock_hist(cond.symbol, start=start, end=end, adjust="qfq")
            if df is None or df.empty or "成交量" not in df.columns:
                return (False, f"{cond.symbol}: 无法获取最新成交量")
            latest_vol = float(df["成交量"].iloc[-1])
            ratio = latest_vol / vol_avg if vol_avg > 0 else 0
            ok = ratio > cond.multiplier
            return (ok, f"{cond.symbol}: 量比 {ratio:.1f}x {'>' if ok else '<='} {cond.multiplier}x")
        except Exception as e:
            return (False, f"{cond.symbol}: 计算量比失败 ({e})")

    if t == "index_pct":
        pct = _fetch_index_pct(cond.index_code)
        if pct is None:
            return (False, f"{cond.index_code}: 无法获取指数涨跌幅")
        ok = abs(pct) > cond.threshold
        return (ok, f"{cond.index_code}: |{pct:+.2f}%| {'>' if ok else '<='} {cond.threshold}%")

    if t == "regime":
        regime = _get_regime()
        if regime is None:
            return (False, "无法获取市场水温")
        ok = regime.upper() == cond.regime_value.upper()
        return (ok, f"当前水温: {regime}, 期望: {cond.regime_value}")

    return (False, f"未知条件类型: {t}")


# ── 飞书推送 ────────────────────────────────────────────


def _send_notification(rule: AlertRule, detail: str) -> bool:
    """发送飞书预警通知。"""
    webhook = rule.notify.webhook_url or os.getenv("FEISHU_WEBHOOK_URL", "")
    if not webhook:
        print(f"[alert_engine] 规则 {rule.id} 未配置 webhook_url，跳过推送")
        return False
    try:
        from utils.feishu import send_feishu_notification

        content = f"**触发条件**：\n{detail}\n\n⚠️ 本消息由预警引擎自动发送。"
        return send_feishu_notification(webhook, rule.notify.title or rule.name, content)
    except Exception as e:
        print(f"[alert_engine] 推送失败: {e}")
        return False


# ── 主入口 ──────────────────────────────────────────────


def evaluate_rule(rule: AlertRule, dry_run: bool = False) -> tuple[bool, str]:
    """评估单条规则的所有条件，全部满足时触发推送。"""
    if not rule.enabled:
        return (False, "已禁用")

    if not rule.conditions:
        return (False, "无条件")

    if _is_cooling_down(rule.id, rule.cooldown_minutes):
        return (False, f"冷却中（{rule.cooldown_minutes}分钟）")

    results: list[str] = []
    all_met = True
    for cond in rule.conditions:
        ok, desc = _evaluate_condition(cond)
        results.append(f"{'✅' if ok else '❌'} [{cond.type}] {desc}")
        if not ok:
            all_met = False

    detail = "\n".join(results)

    if all_met:
        if dry_run:
            print(f"[alert_engine] DRY-RUN [{rule.id}] '{rule.name}' 条件满足（未推送）")
        else:
            _send_notification(rule, detail)
            _mark_fired(rule.id)
            print(f"[alert_engine] ✅ [{rule.id}] '{rule.name}' 已推送")
        return (True, detail)

    return (False, detail)


def run_engine(rule_id: str | None = None, dry_run: bool = False) -> dict[str, Any]:
    """评估所有（或指定）规则，返回评估结果。"""
    rules = load_alerts()
    if not rules:
        return {"ok": True, "message": "无预警规则", "total": 0, "triggered": 0, "results": []}

    if rule_id:
        rules = [r for r in rules if r.id == rule_id]
        if not rules:
            return {"ok": False, "message": f"未找到规则: {rule_id}", "total": 0, "triggered": 0, "results": []}

    results: list[dict[str, Any]] = []
    triggered = 0
    for rule in rules:
        fired, detail = evaluate_rule(rule, dry_run=dry_run)
        results.append(
            {
                "id": rule.id,
                "name": rule.name,
                "triggered": fired,
                "detail": detail,
            }
        )
        if fired:
            triggered += 1

    return {
        "ok": True,
        "total": len(rules),
        "triggered": triggered,
        "dry_run": dry_run,
        "results": results,
    }


def list_rules() -> list[dict[str, Any]]:
    """列出所有规则（不含评估结果）。"""
    rules = load_alerts()
    return [
        {
            "id": r.id,
            "name": r.name,
            "enabled": r.enabled,
            "conditions": [{"type": c.type, "symbol": c.symbol, "threshold": c.threshold,
                          "multiplier": c.multiplier, "index_code": c.index_code,
                          "regime_value": c.regime_value} for c in r.conditions],
            "notify": {"webhook_url": r.notify.webhook_url, "title": r.notify.title},
            "cooldown_minutes": r.cooldown_minutes,
        }
        for r in rules
    ]


def add_rule(rule_dict: dict[str, Any]) -> dict[str, Any]:
    """添加或更新一条规则。"""
    rules = load_alerts()
    existing = {r.id: r for r in rules}
    uid = rule_dict.get("id", "")
    if not uid:
        return {"ok": False, "message": "规则 id 不能为空"}

    conditions = [
        AlertCondition(
            type=str(c.get("type", "")),
            symbol=str(c.get("symbol", "")),
            threshold=float(c.get("threshold", 0)),
            multiplier=float(c.get("multiplier", 1.0)),
            index_code=str(c.get("index_code", "")),
            regime_value=str(c.get("regime_value", "")),
        )
        for c in (rule_dict.get("conditions") or [])
    ]
    notify_raw = rule_dict.get("notify") or {}
    notify = AlertNotify(
        webhook_url=str(notify_raw.get("webhook_url", "")),
        title=str(notify_raw.get("title", "")),
    )
    new_rule = AlertRule(
        id=uid,
        name=str(rule_dict.get("name", uid)),
        enabled=bool(rule_dict.get("enabled", True)),
        conditions=conditions,
        notify=notify,
        cooldown_minutes=int(rule_dict.get("cooldown_minutes", 30)),
    )

    if uid in existing:
        idx = next(i for i, r in enumerate(rules) if r.id == uid)
        rules[idx] = new_rule
        save_alerts(rules)
        return {"ok": True, "message": f"规则 {uid} 已更新", "rule": uid}

    rules.append(new_rule)
    save_alerts(rules)
    return {"ok": True, "message": f"规则 {uid} 已创建", "rule": uid}


def delete_rule(rule_id: str) -> dict[str, Any]:
    """删除一条规则。"""
    rules = load_alerts()
    new_rules = [r for r in rules if r.id != rule_id]
    if len(new_rules) == len(rules):
        return {"ok": False, "message": f"未找到规则: {rule_id}"}
    save_alerts(new_rules)
    return {"ok": True, "message": f"规则 {rule_id} 已删除"}


# ── CLI ─────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="条件预警引擎")
    parser.add_argument("--dry-run", action="store_true", help="只评估不推送")
    parser.add_argument("--rule", type=str, help="只评估指定规则 ID")
    parser.add_argument("--list", action="store_true", help="列出所有规则")
    parser.add_argument("--add", type=str, help="添加规则（JSON 字符串）")
    parser.add_argument("--delete", type=str, help="删除规则 ID")
    args = parser.parse_args()

    if args.list:
        rules = list_rules()
        if not rules:
            print("暂无预警规则")
        else:
            for r in rules:
                status = "🟢" if r["enabled"] else "⚫"
                print(f"{status} [{r['id']}] {r['name']}")
                for c in r["conditions"]:
                    print(f"   ├─ {c['type']}: {c}")
        exit(0)

    if args.add:
        try:
            result = add_rule(json.loads(args.add))
            print(json.dumps(result, ensure_ascii=False))
        except json.JSONDecodeError as e:
            print(f"JSON 解析失败: {e}")
        exit(0)

    if args.delete:
        result = delete_rule(args.delete)
        print(json.dumps(result, ensure_ascii=False))
        exit(0)

    # 默认：评估
    result = run_engine(rule_id=args.rule, dry_run=args.dry_run)
    if args.dry_run or result["total"] == 0:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result["triggered"] > 0:
        print(f"✅ 触发 {result['triggered']}/{result['total']} 条规则")
    else:
        print(f"· {result['total']} 条规则均未触发")


__all__ = [
    "run_engine",
    "list_rules",
    "add_rule",
    "delete_rule",
    "load_alerts",
    "save_alerts",
    "evaluate_rule",
]
