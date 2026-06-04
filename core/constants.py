# ── 数据列名映射（中→英）────────────────────────────────────────────────────
# 用于 normalize_hist_from_fetch() 等适配层
COL_MAP: dict[str, str] = {
    "日期": "date",
    "开盘": "open",
    "最高": "high",
    "最低": "low",
    "收盘": "close",
    "成交量": "volume",
    "成交额": "amount",
    "涨跌幅": "pct_chg",
}

# Supabase 内置 anon 凭据（在 integrations/supabase_base.py 中通过环境变量注入）
# 前往 https://supabase.com/dashboard 创建项目，在 Settings → API 中获取
SUPABASE_ANON_URL = ""
SUPABASE_ANON_KEY = ""

# Database Table Names
TABLE_USER_SETTINGS = "user_settings"
TABLE_MARKET_SIGNAL_DAILY = "market_signal_daily"
TABLE_RECOMMENDATION_TRACKING = "recommendation_tracking"
TABLE_RECOMMENDATION_TRACKING_US = "recommendation_tracking_us"
TABLE_RECOMMENDATION_TRACKING_HK = "recommendation_tracking_hk"
TABLE_SIGNAL_PENDING = "signal_pending"
TABLE_PORTFOLIOS = "portfolios"
TABLE_PORTFOLIO_POSITIONS = "portfolio_positions"
TABLE_TRADE_ORDERS = "trade_orders"
TABLE_DAILY_NAV = "daily_nav"
TABLE_TAIL_BUY_HISTORY = "tail_buy_history"
TABLE_WHITELIST = "whitelist"
TABLE_CONCEPT_HEAT_HISTORY = "concept_heat_history"
TABLE_SIGNAL_OBSERVATIONS = "signal_observations"
TABLE_SIGNAL_OUTCOMES = "signal_outcomes"
TABLE_SIGNAL_HEALTH_DAILY = "signal_health_daily"
TABLE_SIGNAL_REGISTRY = "signal_registry"
TABLE_SIGNAL_POLICY_SHADOW_RUNS = "signal_policy_shadow_runs"
TABLE_THEME_RADAR_SNAPSHOT = "theme_radar_snapshot"

# Local SQLite DB path — 优先使用环境变量 WYCKOFF_DB_PATH（Docker volume 持久化）
import os
from pathlib import Path as _Path

_LOCAL_DB_ENV = os.environ.get("WYCKOFF_DB_PATH", "").strip()
LOCAL_DB_PATH = _Path(_LOCAL_DB_ENV) if _LOCAL_DB_ENV else _Path.home() / ".wyckoff" / "wyckoff.db"
