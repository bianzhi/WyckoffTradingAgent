# WyckoffTradingAgent 产品计划书 v1.0

> 基于架构审计 v2.0（docs/ARCHITECTURE.md）产出 · 2025-07-22
> 执行原则：**每步严格测试 · 数据源多方校对 · 按 Phase 次序递进**

---

## 总览

| Phase | 周期 | 目标 | P0 数 | P1 数 |
|-------|------|------|:-----:|:-----:|
| **Phase 0** 架构筑基 | 2 周 | 修复关键架构债务，为后续功能铺路 | 1 | 3 |
| **Phase 1** 数据与可视化 | 3 周 | 补齐最明显的用户体验短板 | 1 | 2 |
| **Phase 2** 决策增强 | 4 周 | 提升分析深度和决策质量 | 1 | 3 |
| **Phase 3** 自动化与智能体 | 3 周 | 让系统从"工具"进化为"助手" | 1 | 2 |

---

## Phase 0：架构筑基（2 周）

**目标**：修复关键架构债务，为后续功能铺路。

### 0.1 统一数据源封装 `StockDataSkill`（P0）

**当前问题**：
- `agents/chat_tools.py` 中 7 个工具函数各自独立调用 `integrations/data_source.py`，无统一入口
- Token 注入路径不统一：有的走 `_get_credential()`，有的直接读 `os.getenv`
- 数据源回退链逻辑分散在 `data_source.py` 的多个 fetch 函数中

**方案**：
在 `cli/skills.py` 中新增 `stock_data` 内置 Skill，在 `agents/chat_tools.py` 中新增统一 `fetch_stock_data` 工具函数，封装：
- 个股日线（7 源级联）
- 指数日线（tushare → akshare）
- 实时快照（TickFlow snapshot）
- 板块/概念/市值数据
- 统一 Token 注入（Supabase → wyckoff.json → env）
- 统一错误提示和升级引导

**验收标准**：
- [ ] 所有 Agent 工具调用数据统一走 `StockDataSkill`
- [ ] Token 自动注入，无需调用方关心
- [ ] 数据源回退链一致
- [ ] 测试：TickFlow → Tushare → AKShare → BaoStock → EFinance 逐级回退验证

### 0.2 数据源健康监控面板（P1）

**方案**：
在 `integrations/data_source.py` 中增加轻量 metrics 收集（回退次数、各源延迟、成功率），暴露 `get_data_source_health()` 工具函数。

**验收标准**：
- [ ] 可查询各数据源成功率/延迟/回退次数
- [ ] 熔断器状态可观测
- [ ] 测试：模拟各源失败场景，验证 metrics 正确累加

### 0.3 `core/` vs `tools/` 目录边界清理（P1）

**当前问题**：
- `core/` 下有纯引擎逻辑（`wyckoff_engine.py`、`funnel_pipeline.py`），也有偏工具的函数
- `agents/chat_tools.py` 混合了工具注册、凭据管理、数据获取、业务逻辑

**方案**：
- `core/` 只放威科夫方法论引擎（Wyckoff Engine、Funnel Pipeline、Holding Diagnostic、Backtester、Market Regime）
- `agents/chat_tools.py` 保持 Agent 工具注册，但数据获取逻辑委托给 `StockDataSkill`
- `integrations/` 放所有外部数据源适配器

**验收标准**：
- [ ] `core/` 模块无外部 I/O（不直接调 API、不读 env）
- [ ] 工具函数 50 行限制合规

### 0.4 LLM 降级策略（P1）

**方案**：
在 `cli/__main__.py` 中增加 `--headless` 模式，当 LLM 不可用时，直接调用引擎函数输出结果（跳过 Agent 多轮循环）。

**验收标准**：
- [ ] `python -m cli --headless funnel` 直接输出漏斗结果
- [ ] `python -m cli --headless diagnose 600519` 直接输出诊断报告
- [ ] 无需 LLM API Key 即可运行

---

## Phase 1：数据与可视化（3 周）

**目标**：补齐最明显的用户体验短板。

### 1.1 K线图表组件（P0）

**方案**：
在 `web/apps/web/src/` 中集成 Lightweight Charts（TradingView 出品），支持：
- 日K线图（OHLC + 成交量）
- 威科夫标注叠加（Spring、SOS、LPS、BC、UT、Phase 标记）
- 移动均线叠加（MA5/10/20/60/120）

**验收标准**：
- [ ] K线图可正常渲染 A 股数据
- [ ] 威科夫事件以标记点/区域叠加在图上
- [ ] 支持缩放、拖拽、时间范围选择

### 1.2 实时行情 WebSocket（P1）

