# WyckoffTradingAgent 架构审计与产品路线图

> 版本 2.0 · 2025-07-22 · 深度代码审计 + 架构评估 + 功能计划

---

## 一、架构全景图

```
                            ┌──────────────────────────────────────┐
                            │         接入层 (3 通道)               │
                            │                                      │
                            │  CLI (TUI)    Web (React+CF)   MCP   │
                            │  Textual UI   Pages/API/Hono   Stdio │
                            └──────┬──────────────┬──────────┬─────┘
                                   │              │          │
                                   ▼              ▼          ▼
                            ┌──────────────────────────────────────┐
                            │       Agent 运行时 (AgentRuntime)     │
                            │                                      │
                            │  · LLM 多轮循环 · 死循环检测         │
                            │  · 并发/串行工具执行 · 自动压缩      │
                            │  · 流式事件总线 · Scratchpad 追踪    │
                            └──────────────┬───────────────────────┘
                                   │       │       │
                    ┌──────────────┼───────┼───────┼──────────────┐
                    ▼              ▼       ▼       ▼              ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐
              │ Skills   │ │Sub-Agents│ │Templates │ │ ToolRegistry │
              │ 5 内置   │ │ 3 角色   │ │ 5 内置   │ │ 17 tools     │
              │ +自定义  │ │ 权限隔离 │ │ +自定义  │ │              │
              └──────────┘ └──────────┘ └──────────┘ └──────┬───────┘
                                                           │
              ┌────────────────────────────────────────────┼───────┐
              │              核心引擎层 (core/)             │       │
              │                                            │       │
              │  ┌────────────────┐  ┌──────────────────┐  │       │
              │  │ Funnel Pipeline│  │ Holding Diag.    │  │       │
              │  │ L1→L2→L2.5→   │  │ 持仓健康度诊断    │◄─┘       │
              │  │ L3→L4→L5      │  └──────────────────┘          │
              │  │ 7通道+6触发   │                                 │
              │  └────────────────┘  ┌──────────────────┐          │
              │                      │ Wyckoff Engine   │          │
              │  ┌────────────────┐  │ Phase A-E 识别    │          │
              │  │ Backtester     │  │ Markup/Dist.      │          │
              │  │ 网格回测       │  └──────────────────┘          │
              │  └────────────────┘                                 │
              │  ┌────────────────┐  ┌──────────────────┐          │
              │  │ Sector Rot.    │  │ Theme Radar      │          │
              │  │ 板块轮动       │  │ 主线检测          │          │
              │  └────────────────┘  └──────────────────┘          │
              │  ┌────────────────┐  ┌──────────────────┐          │
              │  │ Signal Feedback│  │ Market Regime    │          │
              │  │ 信号质量追踪   │  │ 大盘水温          │          │
              │  └────────────────┘  └──────────────────┘          │
              └────────────────────────────────────────────────────┘
                                          │
                                          ▼
              ┌────────────────────────────────────────────────────┐
              │              数据层 (integrations/)                │
              │                                                    │
              │  stock_hist_repository → data_source (7源级联)     │
              │  ┌─────────┬─────────┬────────┬────────┬────────┐ │
              │  │TickFlow │ Tushare │AKShare │BaoStock│EFinance│ │
              │  │ (付费)  │ (付费)  │ (免费) │ (免费) │ (免费) │ │
              │  └─────────┴─────────┴────────┴────────┴────────┘ │
              │  ┌─────────┬─────────┐                            │
              │  │EastMoney│ 同花顺   │  (板块/概念/市值)          │
              │  │(免费)   │ (免费)   │                            │
              │  └─────────┴─────────┘                            │
              │                                                    │
              │  持久化: SQLite(本地) + Supabase(云端) 双写        │
              │  凭据: Supabase → wyckoff.json → env (3级回退)    │
              └────────────────────────────────────────────────────┘
```

### 1.1 关键数据流

```
用户输入 (CLI/Web/MCP)
  → AgentRuntime.run_stream() 启动 LLM 循环
  → LLM 返回 tool_calls (可并发/串行分批)
  → ToolRegistry.execute() 执行工具函数
  → 工具函数调用 core/ 引擎 + integrations/ 数据源
  → 结果注入 messages[] 回传 LLM
  → 循环直到 LLM 返回最终文本 或 达到 max_tool_rounds
  → 返回 RuntimeEvent 流 (供 UI 渲染)
```

