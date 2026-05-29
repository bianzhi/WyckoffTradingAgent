# WyckoffTradingAgent 架构文档

> 版本 1.0 · 2025-07-21 · 基于 `main` 分支深度代码审计

---

## 一、顶层鸟瞰

```
┌─────────────────────────────────────────────────────────────────────┐
│                        接入层 (3 通道)                                │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │
│  │  CLI (TUI)   │  │  Web (React+SaaS)│  │  MCP Server (Stdio)   │  │
│  │  Textual UI  │  │  CF Pages/API    │  │  Cursor/Claude 集成    │  │
│  └──────┬───────┘  └────────┬─────────┘  └───────────┬───────────┘  │
└─────────┼───────────────────┼────────────────────────┼──────────────┘
          │                   │                        │
          ▼                   ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Agent 编排层                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Orchestrator (AgentRuntime / run_stream)                     │   │
│  │  · 多轮 LLM 循环 · 并发/串行工具执行 · 死循环检测              │   │
│  │  · 自动压缩 · 工具结果裁剪 · Token 统计                       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────┐  ┌────────────────┐  ┌─────────────────────────────┐  │
│  │  Skills  │  │  Sub-Agents    │  │  Prompt Templates            │  │
│  │  (5 内置)│  │  (3 角色)      │  │  (5 内置 + 用户自定义)       │  │
│  │  工作流   │  │  工具权限隔离  │  │  可复用研究模板              │  │
│  └──────────┘  └────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         工具层 (17 工具)                              │
│  ┌──────────────┬───────────────┬──────────────┬──────────────────┐ │
│  │ 市场数据 (5)  │ 分析诊断 (3)  │ 决策交易 (4) │ 委派 & 通用 (6)  │ │
│  │ search_stock  │ analyze_stock │ portfolio    │ delegate_*   (3) │ │
│  │ market_overv  │ ai_report     │ strategy     │ exec_command     │ │
│  │ market_hist   │ screen_stocks │ update_port  │ read_file        │ │
│  │ query_history │               │ backtest     │ write_file       │ │
│  │               │               │              │ web_fetch        │ │
│  └──────────────┴───────────────┴──────────────┴──────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        核心引擎层 (core/)                             │
│  ┌──────────────────┐  ┌───────────────┐  ┌──────────────────────┐ │
│  │ Funnel Pipeline   │  │ Backtester    │  │ Holding Diagnostic   │ │
│  │ (5 层漏斗筛选)    │  │ (历史回测)    │  │ (持仓健康诊断)       │ │
│  │ L1→L2→L2.5→L3→L4 │  │               │  │                      │ │
│  │ →L5(退出信号)     │  │               │  │                      │ │
│  └──────────────────┘  └───────────────┘  └──────────────────────┘ │
│  ┌──────────────────┐  ┌───────────────┐  ┌──────────────────────┐ │
│  │ Market Regime     │  │ Sector Rotat. │  │ Signal Feedback      │ │
│  │ (大盘水温)        │  │ (板块轮动)    │  │ (信号质量追踪)       │ │
│  └──────────────────┘  └───────────────┘  └──────────────────────┘ │
│  ┌──────────────────┐  ┌───────────────┐  ┌──────────────────────┐ │
│  │ Theme Radar       │  │ Intraday       │  │ Wyckoff Events       │ │
│  │ (主线检测)        │  │ (盘中分析)     │  │ (结构触发/事件分类)  │ │
│  └──────────────────┘  └───────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        数据层 (integrations/)                        │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  统一入口: stock_hist_repository.get_stock_hist()               │ │
│  │                    ↓                                            │ │
│  │  data_source.fetch_stock_hist()   (7 源级联回退)                │ │
│  │  ┌──────┬──────┬──────┬──────┬──────┬──────┬────────────────┐ │ │
│  │  │TickFl│Tushar│AKShar│BaoSto│EFina.│EastMo│THS (概念热度)  │ │ │
│  │  │ow(付)│e(付) │e(免) │ck(免)│(免)  │ney(免│               │ │ │
│  │  └──────┴──────┴──────┴──────┴──────┴──────┴────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  持久化: SQLite (本地) + Supabase (云端)                       │ │
│  │  · 持仓 → Supabase + 本地双写                                  │ │
│  │  · 信号/推荐/尾盘 → 本地优先, Supabase 兜底                    │ │
│  │  · 用户凭据 → Supabase → wyckoff.json → 环境变量 (3 级)       │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、Skill 详细清单

### 2.1 内置 Skills（`cli/skills.py`）

Skills 是**领域特定的高层工作流**，用户通过 `/skill名` 在 CLI 中触发，或作为 Agent 自动选择的默认执行路径。

| Skill | 描述 | 触发场景 | 核心工具调用链 |
|-------|------|---------|-------------|
| **screen** | 全市场漏斗筛选 | 「帮我看今天有什么机会」「跑一下漏斗」 | screen_stocks → analyze_stock → 排序输出 Top 5 |
| **checkup** | 持仓全面体检 | 「帮我体检一下持仓」 | portfolio(diagnose) + market_overview → 综合建议 |
| **report** | AI 深度研报 | 「出个研报」「深度分析这几只」 | generate_ai_report → 三阵营分类展示 |
| **strategy** | 攻防决策 | 「该怎么操作」「给个策略」 | generate_strategy_decision → 去留指令 |
| **backtest** | 策略回测 | 「回测一下」「看看历史表现」 | run_backtest → 指标展示 + 评价 |

**可扩展性**: 用户可在 `~/.wyckoff/skills/<name>.md` 创建自定义 Skill（YAML front matter + Markdown 正文），与内置 Skill 同名时覆盖内置。

### 2.2 Sub-Agents（`cli/sub_agents.py`）

Sub-Agent 是**角色化的迷你 Agent**，每个拥有受限的工具集和专用的 system prompt，通过 `delegate_to_*` 工具由主 Orchestrator 委派任务。

| Sub-Agent | 角色 | 工具数 | 可用工具 |
|-----------|------|--------|---------|
| **research** | 研究员（数据收集） | 8 | search_stock, analyze_stock, market_overview, market_history, query_history, screen_stocks, run_backtest, check_bg_tasks |
| **analysis** | 首席分析师（深度诊断） | 5 | analyze_stock, portfolio, market_overview, market_history, generate_ai_report |
| **trading** | 交易决策官（去留指令） | 6 | portfolio, update_portfolio, generate_strategy_decision, analyze_stock, market_overview, market_history |

**设计意图**:
- `research` 负责数据采集，不提供投资建议
- `analysis` 深度使用 Wyckoff 框架拷问个股，返回结构化诊断
- `trading` 以综合人视角下达冷血指令，附 entry_zone + stop_loss + tape_condition

### 2.3 Prompt Templates（`cli/prompt_templates.py`）

Prompt Templates 是**可复用的研究对话模板**，用户通过 `/模板名 [参数]` 触发。

| Template | 描述 | 场景 |
|----------|------|------|
| **daily** | 每日盘面复盘 | 收盘后快速了解市场状态 |
| **review-l4** | L4 信号复核 | 解释漏斗输出与 AI 入选差异 |
| **holding-risk** | 持仓风险体检 | 需要操作建议时 |
| **theme-scan** | 主线扫描 | 板块轮动分析 |
| **signal-feedback** | 信号质量反馈 | 复盘信号准确率 |

**与 Skill 的区别**: Templates 侧重**对话格式的引导**，Skills 侧重**工具调用序列的编排**。两者可组合使用。

---

## 三、工具层详表

| # | 工具名 | 类型 | 数据依赖 | 认证要求 | CLI | Web |
|---|--------|------|---------|---------|-----|-----|
| 1 | `search_stock_by_name` | 查询 | AKShare(名称) + Spot(行情) | 无 | ✓ | ✓ |
| 2 | `analyze_stock` | 分析 | stock_hist_repository → data_source | Tushare(可选) | ✓ | ✓ |
| 3 | `portfolio` | 数据 | Supabase / SQLite | Supabase(云端) | ✓ | ✓ |
| 4 | `get_market_overview` | 查询 | Tushare → AKShare fallback | Tushare(可选) | ✓ | ✓ |
| 5 | `get_market_history` | 查询 | data_source.fetch_index_hist | Tushare(可选) | ✓ | ✓ |
| 6 | `screen_stocks` | 计算 | 全量 stock_hist + funnel_pipeline | Tushare(推荐) | ✓ | ✓ |
| 7 | `generate_ai_report` | LLM | 市场数据 + LLM API | LLM API Key | ✓ | ✓ |
| 8 | `generate_strategy_decision` | LLM | 持仓 + 市场 + LLM API | LLM API Key | ✓ | ✓ |
| 9 | `query_history` | 查询 | SQLite / Supabase | 无 | ✓ | ✓ |
| 10 | `update_portfolio` | 写入 | Supabase + SQLite 双写 | Supabase(云端) | ✓ | ✓ |
| 11 | `run_backtest` | 计算 | stock_hist(批量) + backtester | Tushare(推荐) | ✓ | ✓ |
| 12 | `delegate_to_research` | 委派 | 透传至 Sub-Agent | — | ✓ | ✓ |
| 13 | `delegate_to_analysis` | 委派 | 透传至 Sub-Agent | — | ✓ | ✓ |
| 14 | `delegate_to_trading` | 委派 | 透传至 Sub-Agent | — | ✓ | ✓ |
| 15 | `exec_command` | 系统 | 本地 shell | 无 | ✓ | ✗ |
| 16 | `read_file` | 系统 | 本地文件系统 | 无 | ✓ | ✗ |
| 17 | `write_file` | 系统 | 本地文件系统 | 无 | ✓ | ✗ |
| 18 | `web_fetch` | 网络 | HTTP GET | 无 | ✓ | ✗ |

---

## 四、数据源架构与审计

### 4.1 当前数据流

```
调用方 (chat_tools / MCP / scripts)
    │
    ▼
