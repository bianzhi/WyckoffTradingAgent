import os

# Supabase 内置 anon 凭据（需要替换为你自己的 Supabase 项目凭据）
# 前往 https://supabase.com/dashboard 创建项目，在 Settings → API 中获取
SUPABASE_ANON_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_KEY", "")

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

# Local SQLite DB path
from pathlib import Path as _Path

LOCAL_DB_PATH = _Path.home() / ".wyckoff" / "wyckoff.db"