---

## 二、模块分层详析

### 2.1 接入层

| 通道 | 入口 | 运行时 | 用户交互 | 工具暴露 |
|------|------|--------|---------|---------|
| **CLI (TUI)** | `cli/__main__.py` → `tui.py` | Textual 框架 | 终端内聊天 UI | 全部 17 工具 |
| **Web** | `web/apps/web/src/` → CF Pages | React + Hono API | 浏览器聊天界面 | 14 工具(无 exec/read/write/web_fetch) |
| **MCP** | `mcp_server.py` | FastMCP (stdio) | Cursor/Claude 等 AI IDE | 12 工具(无 query_history 外的本地工具) |

**架构特点**：三通道共享同一工具函数实现（`agents/chat_tools.py`），通过 `ToolContext` 对象传递用户上下文字段（user_id, access_token），实现"一次实现，三端复用"。

### 2.2 Agent 编排层

| 组件 | 文件 | 职责 |
|------|------|------|
| **AgentRuntime** | `cli/runtime.py` | Provider-agnostic 的 LLM 循环引擎；支持流式输出、并发工具执行、死循环检测、自动消息压缩 |
| **ToolRegistry** | `cli/tools.py` | 工具注册/反注册；并发安全标记；schema 生成 |
| **Scratchpad** | `cli/scratchpad.py` | 记录每次 Agent 运行的 thinking/tool_result/compaction，支持复盘审计 |
| **Compaction** | `cli/compaction.py` | 上下文窗口逼近上限时自动压缩历史消息 |
| **Loop Guard** | `cli/loop_guard.py` | 死循环检测（同参数重复 ≥3 次触发 doom-loop 中止） |

**并发策略**：`partition_tool_calls()` 将相邻的 `concurrency_safe` 工具归入同一批次并行执行（ThreadPoolExecutor），非安全工具串行执行。当前标记为并发安全的工具包括 `analyze_stock`、`search_stock_by_name`、`run_backtest`、`read_file`、`web_fetch`。

### 2.3 Skills / Sub-Agents / Templates 三层协作

```
┌─────────────────────────────────────────────────────────┐
│  Skills (工作流编排)                                     │
│  /screen → screen_stocks → analyze_stock × N → 排序输出 │
│  /checkup → portfolio(diagnose) → market_overview → 建议│
│  /report → generate_ai_report → 三阵营分类展示           │
│  /strategy → generate_strategy_decision → 去留指令       │
│  /backtest → run_backtest → 指标展示                     │
│                                                         │
│  用户可自定义: ~/.wyckoff/skills/<name>.md              │
├─────────────────────────────────────────────────────────┤
│  Sub-Agents (角色隔离/权限最小化)                        │
│  research  → 8 tools (数据收集，不提供建议)              │
│  analysis  → 5 tools (深度诊断，Wyckoff 语言)            │
│  trading   → 6 tools (冷血去留指令，含入场/止损)         │
│                                                         │
│  由 Orchestrator 通过 delegate_to_* 工具委派             │
├─────────────────────────────────────────────────────────┤
│  Prompt Templates (对话格式引导)                         │
│  /daily, /review-l4, /holding-risk, /theme-scan,        │
│  /signal-feedback                                       │
│                                                         │
│  侧重对话格式，与 Skills 可组合使用                       │
└─────────────────────────────────────────────────────────┘
```

**三层边界清晰**：
- **Skill** = 工具调用序列的编排（what to do）
- **Sub-Agent** = 角色权限 + 系统提示词（who does it）
- **Template** = 对话格式引导（how to present）

### 2.4 工具层（17 工具）

