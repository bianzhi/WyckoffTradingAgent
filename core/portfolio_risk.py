"""
组合风险管理 — 公共 API 转发层。

将 tools/portfolio_risk.py 中被其他模块引用的函数集中 re-export，
使消费者从 core/ 导入而非直接从 tools/ 导入，保持分层干净。
"""

from tools.portfolio_risk import (  # noqa: F401
    correlation_matrix,
    cvar,
    generate_risk_report,
    historical_var,
    max_drawdown,
    parametric_var,
    stress_test,
)

__all__ = [
    "correlation_matrix",
    "cvar",
    "generate_risk_report",
    "historical_var",
    "max_drawdown",
    "parametric_var",
    "stress_test",
]
