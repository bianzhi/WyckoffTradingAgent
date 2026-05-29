"""AI 候选配额配置 —— 从环境变量读取，供 core/ 纯引擎引用。

core/ 模块不直接读取 os.getenv，所有配置通过本模块注入。
"""

from __future__ import annotations

import os
from typing import Any


def load_ai_quota_config() -> dict[str, Any]:
    """从环境变量读取 AI 候选配额配置，返回 dict 供 core 使用。"""
    return {
        "total_cap": _int_env("FUNNEL_AI_TOTAL_CAP", 12),
        "risk_on_trend": _int_env("FUNNEL_AI_RISK_ON_TREND", 7),
        "risk_on_accum": _int_env("FUNNEL_AI_RISK_ON_ACCUM", 5),
        "risk_off_trend": _int_env("FUNNEL_AI_RISK_OFF_TREND", 2),
        "risk_off_accum": _int_env("FUNNEL_AI_RISK_OFF_ACCUM", 3),
        "neutral_trend": _int_env("FUNNEL_AI_NEUTRAL_TREND", 5),
        "neutral_accum": _int_env("FUNNEL_AI_NEUTRAL_ACCUM", 5),
        "max_trend_l3_fill": _int_env("FUNNEL_AI_MAX_TREND_L3_FILL", 0),
        "max_accum_l3_fill": _int_env("FUNNEL_AI_MAX_ACCUM_L3_FILL", 0),
    }


def _int_env(name: str, default: int) -> int:
    return max(int(os.getenv(name, str(default)) or default), 0)