| # | 工具名 | 类型 | 数据依赖 | CLI | Web | MCP |
|---|--------|------|---------|-----|-----|-----|
| 1 | `search_stock_by_name` | 查询 | AKShare + Spot | ✓ | ✓ | ✓ |
| 2 | `analyze_stock` | 分析 | stock_hist_repo → 7源 | ✓ | ✓ | ✓ |
| 3 | `portfolio` | 数据 | Supabase / SQLite | ✓ | ✓ | ✓ |
| 4 | `get_market_overview` | 查询 | Tushare → AKShare | ✓ | ✓ | ✓ |
| 5 | `get_market_history` | 查询 | data_source.fetch_index_hist | ✓ | ✓ | ✓ |
| 6 | `screen_stocks` | 计算 | 全量stock_hist + funnel | ✓ | ✓ | ✓ |
| 7 | `generate_ai_report` | LLM | LLM API | ✓ | ✓ | ✓ |
| 8 | `generate_strategy_decision` | LLM | 持仓 + LLM API | ✓ | ✓ | ✓ |
| 9 | `query_history` | 查询 | SQLite / Supabase | ✓ | ✓ | ✓ |
| 10 | `update_portfolio` | 写入 | Supabase + SQLite 双写 | ✓ | ✓ | ✓ |
| 11 | `run_backtest` | 计算 | stock_hist(批量) + backtester | ✓ | ✓ | ✓ |
| 12-14 | `delegate_to_{research,analysis,trading}` | 委派 | LLM + Provider注入 | ✓ | ✓ | ✗ |
| 15 | `exec_command` | 系统 | 本地 shell (沙箱限制) | ✓ | ✗ | ✗ |
| 16 | `read_file` | 系统 | 本地文件 (路径白名单) | ✓ | ✗ | ✗ |
| 17 | `write_file` | 系统 | 本地文件 (后缀白名单) | ✓ | ✗ | ✗ |
| 18 | `web_fetch` | 网络 | HTTP GET (IP/URL校验) | ✓ | ✗ | ✗ |

### 2.5 核心引擎层

| 引擎 | 文件 | 核心能力 | 复杂度 |
|------|------|---------|--------|
| **Funnel Pipeline** | `core/wyckoff_engine.py` | 5层漏斗：L1垃圾过滤→L2七通道甄选→L2.5 Markup加速→L3板块共振→L4六类狙击触发→L5退出信号 | 极高 |
| **Wyckoff Events** | `core/wyckoff_events.py` | Spring/SOS/LPS/EvR/Compression/TrendPullback 6类L4触发识别 | 高 |
| **Wyckoff V2 Structure** | `core/wyckoff_v2_structure.py` | Phase A-E 阶段识别 + Markup/Distribution 判断 | 高 |
| **Backtester** | `core/backtester.py` | 网格回测引擎（滑点/止损/止盈/夏普/最大回撤） | 中 |
| **Holding Diagnostic** | `core/holding_diagnostic.py` | 持仓健康度多维度评分 | 中 |
| **Market Regime** | `tools/market_regime.py` | 大盘水温（RISK_ON/RISK_OFF/NEUTRAL/CRASH/BLACK_SWAN） | 中 |
| **Sector Rotation** | `core/sector_rotation.py` | 板块轮动分析 + RPS 动量 | 中 |
| **Theme Radar** | `core/theme_radar.py` | 主线检测（连续N天上榜概念识别） | 低 |
| **Signal Feedback** | `core/signal_feedback.py` | 信号质量追踪/闭环反馈 | 中 |
| **Dynamic Policy** | `core/dynamic_policy.py` | AI候选配额动态调整（市场行情自适应） | 低 |
| **Intraday Analysis** | `core/intraday_analysis.py` | 盘中分钟线分析（TickFlow依赖） | 低 |

**L2 七通道甄选**（漏斗最具差异化的设计）：
1. **主升通道**：MA50>MA200，RPS双周期强势，RS跑赢大盘
2. **潜伏通道**：长强短弱，回踩蓄势待发（RPS120强但RPS50弱）
3. **吸筹通道**：低位横盘+量能萎缩+均线胶着（Wyckoff Accumulation ABC）
4. **地量蓄势通道**：年内最低量能级别，卖压枯竭
5. **暗中护盘通道**：大盘创新低但个股拒绝创新低（RS Divergence）
6. **趋势延续通道**：已确认多头趋势，回撤可控
7. **加速突破通道**：底部刚起步，短期动量爆发

**L4 六类狙击触发**：Spring（弹簧）| SOS（强势信号）| LPS（最后支撑）| Effort vs Result | Compression（压缩蓄势）| Trend Pullback（趋势回踩）

