"""
本地 SQLite K 线缓存 — 全市场日线数据本地化，支持增量更新。

首次运行：拉取全量 320 天日线 → 写入 SQLite（一次性 ~12 分钟）
后续运行：只拉取新增的 1~3 个交易日 → 增量写入（< 1 分钟）
典型效果：漏斗数据拉取从 10 分钟降到 30 秒。
"""

from __future__ import annotations

import logging
import os
import time
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd

from core.wyckoff_engine import normalize_hist_from_fetch
from integrations.local_db import get_db
from integrations.tickflow_client import TickFlowClient, normalize_cn_symbol
from utils.trading_clock import CN_TZ

logger = logging.getLogger(__name__)

_DDL = """
CREATE TABLE IF NOT EXISTS kline_daily (
    market     TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    open       REAL,
    high       REAL,
    low        REAL,
    close      REAL,
    volume     REAL,
    amount     REAL,
    pct_chg    REAL,
    turnover   REAL,
    PRIMARY KEY (market, symbol, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_kline_market_date ON kline_daily(market, trade_date);
CREATE INDEX IF NOT EXISTS idx_kline_market_symbol ON kline_daily(market, symbol);
"""


def ensure_kline_schema() -> None:
    """建表 + 索引，幂等（DDL 全部使用 IF NOT EXISTS）。"""
    get_db().executescript(_DDL)


def _infer_market(symbols: list[str]) -> str:
    """从标的格式推断市场：cn / hk / us。"""
    if not symbols:
        return "cn"
    sample = str(symbols[0]).strip().upper()
    if ".HK" in sample:
        return "hk"
    cleaned = sample.replace(".SZ", "").replace(".SH", "").replace(".BJ", "").replace(".", "")
    if cleaned.isdigit() and len(cleaned) <= 6:
        return "cn"
    return "us"


def get_market_latest_date(market: str) -> date | None:
    """某个市场所有标的的最新缓存日期。"""
    conn = get_db()
    cur = conn.execute(
        "SELECT MAX(trade_date) FROM kline_daily WHERE market=?",
        (market,),
    )
    row = cur.fetchone()
    if row and row[0]:
        return datetime.strptime(row[0], "%Y-%m-%d").date()
    return None


def _kline_row_tuples(market: str, symbol: str, df: pd.DataFrame) -> list[tuple]:
    """将 DataFrame 行转为 INSERT 用的 tuple 列表。"""
    rows: list[tuple] = []
    for _, row in df.iterrows():
        try:
            td = row["date"]
            if isinstance(td, (date, datetime, pd.Timestamp)):
                trade_date = pd.Timestamp(td).strftime("%Y-%m-%d")
            else:
                trade_date = str(td)[:10]
        except Exception:
            continue
        rows.append(
            (
                market,
                symbol,
                trade_date,
                float(row.get("open", 0) or 0),
                float(row.get("high", 0) or 0),
                float(row.get("low", 0) or 0),
                float(row.get("close", 0) or 0),
                float(row.get("volume", 0) or 0),
                float(row.get("amount", 0) or 0),
                float(row.get("pct_chg", 0) or 0),
                float(row.get("turnover", 0) or 0),
            )
        )
    return rows


