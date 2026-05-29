"""Phase 0.1 — 统一数据代理 StockDataSkill。

所有 Agent 工具函数的数据获取必须通过本模块，不直接调用 integrations/ 下的
数据源函数或第三方库（tushare/akshare/TickFlow）。本模块负责：
- Token 自动注入（ToolContext → env）
- 7 源级联回退
- 统一错误格式化
"""

from __future__ import annotations

import logging
import os
from datetime import date, timedelta
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

# ── 类型别名 ──────────────────────────────────────────────────────────────────
ToolContext = Any  # forward ref to avoid circular import


class StockDataSkill:
    """统一数据获取入口。

    用法::

        skill = StockDataSkill(tool_context)
        df = skill.fetch_stock_hist("600519", start_date, end_date)
        overview = skill.fetch_index_overview()
    """

    def __init__(self, tool_context: ToolContext | None = None) -> None:
        self._tool_context = tool_context
        self._tokens_injected = False

    # ── Token 管理 ─────────────────────────────────────────────────────────

    def _inject_tokens(self) -> None:
        """注入数据源 Token 到环境变量（幂等）。"""
        if self._tokens_injected:
            return
        # Lazy import to avoid circular dep
        from agents.chat_tools import _ensure_data_tokens

        _ensure_data_tokens(self._tool_context)
        self._tokens_injected = True

    # ── 个股 K 线 ───────────────────────────────────────────────────────────

    def fetch_stock_hist(
        self, code: str, start_date: date, end_date: date
    ) -> pd.DataFrame:
        """获取个股日线数据（7 源级联）。

        Returns:
            DataFrame，标准列名 date/open/high/low/close/volume/amount/pct_chg。
            空 DataFrame 表示所有源均失败。
        """
        self._inject_tokens()
        from integrations.stock_hist_repository import get_stock_hist

        return get_stock_hist(code, start_date, end_date)

    # ── 指数快照 ────────────────────────────────────────────────────────────

    def fetch_index_overview(self) -> dict[str, Any]:
        """获取主要 A 股指数最新快照（tushare → akshare 回退）。

        Returns:
            {"indices": {名称: {ts_code, trade_date, close, pct_chg, vol, amount}},
             "source": "tushare"|"akshare",
             "error": ...}  # 全部失败时
        """
        self._inject_tokens()
        errors: list[str] = []

        indices = {
            "000001.SH": "上证指数",
            "399001.SZ": "深证成指",
            "399006.SZ": "创业板指",
            "000016.SH": "上证50",
            "000905.SH": "中证500",
        }

        # ── 优先 tushare（有 token 时数据更稳定） ──
        try:
            from integrations.tushare_client import get_pro

            pro = get_pro()
            if pro is not None:
                end_date = date.today().strftime("%Y%m%d")
                start_date = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
                result: dict[str, dict[str, Any]] = {}
                for ts_code, name in indices.items():
                    try:
                        df = pro.index_daily(
                            ts_code=ts_code, start_date=start_date, end_date=end_date
                        )
                        if df is not None and not df.empty:
                            df = df.sort_values("trade_date")
                            latest = df.iloc[-1]
                            result[name] = {
                                "ts_code": ts_code,
                                "trade_date": str(latest.get("trade_date", "")),
                                "close": round(float(latest.get("close", 0)), 2),
                                "pct_chg": round(float(latest.get("pct_chg", 0)), 2),
                                "vol": int(latest.get("vol", 0)),
                                "amount": round(float(latest.get("amount", 0)), 2),
                            }
                    except Exception as e:
                        result[name] = {"error": str(e)}
                if result:
                    return {"indices": result, "source": "tushare"}
            else:
                errors.append("tushare: token 未配置或 client 不可用")
        except Exception as e:
            errors.append(f"tushare: {e}")

        # ── 兜底 akshare ──
        try:
            import akshare as ak

            spot = ak.stock_zh_index_spot_em()
            if spot is None or spot.empty:
                errors.append("akshare: stock_zh_index_spot_em 返回空")
            else:
                col_code = _spot_col(spot, "代码", "指数代码")
                col_name = _spot_col(spot, "名称", "指数名称")
                col_close = _spot_col(spot, "最新价", "最新")
                col_pct = _spot_col(spot, "涨跌幅", "涨跌幅(%)")
                col_vol = _spot_col(spot, "成交量")
                col_amount = _spot_col(spot, "成交额")

                if not col_code:
                    errors.append("akshare: 缺少指数代码列")
                else:
                    code_to_ts = {
                        "000001": "000001.SH", "399001": "399001.SZ",
                        "399006": "399006.SZ", "000016": "000016.SH",
                        "000905": "000905.SH",
                    }
                    target_codes = set(code_to_ts.keys())
                    today = date.today().strftime("%Y%m%d")
                    result = {}
                    for _, row in spot.iterrows():
                        code_raw = str(row.get(col_code, "") or "").strip()
                        code = "".join(ch for ch in code_raw if ch.isdigit())[-6:]
                        if code not in target_codes:
                            continue
                        name_cn = (
                            str(row.get(col_name, "") or "").strip()
                            or indices[code_to_ts[code]]
                        )
                        result[name_cn] = _build_index_record(
                            code_to_ts[code], today, row, col_close, col_pct, col_vol, col_amount
                        )
                    if result:
                        return {"indices": result, "source": "akshare"}
                    errors.append("akshare: 目标指数未命中")
        except Exception as e:
            errors.append(f"akshare: {e}")

        return {"error": "无法获取大盘数据", "details": "; ".join(errors) if errors else "unknown"}

    # ── 指数历史日线 ─────────────────────────────────────────────────────────

    def fetch_index_hist(
        self, symbol: str, start: date, end: date
    ) -> pd.DataFrame:
        """获取指数历史日线（多源回退）。

        Args:
            symbol: 如 "000001.SH"
        """
        self._inject_tokens()
        from integrations.data_source import fetch_index_hist

        return fetch_index_hist(symbol, start, end)

    # ── 数据源健康 ──────────────────────────────────────────────────────────

    def health(self) -> dict[str, Any]:
        """返回各数据源健康状态。"""
        try:
            from integrations.data_source import get_data_source_health
            return get_data_source_health()
        except Exception as e:
            logger.exception("StockDataSkill.health error")
            return {"error": str(e)}

    # ── 实时快照 ────────────────────────────────────────────────────────────

    def fetch_stock_spot(self, code: str) -> dict[str, Any] | None:
        """获取单只股票的实时快照。"""
        try:
            from integrations.data_source import fetch_stock_spot_snapshot
            return fetch_stock_spot_snapshot(code)
        except Exception:
            logger.debug("fetch_stock_spot_snapshot failed for %s", code, exc_info=True)
            return None

    def fetch_market_cap_map(self) -> dict[str, float]:
        """获取全市场流通市值映射（code → 亿）。"""
        try:
            from integrations.data_source import fetch_market_cap_map
            return fetch_market_cap_map()
        except Exception:
            logger.debug("fetch_market_cap_map failed", exc_info=True)
            return {}


# ── helpers ──────────────────────────────────────────────────────────────────

def _spot_col(df: pd.DataFrame, *candidates: str) -> str:
    """返回 DataFrame 中第一个存在的候选列名。"""
    for c in candidates:
        if c in df.columns:
            return c
    return ""


def _build_index_record(
    ts_code: str,
    trade_date: str,
    row: pd.Series,
    col_close: str,
    col_pct: str,
    col_vol: str,
    col_amount: str,
) -> dict[str, Any]:
    def _f(key: str) -> float:
        try:
            return float(row.get(key, 0) or 0)
        except Exception:
            return 0.0

    return {
        "ts_code": ts_code,
        "trade_date": trade_date,
        "close": round(_f(col_close), 2),
        "pct_chg": round(_f(col_pct), 2),
        "vol": int(_f(col_vol)),
        "amount": round(_f(col_amount), 2),
    }