### 2.6 数据层

**数据获取链路**：
```
stock_hist_repository.get_stock_hist(code, start, end)
  → data_source.fetch_stock_hist()
    → 1. TickFlow (付费API，优先)
    → 2. Tushare  (付费API，次优先)
    → 3. AKShare  (免费，回退1)
    → 4. BaoStock  (免费，回退2，带熔断)
    → 5. EFinance  (免费，回退3)
```

**辅助数据源**：
- 实时行情：`akshare.stock_zh_a_spot_em`（内存缓存20s TTL）
- 行业映射：Tushare `stock_basic`（缓存24h）
- 市值数据：Tushare `daily_basic`（缓存24h）
- 概念板块：东财 `datacenter-web` API（缓存24h）
- 概念热度：同花顺首页 `gnSection` 解析（缓存4h）

**持久化策略**：
- SQLite（本地）：信号/推荐/尾盘买入记录
- Supabase（云端）：持仓/用户设置/信号（双写）
- 概念热度历史：本地JSON + Supabase双写

**凭据管理**（三层回退）：
```
_get_credential(key)
  1. Supabase user_settings 表（已登录用户，5min缓存）
  2. ~/.wyckoff/wyckoff.json 本地配置（CLI login 写入）
  3. os.getenv() 环境变量（兜底）
```

---

## 三、架构先进性评估

### 3.1 评分矩阵

| 维度 | 评分 | 业界对比 | 说明 |
|------|:----:|---------|------|
| **Wyckoff 方法论工程化深度** | ⭐⭐⭐⭐⭐ | 全球领先 | 5层漏斗+7通道+6触发+Phase A-E识别，市面上无同类产品 |
| **多入口统一** | ⭐⭐⭐⭐⭐ | 领先 | CLI/Web/MCP 三通道共享同一工具层和引擎层 |
| **数据源容错** | ⭐⭐⭐⭐☆ | 领先 | 7源级联+熔断机制，单点故障不影响可用性 |
| **Sub-Agent 权限隔离** | ⭐⭐⭐⭐⭐ | 领先 | 角色化工具权限最小化，不同Agent只能看到授权工具 |
| **Skill 可扩展性** | ⭐⭐⭐⭐☆ | 良好 | 用户可自定义Skill（Markdown/YAML），与内置同等地位 |
| **多市场覆盖** | ⭐⭐⭐⭐☆ | 良好 | A股/港股/美股/ETF 统一框架 |
| **安全防护** | ⭐⭐⭐⭐⭐ | 领先 | 工具层深度沙箱（路径白名单/命令黑名单/URL校验/敏感信息过滤） |
| **回测引擎** | ⭐⭐⭐☆ | 中等 | 网格回测功能完整，但无 Walk-forward 优化和 Monte Carlo |
| **实时性** | ⭐⭐⭐☆ | 中等 | 有盘中分钟线(TickFlow)和实时快照(AKShare)，但无WebSocket推送 |
| **前端体验** | ⭐⭐⭐☆ | 中等 | React聊天界面功能完善，但无专业的图表可视化 |
| **CI/CD 自动化** | ⭐⭐⭐⭐⭐ | 领先 | 20+ GitHub Actions workflows，覆盖漏斗、尾盘、回测、诊断全流程 |
| **代码质量** | ⭐⭐⭐⭐☆ | 良好 | ruff + tsc strict + pytest + quality_gate 自动化检查 |

### 3.2 核心优势

**1. Wyckoff 方法论的工程化闭环（最大壁垒）**

这是本项目最核心的竞争力。市面上大多数量化平台只提供技术指标和回测框架，而本项目将 Richard Wyckoff 的整套方法论（吸筹/拉升/派发/下跌 + Spring/SOS/LPS/EvR）完整工程化为 5 层漏斗筛选引擎，且每一层都有清晰的数学定义和可配置参数。这不是一个"用AI包装的传统量化工具"，而是一个"将人类交易大师的方法论转化为可执行的算法的系统"。

**2. Agent 原生架构**