def save_klines(market: str, symbol: str, df: pd.DataFrame) -> int:
    """
    将一只标的的日线 DataFrame 写入缓存。
    df 需经过 normalize_hist_from_fetch 处理，包含 columns:
    date, open, high, low, close, volume, amount, pct_chg, [turnover]
    """
    if df is None or df.empty:
        return 0
    required = {"date", "open", "high", "low", "close", "volume"}
    if not required.issubset(df.columns):
        logger.warning("kline_cache.save_klines: 缺少必要列 %s for %s", required - set(df.columns), symbol)
        return 0

    rows = _kline_row_tuples(market, symbol, df)
    if not rows:
        return 0

    conn = get_db()
    with conn:
        conn.executemany(
            """INSERT OR REPLACE INTO kline_daily
               (market, symbol, trade_date, open, high, low, close, volume, amount, pct_chg, turnover)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
    return len(rows)


def _df_from_db_records(recs: list[dict]) -> pd.DataFrame | None:
    """将一组 DB 行记录转为排序好的 DataFrame。"""
    if not recs:
        return None
    col_order = ["date", "open", "high", "low", "close", "volume", "amount", "pct_chg", "turnover"]
    df = pd.DataFrame(recs)
    df = df.rename(columns={"trade_date": "date"})
    available = [c for c in col_order if c in df.columns]
    df = df[available]
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.strftime("%Y-%m-%d")
    for col in ["open", "high", "low", "close", "volume", "amount", "pct_chg", "turnover"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df.sort_values("date").reset_index(drop=True)


def load_klines(
    market: str,
    symbols: list[str],
    min_date: str,
    max_date: str | None = None,
) -> dict[str, pd.DataFrame]:
    """
    从缓存加载指定标的在日期范围内的日线数据。
    返回 {symbol: DataFrame}，DataFrame 列: date, open, high, low, close, volume, amount, pct_chg, turnover
    """
    if not symbols:
        return {}
    unique_syms = list(dict.fromkeys(str(s).strip() for s in symbols if str(s).strip()))
    if not unique_syms:
        return {}

    params: list[Any] = [market]
    ph = ",".join("?" for _ in unique_syms)
    params.extend(unique_syms)
    params.append(min_date)

    sql = (
        "SELECT symbol, trade_date, open, high, low, close, volume, amount, pct_chg, turnover "
        f"FROM kline_daily WHERE market=? AND symbol IN ({ph}) AND trade_date >= ?"
    )
    if max_date:
        sql += " AND trade_date <= ?"
        params.append(max_date)
    sql += " ORDER BY symbol, trade_date"

    cur = get_db().execute(sql, params)
    rows = cur.fetchall()
    if not rows:
        return {}

    grouped: dict[str, list[dict]] = {}
    for r in rows:
        d = dict(r)
        sym = d.pop("symbol")
        grouped.setdefault(sym, []).append(d)

    result: dict[str, pd.DataFrame] = {}
    for sym, recs in grouped.items():
        df = _df_from_db_records(recs)
        if df is not None:
            result[sym] = df
    return result


def _fetch_tickflow_batch(
    client: TickFlowClient,
    symbols: list[str],
    start_ms: int | None,
    end_ms: int,
    count: int,
    batch_size: int,
    batch_sleep: float,
) -> dict[str, pd.DataFrame]:
    """从 TickFlow 批量拉取日线 raw DataFrame，返回 {symbol: DataFrame}。"""
    out: dict[str, pd.DataFrame] = {}
    total = (len(symbols) + batch_size - 1) // batch_size if symbols else 0

    for idx in range(0, len(symbols), batch_size):
        batch_no = idx // batch_size + 1
        batch = symbols[idx : idx + batch_size]
        norm_map = {normalize_cn_symbol(s): s for s in batch if s}
        clean = sorted(norm_map.keys())
        if not clean:
            continue

        params: dict[str, Any] = {"symbols": ",".join(clean), "period": "1d", "count": max(int(count), 1)}
        if start_ms is not None:
            params["start_time"] = int(start_ms)
        if end_ms:
            params["end_time"] = int(end_ms)
        params["adjust"] = "forward"

        print(f"[kline-cache] 日K批次 {batch_no}/{total} symbols={len(clean)}")
        try:
            fetched = client.get_klines_batch(
                clean,
                period="1d",
                count=count,
                start_time_ms=start_ms,
                end_time_ms=end_ms,
                adjust="forward",
            )
        except Exception as e:
            logger.error("kline_cache 批次#%d 失败: %s", batch_no, e)
            continue

        for norm_sym, df in fetched.items():
            orig_sym = norm_map.get(norm_sym, norm_sym)
            out[orig_sym] = df

        if idx + batch_size < len(symbols) and batch_sleep > 0:
            time.sleep(batch_sleep)

    return out


def _find_uncached_symbols(market: str, symbols: list[str]) -> list[str]:
    """找出缓存中完全没有任何记录的标的。"""
    unique = list(dict.fromkeys(str(s).strip() for s in symbols if str(s).strip()))
    if not unique:
        return []
    conn = get_db()
    ph = ",".join("?" for _ in unique)
    cur = conn.execute(
        f"SELECT DISTINCT symbol FROM kline_daily WHERE market=? AND symbol IN ({ph})",
        [market] + unique,
    )
    cached_set = {row[0] for row in cur.fetchall()}
    return [s for s in unique if s not in cached_set]


def _save_raw_map(market: str, raw_map: dict[str, pd.DataFrame]) -> int:
    """Normalize + save a raw TickFlow fetch result, return rows written."""
    saved = 0
    for sym, df in raw_map.items():
        norm = normalize_hist_from_fetch(df)
        if norm is not None and not norm.empty:
            saved += save_klines(market, sym, norm)
    return saved


def _end_of_day_ms(d: date) -> int:
    """Convert a date to millisecond timestamp at end of day (CN_TZ)."""
    dt = datetime.combine(d, datetime.max.time(), tzinfo=CN_TZ)
    return int(dt.timestamp() * 1000)


def _start_of_day_ms(d: date) -> int:
    """Convert a date to millisecond timestamp at start of day (CN_TZ)."""
    dt = datetime.combine(d, datetime.min.time(), tzinfo=CN_TZ)
    return int(dt.timestamp() * 1000)


def _fetch_full_klines(
    market: str,
    client: TickFlowClient,
    symbols: list[str],
    end_date: date,
    kline_count: int,
    batch_size: int,
    batch_sleep: float,
    label: str,
) -> None:
    """冷缓存/新标的：全量拉取 kline_count 天数据并写入缓存。"""
    print(f"[kline-cache] {label}: 全量拉取 {len(symbols)} 只标的 {kline_count} 天日K")
    raw_map = _fetch_tickflow_batch(
        client, symbols, None, _end_of_day_ms(end_date), kline_count, batch_size, batch_sleep
    )
    saved = _save_raw_map(market, raw_map)
    print(f"[kline-cache] {label}: 缓存已写入 {saved} 行")


def _fetch_incremental_klines(
    market: str,
    client: TickFlowClient,
    symbols: list[str],
    from_date: date,
    end_date: date,
    batch_size: int,
    batch_sleep: float,
) -> None:
    """增量拉取：从 from_date 到 end_date 的数据并写入缓存。"""
    days_behind = (end_date - from_date).days + 1
    count = max(days_behind * 2 + 8, 16)
    print(f"[kline-cache] 增量拉取 {from_date} ~ {end_date} ({days_behind}天预期) count={count} symbols={len(symbols)}")
    raw_map = _fetch_tickflow_batch(
        client, symbols, _start_of_day_ms(from_date), _end_of_day_ms(end_date), count, batch_size, batch_sleep
    )
    saved = _save_raw_map(market, raw_map)
    print(f"[kline-cache] 增量缓存已写入 {saved} 行")


def _build_fetch_stats(df_map: dict, symbols: list[str], started: float) -> dict[str, int]:
    """构建与 _tickflow_fetch_stats 兼容的统计 dict。"""
    elapsed = time.monotonic() - started
    return {
        "fetch_ok": len(df_map),
        "fetch_fail": max(len(symbols) - len(df_map), 0),
        "fetch_date_mismatch": 0,
        "fetch_spot_patched": 0,
        "fetch_elapsed_s": int(elapsed),
        "fetch_qps": int(len(df_map) / elapsed) if elapsed > 0 else 0,
    }


def refresh_market_klines(
    symbols: list[str],
    window: Any,
    *,
    batch_size: int = 200,
    batch_sleep: float = 0.55,
    kline_count: int = 320,
) -> tuple[dict[str, pd.DataFrame], dict[str, int]] | None:
    """
    确保本地 K 线缓存覆盖请求窗口，返回窗口内的 {symbol: DataFrame}。
    返回 None 表示 TickFlow 不可用（让调用方走 fallback 路径）。
    """
    if not bool(os.getenv("TICKFLOW_API_KEY", "").strip()):
        return None

    ensure_kline_schema()
    market = _infer_market(symbols)
    client = TickFlowClient(api_key=os.getenv("TICKFLOW_API_KEY", "").strip())
    start_date: date = window.start_trade_date
    end_date: date = window.end_trade_date
    latest_cached = get_market_latest_date(market)
    started = time.monotonic()

    # Step 1: 缓存中完全缺失的标的 → 全量拉取
    uncached = _find_uncached_symbols(market, symbols)
    if uncached:
        _fetch_full_klines(market, client, uncached, end_date, kline_count, batch_size, batch_sleep, "新标的")

    # Step 2: 全量冷缓存 或 增量拉取
    if latest_cached is None:
        _fetch_full_klines(market, client, symbols, end_date, kline_count, batch_size, batch_sleep, "冷缓存")
    elif latest_cached < end_date:
        _fetch_incremental_klines(
            market, client, symbols, latest_cached + timedelta(days=1), end_date, batch_size, batch_sleep
        )
    else:
        print(f"[kline-cache] {market} 缓存已是最新 ({latest_cached})，直接读取")

    # Step 3: 从缓存加载完整窗口数据
    df_map = load_klines(market, symbols, start_date.isoformat(), end_date.isoformat())
    stats = _build_fetch_stats(df_map, symbols, started)
    print(
        f"[kline-cache] 完成: 请求={len(symbols)}, 缓存命中={len(df_map)}, "
        f"耗时={stats['fetch_elapsed_s']}s, qps={stats['fetch_qps']}"
    )
    return df_map, stats
