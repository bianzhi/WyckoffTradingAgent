# Wyckoff-Analysis Development Rules

> This file is the single source of truth for code quality rules.
> All AI coding assistants (Claude Code, Cursor, Copilot, Windsurf, etc.) MUST follow these rules.

## Project Overview

Multi-market quantitative analysis system based on Wyckoff method, covering A-shares, Hong Kong stocks, US stocks, and ETFs. Python backend (CLI + MCP) + React/TypeScript web frontend.

Streamlit is fully retired from `main`: do not add, restore, or maintain Streamlit runtime code here. The historical Streamlit MVP code is preserved on the `release/streamlit` branch, and its product architecture/screenshots are archived in [docs/STREAMLIT_MVP_ARCHITECTURE.md](docs/STREAMLIT_MVP_ARCHITECTURE.md).

## Quick Commands

```bash
# Python
python -m pytest tests/ -x -q           # run tests
ruff check .                             # lint
ruff format --check .                    # format check
python scripts/quality_gate.py --ci      # function length + LOC trend

# Web (from web/ directory)
pnpm dev                                 # dev server
pnpm build                               # production build
pnpm -r exec tsc --noEmit                # typecheck
```

## Hard Rules (CI enforced, will block merge)

1. **No redundant code** — Every function, variable, and abstraction must earn its existence. Forbidden patterns:
   - Wrapper functions whose body is a single forwarded call
   - Variables that are assigned once and immediately returned
   - Intermediate abstractions with only one caller and no reuse prospect
   - Re-exports or re-declarations that add no value

2. **Pass ruff check** — All Python code must pass `ruff check .` with the project config in `pyproject.toml`.

3. **Pass ruff format** — All Python code must be formatted with `ruff format`.

4. **Pass TypeScript strict mode** — Web code must compile with `tsc --noEmit` (strict: true, noUnusedLocals, noUnusedParameters).

5. **Pass pytest** — All tests must pass. Tests must not make real network calls.

## Soft Rules (quality expectations)

1. **Function length ≤ 50 lines (hard fail)** — New functions exceeding 50 lines block merge. Whitelisted legacy functions must not grow longer (also blocks merge). Legacy violations tracked in `.metrics/func_whitelist.json`; whitelist values only ratchet down, never up.

2. **No code bloat** — If 30 lines can do the job, don't write 50. Code volume is tracked in `.metrics/loc.json`; growth >5% without corresponding feature additions will be flagged.

3. **No dead code** — Don't leave unused imports, commented-out blocks, or unreachable branches. Delete them.

4. **Comments: only when WHY is non-obvious** — Don't explain what code does. Don't reference tickets or tasks. Only explain hidden constraints or surprising behavior.

5. **No debug artifacts** — Don't commit console.log, print(), breakpoint(), or TODO/FIXME comments.

## Architecture Constraints

- **Web: no new pages** — New features go into the Agent (chat) interface, not as separate routes.
- **No Streamlit in main** — Streamlit is no longer maintained on `main`; route product work through CF Pages, CLI, MCP, or GitHub Actions.
- **Data isolation: Route A** — Signals are shared; portfolio and settings are per-user.
- **Python ≥ 3.11**, **Node ≥ 20**, **pnpm** for web workspace.

## Commit Messages

Use conventional prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.

## Before Submitting Code

```bash
ruff check . && ruff format --check . && python scripts/quality_gate.py --check-functions
```

## 待办：Web 端 CLI 功能入口缺口

> 背景：CLI (`cli/__main__.py`) 有 22 条命令，Web 端应通过 chat agent tools 或现有页面覆盖核心流程。

### CLI ↔ Web 对照

| CLI 命令 | Web 现状 | 缺口 |
|----------|---------|------|
| TUI（默认） | `/chat` 读盘室 ✅ | - |
| `screen`/`funnel` | `/funnel` 展示结果 ✅ + chat tool `trigger_funnel_screening` ✅ | funnel 页面缺少"运行漏斗"按钮，用户不知道去哪触发 |
| `backtest` | `/backtest` 粘贴 JSON ✅ | 缺少直接运行回测的入口（需传参 run_backtest） |
| `report` | chat tool `generate_ai_report` ✅ | 仅在 chat 中触发，无独立入口 |
| `diagnose` | `/portfolio` 持仓诊断 ✅ | - |
| `portfolio` | `/portfolio` 增删改查 ✅ | - |
| `signal` | ❌ 无页面 | 信号确认池（query_history signal）未暴露 |
| `recommend` | `/tracking` 跟踪表 ✅ | tracking 是业绩跟踪而非推荐列表；`wyckoff recommend` 查的是原始推荐池 |
| `memory` | ❌ 无页面 | Agent 记忆管理（list/search/clear/trace）未暴露 |
| `session` | chat.tsx localStorage 会话 ✅ | session export/fork 未做 |
| `log` | chat.tsx 历史 ✅ | - |
| `trace` | ❌ | JSONL 运行轨迹查看 |
| `prompt` | ❌ | Prompt 模板查看/渲染 |
| `diag` | ❌ | 诊断包导出 |
| `sync` | web 直连 Supabase，不需要 | - |
| `mcp` | 不需要 | - |
| `auth` | `/login` ✅ | - |
| `model` | `/settings` ✅ | - |
| `config` | `/settings` ✅ | - |

### 高优先级

1. **funnel 页面加"发起筛选"按钮** — 直接调用 `run_funnel_job()` 或插入 funnel_requests，不要只依赖 chat。
2. **Signal 信号池页** — 新增 `/signal` 路由或 chat tool `view_signals`，展示 pending/confirmed/expired 信号状态。
3. **Recommend 原始推荐列表** — tracking 页加 tab 切换「业绩跟踪」/「推荐明细」，或 chat tool `view_recommendations`。

### 低优先级

4. **Memory 管理** — `/settings` 加「记忆管理」tab，或 chat tool `manage_memory`。
5. **回测一键运行** — backtest 页加表单（hold_days/months），POST 到 background job。
6. **Session export/fork** — chat.tsx 会话菜单加导出按钮。