integrations/stock_hist_repository.get_stock_hist()
    │  ← 统一入口，但仅做格式标准化 + 日期切片
    ▼
integrations/data_source.fetch_stock_hist()
    │  ← 7 源级联回退逻辑在此
    ├── 1. TickFlow    (付费，优先)
    ├── 2. Tushare     (付费，次优先)
    ├── 3. AKShare     (免费，回退1)
    ├── 4. BaoStock    (免费，回退2)
    ├── 5. EFinance    (免费，回退3)
    ├── 6. EastMoney   (板块/概念/市值)
    └── 7. THS         (概念热度)
```

### 4.2 审计发现：数据源的 4 个问题

#### 问题 1：数据源选择逻辑分散在调用方而非数据层

当前每个 `chat_tools.py` 中的工具函数自行决定「要不要调 `_ensure_tushare_token()`」，而不是数据层透明处理。例如 `analyze_stock` 和 `get_market_overview` 都在进入数据源前手动注入了 Tushare Token。

**建议**: Token 注入前置到 `stock_hist_repository.get_stock_hist()`，调用方无需关心。

#### 问题 2：大盘指数和个股日线使用不同的接口和回退链

- 个股日线: `fetch_stock_hist()` → TickFlow → Tushare → AKShare → BaoStock → EFinance
- 大盘指数: `fetch_index_hist()` → Tushare → AKShare（没有 TickFlow 优先）

两个函数签名相似但回退链不同，且大盘指数不支持 TickFlow。

**建议**: 统一为 `fetch_market_data(type="stock"|"index", ...)`。

#### 问题 3：实时行情（snapshot）独立于历史数据

`fetch_stock_spot_snapshot()` 从 AKShare 获取实时快照，与历史日线数据走完全不同的路径。结果是被缓存在内存中（无持久化），且与历史数据的 source 标记不一致。

#### 问题 4：缺少数据源健康监控

虽然有 `_baostock_circuit_state()` 这样的熔断机制，但没有统一的数据源质量指标（延迟、成功率、回退频率）。`_debug_source_fail()` 只打日志不做聚合。

### 4.3 推荐：统一股票数据 Agent/Skill

```
┌─────────────────────────────────────────────┐
│         StockDataSkill / StockDataAgent      │
│                                              │
│  统一入口:                                    │
│  · get_stock_hist(code, start, end)          │
│  · get_index_hist(code, start, end)          │
│  · get_spot_snapshot(code)                   │
│  · get_market_cap_map()                      │
│  · get_sector_map()                          │
│                                              │
│  内部:                                       │
│  · 自动 Token 注入 (不依赖调用方)              │
│  · 统一回退链 (个股 = 指数)                   │
│  · 回退事件上报 (metrics)                     │
│  · 本地缓存 + 过期策略                        │
└─────────────────────────────────────────────┘
```

所有需要股票数据的工具（analyze_stock, screen_stocks, portfolio, market_overview, run_backtest）都应通过这个统一的 Skill/Agent 获取数据，而不是绕过它直接调 `data_source.py`。

---

## 五、领先性审计

### 5.1 架构优点

| 维度 | 评分 | 说明 |
|------|------|------|
| **多入口统一** | ⭐⭐⭐⭐⭐ | CLI/Web/MCP 三通道共享同一工具层和引擎层，代码复用率高 |
| **数据源级联** | ⭐⭐⭐⭐ | 7 源自动回退 + 熔断，单点故障不影响整体可用性 |
| **Sub-Agent 隔离** | ⭐⭐⭐⭐⭐ | 工具权限按角色最小化，不同 Agent 只能看到自己需要的工具 |
| **Skill 可扩展** | ⭐⭐⭐⭐ | 用户可自定义 Skill（Markdown 文件），与内置同等地位 |
| **多市场覆盖** | ⭐⭐⭐⭐ | A 股 / 港股 / 美股 / ETF，通过 market_universe 配置 |
| **Wyckoff 深度** | ⭐⭐⭐⭐⭐ | 5 层漏斗 + 7 通道 + 6 类 L4 触发 + Phase A-E 阶段识别，业界领先 |

### 5.2 待改进项

| 问题 | 严重度 | 建议 |
|------|--------|------|
| 数据源未完全统一封装 | 中 | 建 StockDataSkill，所有股票数据经由此 Skill 代理 |
| MCP Server 工具重复包装 | 低 | 不可避免（装饰器模式），但可加 `_auto_register_mcp_tools()` 自动生成 |
| Skills / Sub-Agents / Templates 三层重叠 | 低 | 明确分工：Skill=工作流编排，Sub-Agent=角色隔离，Template=对话引导 |
| `core/` vs `tools/` 边界模糊 | 低 | `tools/` 应只放纯函数工具，引擎逻辑归 `core/` |
| 大盘指数数据源不一致 | 中 | 统一 `fetch_index_hist` 和 `fetch_stock_hist` 的回退链 |
| 缺少数据源质量监控 | 中 | 增加回退频率/延迟指标，暴露为 Agent 可查询的工具 |
| 实时行情孤岛 | 低 | spot_snapshot 应与 hist 数据走同一 Skill 入口 |

### 5.3 与业界对比

| 能力 | WyckoffAgent | 传统量化平台 | GPT-based 投研 |
|------|-------------|-------------|---------------|
| Wyckoff 结构识别 | ✅ 完整 5 层 | ❌ 无 | ❌ 仅文字描述 |
| 多 Agent 协作 | ✅ 3 Sub-Agent | ❌ | ⚠️ 单 Agent |
| 数据源容错 | ✅ 7 源级联 | ⚠️ 通常单源 | ❌ 依赖训练数据 |
| 用户自定义工作流 | ✅ Skill + Template | ⚠️ 有限 | ❌ |
| 多市场统一 | ✅ A/港/美/ETF | ⚠️ 分市场 | ❌ |
| 实时盘中分析 | ✅ TickFlow 分钟线 | ✅ | ❌ |
| 信号闭环反馈 | ✅ Signal Feedback | ⚠️ 部分 | ❌ |

**结论**: 在威科夫方法论的工程化落地深度上，本项目处于领先地位。数据源统一封装是当前最值得投入的架构改进。

---

## 六、文件导航速查

| 关注点 | 关键文件 |
|--------|---------|
| 入口 (CLI) | `cli/__main__.py`, `cli/tui.py`, `cli/commands.py` |
| 入口 (Web) | `web/apps/web/src/`, `web/apps/api/src/` |
| 入口 (MCP) | `mcp_server.py` |
| Agent 运行时 | `cli/runtime.py` (AgentRuntime), `cli/agent.py` (headless wrapper) |
| Skills 定义 | `cli/skills.py` (5 内置), `~/.wyckoff/skills/*.md` (用户) |
| Sub-Agent 定义 | `cli/sub_agents.py` (3), `cli/sub_agent_prompts.py` (system prompts) |
| 工具实现 | `agents/chat_tools.py` (17 tools), `cli/tools.py` (ToolRegistry) |
| 漏斗引擎 | `core/wyckoff_engine.py` (FunnelConfig + 5 层), `core/wyckoff_events.py`, `core/wyckoff_v2_structure.py` |
| 持仓诊断 | `core/holding_diagnostic.py` (HoldingDiagnostic) |
| 回测引擎 | `core/backtester.py` |
| 市场水温 | `tools/market_regime.py` |
| 板块轮动 | `core/sector_rotation.py`, `core/theme_radar.py` |
| 信号反馈 | `core/signal_feedback.py`, `core/signal_lifecycle.py` |
| 数据源 | `integrations/data_source.py` (7 源), `integrations/stock_hist_repository.py` (统一入口) |
| 持久化 | `integrations/local_db.py` (SQLite), `integrations/supabase_*.py` (云端) |
| 凭据 | `agents/chat_tools.py:_get_credential()` (3 级回退) |
| 作业脚本 | `scripts/wyckoff_funnel.py`, `scripts/tail_buy_intraday_job.py`, `scripts/daily_job.py` |
| CI/CD | `.github/workflows/*.yml` (20+ workflows) |