不是"在传统量化平台上加个 Chatbot"，而是从底层设计为 Agent-first：所有能力以 tool 形式暴露给 LLM，LLM 通过 tool calling 自主决策调用哪些工具、如何组合、如何解读结果。Skills/Sub-Agents/Templates 三层提供不同粒度的编排能力。

**3. 安全深度防御**

工具层的安全设计极为严谨：exec_command 禁止 shell 控制符和 30+ 高风险命令，read_file/write_file 有严格的路径白名单和文件后缀白名单，web_fetch 防止 SSRF（校验私有IP/本地域名/非标准端口）。这在 AI Agent 领域是少见的深度安全设计。

**4. 数据源容错架构**

7源级联 + 熔断 + 缓存过期策略 + 原子写入，确保在任一数据源不可用时系统仍能正常运行。`stock_hist_repository` 统一入口 + `data_source` 级联回退，调用方无需关心底层数据源选择。

### 3.3 关键短板

| # | 问题 | 严重度 | 影响 |
|---|------|:------:|------|
| 1 | **数据源未统一封装** | 高 | 个股日线、大盘指数、实时快照走不同函数和不同回退链，调用方需手动注入Token |
| 2 | **LLM 推理强依赖** | 高 | screen/checkup/report/strategy 全部依赖 LLM API 调用，无本地降级方案；LLM 不可用时系统核心功能瘫痪 |
| 3 | **前后端数据流断裂** | 高 | Web API 是 TypeScript（Hono/CF Workers），核心引擎是 Python，Web端只做轻量转发，真正的分析能力在 Python 端无法被 Web 直接调用 |
| 4 | **无数据源健康监控** | 中 | 有 `_debug_source_fail()` 日志但不聚合，无法主动发现数据源降级趋势 |
| 5 | **回测策略单一** | 中 | 只有固定参数网格回测，无 Walk-forward 优化、蒙特卡洛模拟、参数敏感性分析 |
| 6 | **缺少持仓风险管理** | 中 | 有个股止损，但缺少组合层面的 VaR/CVaR、相关性矩阵、压力测试 |
| 7 | **无专业图表** | 中 | Web端纯文本聊天，无K线图、资金曲线图、威科夫标注图 |
| 8 | **实时行情弱** | 低 | 只有 20s TTL 的内存缓存快照，无 WebSocket 推送，盘中盯盘能力薄弱 |
| 9 | **MCP 工具不完整** | 低 | delegate_to_* 和本地系统工具在 MCP 中未暴露 |
| 10 | **港股/美股数据质量低** | 低 | 7源级联主要针对A股，港股美股数据覆盖差 |

### 3.4 架构债务清单

| 债务 | 位置 | 说明 |
|------|------|------|
| `_ensure_tushare_token()` 散布在工具函数中 | `chat_tools.py` 多处 | Token注入应由数据层透明处理 |
| `fetch_stock_hist` vs `fetch_index_hist` 回退链不一致 | `data_source.py` | 大盘指数不支持TickFlow优先 |
| spot_snapshot 独立于历史数据流 | `data_source.py` | 实时快照和历史数据走不同路径，source标记不一致 |
| MCP 工具函数是手写包装 | `mcp_server.py` | 无自动从 WYCKOFF_TOOLS 列表生成装饰器 |
| JavaScript 侧重复实现部分工具逻辑 | `web/apps/api/src/routes/` | Python引擎能力未完全暴露为API |

---

## 四、与业界方案对比