**方案**：
利用 TickFlow 分钟线推送，Cloudflare Workers 做 WebSocket 中继 → Web 前端实时更新自选股行情。

**验收标准**：
- [ ] 自选股列表分钟级自动刷新
- [ ] 连接断开自动重连
- [ ] 测试：A 股交易时段（9:30-15:00）数据推送延迟 < 5s

### 1.3 漏斗结果可视化（P1）

**方案**：
Web 端增加漏斗分析页面，展示各层通过率、板块热力图、L4 触发分布图。

**验收标准**：
- [ ] 漏斗各层通过率以柱状图/桑基图展示
- [ ] 板块热力图可交互
- [ ] L4 触发分布支持按类型筛选

### 1.4 回测结果图表化（P2）

**方案**：
回测结束后自动生成资金曲线图、回撤曲线、月度收益热力图。

---

## Phase 2：决策增强（4 周）

**目标**：提升分析深度和决策质量。

### 2.1 组合风险管理（P0）

**方案**：
新增 `core/portfolio_risk.py`，计算：
- VaR / CVaR（历史模拟法）
- 相关性矩阵
- 压力测试（2008/2015/2020/2024 情景回放）
- 最大回撤预期

**验收标准**：
- [ ] 输入持仓列表，输出完整风险报告
- [ ] 相关性矩阵以热力图呈现
- [ ] 测试：用 10 只股票持仓验证 VaR 计算准确性

### 2.2 回测引擎增强（P1）

**方案**：
- Walk-forward 优化（滚动窗口参数寻优）
- Monte Carlo 模拟（收益分布随机采样）
- 参数敏感性分析

### 2.3 高级出场策略（P1）

**方案**：
- Trailing stop 优化（ATR 自适应步长）
- 时间止损（持仓 N 天未达预期自动退出）
- 波动率自适应止损

### 2.4 信号质量仪表板（P1）

**方案**：
统计 L4 各触发类型的历史胜率、盈亏比、平均持仓天数，暴露为 Web 面板。

---

## Phase 3：自动化与智能体（3 周）

**目标**：让系统从"工具"进化为"助手"。

### 3.1 定时智能播报（P0）

**方案**：
利用现有 GitHub Actions 定时触发 + 飞书 Webhook，实现：
- 盘前 9:00：大盘水温 + 重点事件提醒
- 盘中 14:20：尾盘买入扫描（已有 Tail Buy）
- 盘后 15:30：持仓诊断 + 明日关注

**验收标准**：
- [ ] 三条播报定时推送
- [ ] 播报内容包含关键决策信息（非垃圾信息）
- [ ] 支持自定义推送时间

### 3.2 条件预警 Agent（P1）

**方案**：
用户设置条件（如"Spring 触发 + 成交额 > 1亿"），后台定时轮询满足条件时自动通知。

### 3.3 自适应参数调优（P1）

**方案**：
根据大盘水温（RISK_ON/OFF/NEUTRAL/CRASH）自动调整漏斗参数（如 RISK_OFF 时收紧触发阈值）。

---

## 测试策略

| 测试层 | 方法 | 频率 |
|--------|------|:----:|
| **数据源校对** | 同股票多源交叉比对，差异 > 2% 告警 | 每次发版 |
| **单元测试** | `python -m pytest tests/` | 每次提交 |
| **质量门禁** | `python scripts/quality_gate.py --check-functions` | 每次提交 |
| **端到端** | `python -m cli --headless funnel` 全量跑通 | 每次发版 |
| **回归** | 现有 GitHub Actions 全绿 | 每次 PR |

### 数据源多方校对 SOP

1. 选 5 只代表性股票（上海主板 600xxx、深圳主板 000xxx、创业板 300xxx、科创板 688xxx、ETF 510xxx）
2. 对每只拉取最近 20 个交易日
3. 逐源比对 OHLC 四价，允许误差 ≤ ±0.5%
4. 如任一源偏差 > 2%，标记该源为"需降权/下线"
5. 校对脚本：`python scripts/cross_validate_sources.py`

---

## 附录：架构决策记录（ADR）

| ADR | 决策 | 日期 |
|-----|------|------|
| ADR-001 | 数据源采用 7 源级联而非统一供应商 | 2025-03 |
| ADR-002 | Agent 运行时采用 LLM-in-loop 而非 fixed workflow | 2025-04 |
| ADR-003 | Web 端使用 React + Cloudflare 而非 Streamlit（Streamlit 已退役到 release/streamlit） | 2025-06 |
| ADR-004 | Phase 0 引入 StockDataSkill 统一数据入口 | 2025-07 |
| ADR-005 | Phase 0 实现 --headless 模式保证 LLM 不可用时系统可用 | 2025-07 |