| 能力 | WyckoffAgent | 传统量化平台(JoinQuant/MiniQMT) | AI投研(GPT/Claude) | 专业交易终端(TC2000/SC) |
|------|:---:|:---:|:---:|:---:|
| Wyckoff 结构识别 | ✅ 完整5层 | ❌ | ❌ 仅文字描述 | ⚠️ 部分指标 |
| 多Agent协作 | ✅ 3 Sub-Agent | ❌ | ❌ 单Agent | ❌ |
| 数据源容错 | ✅ 7源级联 | ⚠️ 1-2源 | ❌ | ⚠️ 商业数据源 |
| 用户自定义工作流 | ✅ Skill + Template | ⚠️ 有限 | ❌ | ⚠️ 扫描条件 |
| 多市场统一 | ✅ A/港/美/ETF | ⚠️ 分市场 | ❌ | ✅ 多市场 |
| 自然语言交互 | ✅ Chat UI | ❌ | ✅ | ❌ |
| 信号闭环反馈 | ✅ Signal Feedback | ⚠️ 部分 | ❌ | ❌ |
| 全自动漏斗筛选 | ✅ 定时GitHub Actions | ⚠️ 需手动触发 | ❌ | ⚠️ 需手动 |
| 持仓诊断 | ✅ AI多维度 | ⚠️ 基础 | ⚠️ 可对话 | ⚠️ 基础 |
| 图表可视化 | ❌ | ⚠️ 基础 | ❌ | ✅ 专业 |
| 实时行情推送 | ❌ | ⚠️ 部分 | ❌ | ✅ Level 2 |
| 组合风险管理 | ❌ | ⚠️ 基础 | ❌ | ⚠️ 部分 |

**定位结论**：WyckoffTradingAgent 不是一个"万能量化平台"，而是在**威科夫方法论驱动的智能选股与持仓诊断**这个细分领域做到极致。其核心竞争力不在执行层（交易终端的事），而在**分析决策层**。

---

## 五、产品功能路线图

### 原则

1. **不追求大而全**——聚焦威科夫方法论驱动决策这一核心定位
2. **先修架构债务，再做新功能**——数据层统一封装是第一优先级
3. **每个 phase 产出可独立交付和验证**——不搞"大爆炸"式发布
4. **Web 端能力对齐 CLI**——三通道体验一致

### Phase 0：架构筑基（2周）

**目标**：修复关键架构债务，为后续功能铺路

| 任务 | 优先级 | 说明 |
|------|:------:|------|
| 统一数据源封装 `StockDataSkill` | P0 | 个股/指数/快照统一入口，Token自动注入，回退链一致 |
| 数据源健康监控面板 | P1 | 回退频率、延迟、成功率指标聚合，暴露为 Agent 可查询工具 |
| `core/` vs `tools/` 目录边界清理 | P1 | 引擎逻辑归 core/，纯函数工具归 tools/ |
| LLM 降级策略 | P1 | LLM 不可用时，漏斗/回测/诊断仍可通过 CLI `--headless` 模式直接输出 |

### Phase 1：数据与可视化（3周）

**目标**：补齐最明显的用户体验短板

| 任务 | 优先级 | 说明 |
|------|:------:|------|
| K线图表组件 | P0 | Web端嵌入轻量K线图（ECharts/Lightweight Charts），支持威科夫标注叠加 |
| 实时行情 WebSocket | P1 | TickFlow分钟线推送 → Web端实时更新 |
| 漏斗结果可视化 | P1 | 漏斗各层通过率、板块热力图、L4触发分布图 |
| 回测结果图表化 | P2 | 资金曲线图、回撤曲线、月度收益热力图 |

### Phase 2：决策增强（4周）

**目标**：提升分析深度和决策质量

| 任务 | 优先级 | 说明 |
|------|:------:|------|
| 组合风险管理 | P0 | VaR/CVaR、相关性矩阵、压力测试、最大回撤预期 |
| 回测引擎增强 | P1 | Walk-forward 优化、Monte Carlo 模拟、参数敏感性分析 |
| 高级出场策略 | P1 | Trailing stop 优化、时间止损、波动率自适应止损 |
| 信号质量仪表板 | P1 | L4 各触发类型的历史胜率、盈亏比、平均持仓天数 |
| 多时间框架分析 | P2 | 周线/日线/60分钟线联动确认 |

### Phase 3：自动化与智能体（3周）

**目标**：让系统从"工具"进化为"助手"

| 任务 | 优先级 | 说明 |
|------|:------:|------|
| 定时智能播报 | P0 | 每天盘前/盘中/盘后自动推送关键信息到飞书/微信 |
| 条件预警 Agent | P1 | 用户设置条件（如"Spring触发+成交额>1亿"），满足时自动通知 |
| 自适应参数调优 | P1 | 根据市场行情(RISK_ON/OFF)自动调整漏斗参数 |
| 交易日志自动分析 | P2 | 从交易记录中学习，识别个人交易模式偏差 |

### Phase 4：体验与生态（持续）

| 任务 | 优先级 | 说明 |
|------|:------:|------|
| MCP 工具补全 | P1 | delegate_to_* 在 MCP 中可用 |
| 移动端适配 | P2 | Web端响应式 + PWA |
| 社区 Skill 市场 | P3 | 用户可发布/安装他人创建的 Skills |
| 多语言支持 | P3 | 英文界面（当前仅中文） |

### 优先级矩阵

```
                    高影响
                      │
    Phase 0: 统一数据 │ Phase 2: 组合风险
    Phase 0: LLM降级  │ Phase 2: 回测增强
    Phase 1: K线图    │ Phase 3: 定时播报
                      │
    ──────────────────┼──────────────────
                      │
    Phase 0: 目录清理 │ Phase 1: 漏斗可视化
    Phase 0: 健康监控 │ Phase 1: WebSocket
                      │ Phase 3: 自适应参数
                      │
                    低影响
    低紧急 ←────────────────────→ 高紧急
```

---

## 六、技术选型建议

| 场景 | 推荐方案 | 理由 |
|------|---------|------|
| K线图表 | [Lightweight Charts](https://tradingview.github.io/lightweight-charts/) | TradingView出品，轻量（<50KB gzip），canvas渲染，支持自定义标注 |
| 实时推送 | TickFlow WebSocket → Supabase Realtime → Web | 复用现有TickFlow付费能力，Supabase Realtime做广播 |
| 回测可视化 | Plotly (Python端生成HTML) 或 ECharts (Web端) | 回测结果数据量小，静态图足够 |
| 定时任务 | 保持 GitHub Actions + 新增 Supabase Cron | 当前20+ workflows已成熟，Supabase Cron 做轻量补充 |
| 移动端 | PWA（Service Worker + Web Push） | 无需原生开发，快速覆盖 |

---

## 七、架构决策记录 (ADR)

| ID | 决策 | 理由 | 日期 |
|----|------|------|------|
| ADR-001 | Streamlit 退役，Web 走 CF Pages + Hono API | Streamlit 不适合 SaaS，CF 边缘部署成本低 | 2025-06 |
| ADR-002 | Web 新功能走 Agent 聊天界面，不开新路由 | 保持 Agent-first 架构一致性 | 2025-06 |
| ADR-003 | 数据双写：本地 SQLite + Supabase | 离线可用 + 云端同步，不互相阻塞 | 2025-06 |
| ADR-004 | 凭据三层回退：Supabase → wyckoff.json → env | 兼顾 SaaS 多用户和本地 CLI 单用户场景 | 2025-07 |
| ADR-005 | 工具实现在 `agents/chat_tools.py` 单文件 | 三端复用，避免 CLI/Web/MCP 各自实现 | 2025-07 |

---

## 八、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:---:|:---:|------|
| TickFlow API 涨价或停服 | 低 | 高 | 保持 7 源级联，Tushare/AKShare 可兜底 |
| LLM API 不可用 | 低 | 高 | Phase 0 实现无 LLM 降级模式 |
| 数据源合规风险（A股数据商用） | 中 | 高 | 保持个人学习研究定位，不商业化 |
| Supabase 免费额度耗尽 | 中 | 中 | 本地 SQLite 可独立运行，云端仅增强 |
| 港股/美股数据质量差导致误判 | 中 | 中 | 明确标注数据源置信度，限制美股/港股漏斗参数 |

---

## 九、成功指标 (North Star Metrics)

| 指标 | 当前基线 | 3个月目标 | 6个月目标 |
|------|---------|----------|----------|
| 漏斗 L4 信号 → 实际盈利（20交易日）胜率 | 待测量 | >55% | >60% |
| 漏斗 L4 信号 → 尾部风险（最大回撤>10%）比例 | 待测量 | <15% | <10% |
| 系统可用性（任一通道可正常完成筛选→分析→诊断） | 95% | 99% | 99.5% |
| 无 LLM 模式下核心功能可用比例 | 0% | 80% | 100% |
| Web端日活用户 | - | - | - |

---

*本文档基于 2025-07-22 `main` 分支深度代码审计生成。架构评估基于代码实际实现而非设计文档，所有评分有代码依据。*
