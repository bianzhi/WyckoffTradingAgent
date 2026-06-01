import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { supabase } from './supabase'
import { loadSystemConfig, type SystemConfig } from './system-config'
import type { ToolDeps } from './chat-tools'
import {
  execSearchStock, execViewPortfolio, execMarketOverview,
  execQueryRecommendations, execQueryTailBuy, execExecutePortfolioUpdate,
  execAnalyzeStock, execScreenStocks, execGenerateAiReport, execStrategyDecision,
  execMarketHistory, execIntradayAnalysis, execGetSignalQuality,
  execManageAlerts, execPortfolioRisk, execTuneParameters,
  execWalkForwardOptimize, execMonteCarloSimulate,
  execBenchmarkExitStrategies, execAnalyzeExitQuality,
  execDataSourceHealth, execTriggerFunnel,
 } from './chat-tools'

const SYSTEM_PROMPT = `# 角色设定

你就是理查德·D·威科夫（Richard D. Wyckoff）本人。
你以"综合人（Composite Man）"视角审视一切：每一根 K 线背后都有一个阴谋，每一次放量都是主力在行动。
你的语气冷峻、老练、一针见血。直接告诉对方盘面的真相。

# 你手里的武器

1. **搜索** — search_stock：在全市场中搜索股票（名称或代码）
2. **查看持仓** — view_portfolio：查看用户的持仓列表和资金
3. **大盘水温** — market_overview：查看当前/最新市场信号、指数走势
12. **大盘回看** — market_history：回看过去 N 个交易日指数K线，分析量价关系和威科夫阶段
4. **形态复盘** — query_recommendations：查询形态复盘记录
5. **尾盘记录** — query_tail_buy：查询尾盘买入记录
6. **调仓方案** — plan_portfolio_update：生成调仓方案（不直接执行）
11. **确认执行** — execute_portfolio_update：用户确认后执行调仓方案
7. **个股诊断** — analyze_stock：对单只股票做威科夫深度诊断（K线+量价+阶段+价值面校准，A股6位/美股AAPL.US/港股00700.HK；价值面当前优先支持A股）
8. **漏斗选股** — screen_stocks：查看最新一期漏斗选股结果
17. **发起漏斗** — trigger_funnel_screening：启动全市场五层漏斗筛选，结果通过 screen_stocks 查看
9. **AI 研报** — generate_ai_report：为指定股票生成威科夫深度研报
10. **策略建议** — generate_strategy_decision：基于持仓+大盘给出操作建议
13. **盘中分析** — intraday_analysis：获取分钟线多周期数据（1m/5m/15m），返回VWAP位置、趋势、动量、综合强度评分
14. **信号质量** — get_signal_quality：查询信号注册表健康状态、胜率、均收益
15. **条件预警** — manage_alerts：管理价格预警/放量异动/指数波动等条件规则，支持增删查和立即评估
16. **数据源健康** — data_source_health：查看各数据源成功率/延迟/熔断状态，诊断数据拉取问题

# 工具路由原则

只做用户要求的事，绝不多做。
- "我有什么持仓" → view_portfolio
- "帮我看看某只股票" → analyze_stock
- "大盘今天怎么样" / "当前大盘怎么样" → market_overview
- "大盘过去N个交易日" / "回看大盘" / "大盘量价关系" / "大盘到什么阶段了" → market_history
- "复盘记录" → query_recommendations
- "尾盘买了啥" → query_tail_buy
- "帮我选股" / "今天有什么好票" → screen_stocks
- "启动漏斗" / "发起选股" / "开始漏斗筛选" → trigger_funnel_screening
- "帮我出个研报" → generate_ai_report
- "我该怎么操作" / "给个建议" → generate_strategy_decision
- "盘中怎么样" / "现在能买吗" / "今天走势如何" → intraday_analysis
- "信号质量""信号表现怎么样""哪个信号最准""信号胜率" → get_signal_quality
- "预警规则""创建预警""删除预警""设置价格预警""放量预警""跑一下预警" → manage_alerts
- "风险分析""组合风险""VaR""压力测试""回撤""相关性" → portfolio_risk
- "参数调优""自适应""收紧阈值""放松阈值""当前应该用什么参数""水温调参" → tune_parameters
- "滚动优化""walk forward""参数寻优""最优参数""防止过拟合""样本外验证" → walk_forward_optimize
- "蒙特卡洛""monte carlo""模拟""概率分布""盈利概率""破产概率""权益曲线" → monte_carlo_simulate
- "出场策略""出场对比""哪种出场好""benchmark exit""ATR trailing""时间止损""波动率止损""移动止盈" → benchmark_exit_strategies
- "出场质量""出场评估""回吐分析""exit quality""MFE MAE" → analyze_exit_quality

# 行为铁律

1. 数据先行：所有分析基于工具返回的真实数据，绝不凭空编造数字。
2. 语言跟随：用户使用什么语言提问，就用什么语言回复。用 Markdown 格式让信息清晰。
3. 风险声明：涉及具体操作建议时，附带风险提示。
4. 技术面为主：价值面只用于质量、风险、置信度和仓位校准，不能替代 K 线事实，也不能因为单个财务指标给出过度确定结论。
5. 调仓两步走：涉及调仓时，先调用 plan_portfolio_update 展示方案，等用户明确说"确认"/"执行"/"好的"后才调用 execute_portfolio_update 执行。绝不跳过确认步骤。`

export interface LLMConfig {
  api_key: string
  model: string
  base_url: string
  protocol?: 'openai' | 'anthropic'
}

export interface ModelOption {
  provider: string
  label: string
  model: string
  api_key: string
  base_url: string
  protocol?: 'openai' | 'anthropic'
}

const RETIRED_PROVIDERS = new Set(['zhipu', 'minimax', 'qwen', 'volcengine'])
const CHAT_STREAM_TIMEOUT_MS = 120_000
const ALLOWED_URL_RE = /^https?:\/\//i
const DEFAULT_CONTEXT_WINDOW = 64_000
const COMPACT_RATIO = 0.25
const TAIL_KEEP = 4
const DEFAULT_RECENT_KEEP_TOKENS = 20_000
const MIN_RECENT_KEEP_TOKENS = 4_000

type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string }

export interface PreparedChatHistory {
  messages: ChatHistoryMessage[]
  compacted: boolean
  beforeTokens: number
  afterTokens: number
  beforeMessages: number
  afterMessages: number
}

const MODEL_CONTEXT_WINDOWS: [string, number][] = [
  ['deepseek', 64_000],
  ['gpt-4o', 128_000],
  ['gpt-4', 128_000],
  ['gpt-3.5', 16_000],
  ['gemini-3', 128_000],
  ['gemini-2', 1_000_000],
  ['gemini', 128_000],
  ['claude-opus', 200_000],
  ['claude-sonnet', 200_000],
  ['claude', 200_000],
  ['minimax', 128_000],
  ['kimi', 128_000],
  ['qwen', 128_000],
  ['longcat', 64_000],
  ['mistral', 128_000],
  ['step', 64_000],
]

export function getChatContextWindow(modelName: string): number {
  const lower = modelName.toLowerCase()
  return MODEL_CONTEXT_WINDOWS.find(([prefix]) => lower.includes(prefix))?.[1] ?? DEFAULT_CONTEXT_WINDOW
}

export function getChatCompactThreshold(modelName: string): number {
  return Math.floor(getChatContextWindow(modelName) * COMPACT_RATIO)
}

export function getChatRecentKeepTokens(modelName: string): number {
  const threshold = getChatCompactThreshold(modelName)
  if (threshold <= MIN_RECENT_KEEP_TOKENS * 2) return Math.max(1_000, Math.floor(threshold / 2))
  return Math.min(DEFAULT_RECENT_KEEP_TOKENS, Math.max(MIN_RECENT_KEEP_TOKENS, Math.floor(threshold / 2)))
}

function estimateChatMessageTokens(message: ChatHistoryMessage): number {
  const content = message.content || ''
  const bytes = new TextEncoder().encode(content).length
  return Math.max(Math.floor(content.length / 2), Math.floor(bytes / 3), 1)
}

function estimateChatTokens(messages: ChatHistoryMessage[]): number {
  return messages.reduce((total, message) => total + estimateChatMessageTokens(message), 0)
}

function findChatTailStartByTokenBudget(messages: ChatHistoryMessage[], keepRecentTokens: number): number {
  if (messages.length === 0) return 0
  const minTailStart = Math.max(0, messages.length - TAIL_KEEP)
  let accumulated = 0
  let tailStart = minTailStart

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message) continue
    accumulated += estimateChatMessageTokens(message)
    if (accumulated >= keepRecentTokens) {
      tailStart = i
      break
    }
  }

  return Math.min(tailStart, minTailStart)
}

function buildLocalChatSummary(messages: ChatHistoryMessage[], maxChars = 1200): string {
  const codes: string[] = []
  const userGoals: string[] = []
  const assistantNotes: string[] = []

  for (const message of messages) {
    for (const code of message.content.match(/\b\d{6}\b/g) || []) {
      if (!codes.includes(code)) codes.push(code)
    }
    if (message.role === 'user') userGoals.push(message.content.slice(0, 180))
    if (message.role === 'assistant') assistantNotes.push(message.content.slice(0, 220))
  }

  const lines = ['前序读盘室对话已压缩为摘要。']
  if (codes.length) lines.push(`涉及标的：${codes.slice(0, 12).join(', ')}`)
  if (userGoals.length) {
    lines.push('用户关注：')
    for (const item of userGoals.slice(-6)) lines.push(`- ${item}`)
  }
  if (assistantNotes.length) {
    lines.push('已给出的主要结论：')
    for (const item of assistantNotes.slice(-6)) lines.push(`- ${item}`)
  }

  const summary = lines.join('\n')
  return summary.length <= maxChars ? summary : `${summary.slice(0, maxChars - 1).trimEnd()}…`
}

export function prepareChatMessagesForModel(messages: ChatHistoryMessage[], modelName: string): PreparedChatHistory {
  const normalized = messages
    .filter((message) => message.content.trim())
    .map((message) => ({ role: message.role, content: message.content }))
  const beforeTokens = estimateChatTokens(normalized)
  const beforeMessages = normalized.length

  if (normalized.length <= TAIL_KEEP + 2 || beforeTokens <= getChatCompactThreshold(modelName)) {
    return {
      messages: normalized,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      beforeMessages,
      afterMessages: beforeMessages,
    }
  }

  const tailStart = findChatTailStartByTokenBudget(normalized, getChatRecentKeepTokens(modelName))
  if (tailStart <= 2) {
    return {
      messages: normalized,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      beforeMessages,
      afterMessages: beforeMessages,
    }
  }

  const summary = buildLocalChatSummary(normalized.slice(0, tailStart))
  const compactedMessages: ChatHistoryMessage[] = [
    {
      role: 'user',
      content: `[读盘室对话摘要]\n${summary}\n\n[系统说明] 以上是前序读盘室对话摘要。后续回答可以结合摘要和保留的最近对话，但当前持仓、价格、行情和策略结果仍必须以工具实时返回为准。`,
    },
    { role: 'assistant', content: '好的，我已接续前序读盘室上下文。' },
    ...normalized.slice(tailStart),
  ]

  return {
    messages: compactedMessages,
    compacted: true,
    beforeTokens,
    afterTokens: estimateChatTokens(compactedMessages),
    beforeMessages,
    afterMessages: compactedMessages.length,
  }
}

function parseCustomProviders(raw: unknown): Record<string, Record<string, string>> {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {})
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, Record<string, string>> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const entry = value as Record<string, unknown>
      const baseUrl = String(entry.baseurl || entry.base_url || '')
      if (baseUrl && !ALLOWED_URL_RE.test(baseUrl)) continue
      result[key] = Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, String(v ?? '')]))
    }
    return result
  } catch {
    return {}
  }
}
// loadSystemConfig / SystemConfig re-exported from system-config.ts for convenience
export { loadSystemConfig, type SystemConfig } from './system-config'

const PROVIDER_LABELS: Record<string, string> = {
  '1route': '1Route', gemini: 'Gemini', openai: 'OpenAI',
  deepseek: 'DeepSeek', anthropic: 'Anthropic',
}
const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  '1route': 'https://www.1route.dev/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com',
}

function resolveProviderKey(data: Record<string, unknown> | null): {
  api_key: string; model: string; base_url: string; protocol: 'openai' | 'anthropic'
} {
  let api_key = '', model = '', base_url = ''
  let protocol: 'openai' | 'anthropic' = 'openai'

  if (!data) return { api_key, model, base_url, protocol }

  const provider = (data.chat_provider as string) || '1route'
  if (RETIRED_PROVIDERS.has(provider)) return { api_key, model, base_url, protocol }

  if (provider === 'gemini') {
    api_key = (data.gemini_api_key as string) || ''
    model = (data.gemini_model as string) || 'gemini-2.0-flash'
    base_url = (data.gemini_base_url as string) || 'https://generativelanguage.googleapis.com/v1beta/openai'
  } else if (provider === 'openai') {
    api_key = (data.openai_api_key as string) || ''
    model = (data.openai_model as string) || 'gpt-4o'
    base_url = (data.openai_base_url as string) || 'https://api.openai.com/v1'
  } else if (provider === 'deepseek') {
    api_key = (data.deepseek_api_key as string) || ''
    model = (data.deepseek_model as string) || 'deepseek-chat'
    base_url = (data.deepseek_base_url as string) || 'https://api.deepseek.com/v1'
  } else if (provider === 'anthropic') {
    api_key = (data.anthropic_api_key as string) || ''
    model = (data.anthropic_model as string) || 'claude-sonnet-4-20250514'
    base_url = (data.anthropic_base_url as string) || 'https://api.anthropic.com'
    protocol = 'anthropic'
  } else {
    const custom = parseCustomProviders(data.custom_providers)
    const info = custom[provider] || {}
    api_key = info.apikey || info.api_key || ''
    model = info.model || ''
    base_url = info.baseurl || info.base_url || ''
  }
  return { api_key, model, base_url, protocol }
}

export async function loadLLMConfig(userId: string): Promise<LLMConfig | null> {
  const { data } = await supabase
    .from('user_settings')
    .select('chat_provider, gemini_api_key, gemini_model, gemini_base_url, openai_api_key, openai_model, openai_base_url, deepseek_api_key, deepseek_model, deepseek_base_url, anthropic_api_key, anthropic_model, anthropic_base_url, custom_providers')
    .eq('user_id', userId)
    .maybeSingle()

  const userConfig = resolveProviderKey(data as Record<string, unknown> | null)
  if (userConfig.api_key) {
    return {
      api_key: userConfig.api_key, model: userConfig.model,
      base_url: userConfig.base_url, protocol: userConfig.protocol,
    }
  }

  const sys = await loadSystemConfig()
  if (sys.llm_api_key) {
    return {
      api_key: sys.llm_api_key,
      model: sys.llm_model || 'deepseek-chat',
      base_url: sys.llm_base_url || 'https://api.deepseek.com/v1',
      protocol: 'openai',
    }
  }

  return null
}

function collectKnownProviderModels(
  data: Record<string, unknown>,
  models: ModelOption[],
): void {
  const known = ['gemini', 'openai', 'deepseek', 'anthropic'] as const
  for (const p of known) {
    const key = data[`${p}_api_key`]
    const m = data[`${p}_model`]
    if (key && m) {
      models.push({
        provider: p, label: PROVIDER_LABELS[p] || p, model: m as string,
        api_key: key as string,
        base_url: (data[`${p}_base_url`] as string) || PROVIDER_DEFAULT_BASE_URLS[p] || '',
        protocol: p === 'anthropic' ? 'anthropic' : 'openai',
      })
    }
  }

  const custom = parseCustomProviders(data.custom_providers)
  for (const [p, info] of Object.entries(custom) as [string, Record<string, string>][]) {
    if (RETIRED_PROVIDERS.has(p)) continue
    const key = info.apikey || info.api_key
    const m = info.model
    if (key && m) {
      models.push({
        provider: p, label: PROVIDER_LABELS[p] || p, model: m,
        api_key: key,
        base_url: info.baseurl || info.base_url || PROVIDER_DEFAULT_BASE_URLS[p] || '',
      })
    }
  }
}

function maybeInsertSystemFallback(
  models: ModelOption[],
  sys: SystemConfig | null,
): void {
  if (models.length > 0 || !sys?.llm_api_key) return
  const provider = sys.llm_provider || 'deepseek'
  models.push({
    provider,
    label: `${PROVIDER_LABELS[provider] || provider} (系统)`,
    model: sys.llm_model || 'deepseek-chat',
    api_key: sys.llm_api_key,
    base_url: sys.llm_base_url || PROVIDER_DEFAULT_BASE_URLS[provider] || 'https://api.deepseek.com/v1',
    protocol: 'openai' as const,
  })
}

export async function loadAllModels(userId: string): Promise<ModelOption[]> {
  const [{ data }, sys] = await Promise.all([
    supabase
      .from('user_settings')
      .select('gemini_api_key, gemini_model, gemini_base_url, openai_api_key, openai_model, openai_base_url, deepseek_api_key, deepseek_model, deepseek_base_url, anthropic_api_key, anthropic_model, anthropic_base_url, custom_providers')
      .eq('user_id', userId)
      .maybeSingle(),
    loadSystemConfig().catch(() => null),
  ])

  const models: ModelOption[] = []
  if (data) collectKnownProviderModels(data, models)
  maybeInsertSystemFallback(models, sys)
  return models
}


export function createReasoningCache(): string[] {
  return []
}

function restoreReasoningMessages(init: RequestInit | undefined, cache: string[]): RequestInit | undefined {
  if (!init?.body || typeof init.body !== 'string') return init
  try {
    const body = JSON.parse(init.body)
    if (!Array.isArray(body.messages)) return init
    let idx = 0
    for (const msg of body.messages) {
      if (msg.role === 'assistant' && !msg.reasoning_content && idx < cache.length) {
        msg.reasoning_content = cache[idx]
      }
      if (msg.role === 'assistant') idx++
    }
    return { ...init, body: JSON.stringify(body) }
  } catch {
    return init
  }
}

async function throwForApiError(res: Response): Promise<void> {
  if (res.ok) return
  const text = await res.clone().text().catch(() => '')
  let msg = `API ${res.status}`
  try {
    const j = JSON.parse(text)
    msg = j?.error?.message || j?.error || msg
  } catch {
    const plain = text.trim()
    if (plain) msg = plain.slice(0, 500)
  }
  throw new Error(msg)
}

function wrapReasoningStream(res: Response, cache: string[]): Response {
  if (!res.body) return res
  let reasoning = ''
  const decoder = new TextDecoder()
  const transformed = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        const text = decoder.decode(chunk, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
          try {
            const evt = JSON.parse(line.slice(6))
            const rc = evt?.choices?.[0]?.delta?.reasoning_content
            if (rc) reasoning += rc
          } catch {}
        }
      },
      flush() { if (reasoning) cache.push(reasoning) },
    }),
  )

  return new Response(transformed, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

function buildReasoningFetch(cache: string[]): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await globalThis.fetch(input, restoreReasoningMessages(init, cache))
    await throwForApiError(res)
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) return res
    return wrapReasoningStream(res, cache)
  }
}

function createProxiedProvider(config: LLMConfig, reasoningCache: string[]) {
  if (config.protocol === 'anthropic') {
    return createAnthropic({
      apiKey: config.api_key,
      baseURL: '/api/llm-proxy',
      headers: { 'X-Target-URL': config.base_url },
      fetch: buildReasoningFetch(reasoningCache),
    })
  }
  return createOpenAI({
    apiKey: config.api_key,
    baseURL: '/api/llm-proxy',
    headers: { 'X-Target-URL': config.base_url },
    fetch: buildReasoningFetch(reasoningCache),
  })
}

function createMarketHistoryTool(deps: ToolDeps, userId: string, model: unknown) {
  return tool({
    description: '回看大盘指数过去N个交易日K线，分析量价关系、威科夫阶段、支撑压力和当前位置。适合“过去100个交易日”“回看大盘”“量价关系”等问题。',
    inputSchema: z.object({
      days: z.number().nullable().describe('回看交易日数量，默认100，范围1-250'),
      index: z.enum(['sse', 'csi300', 'szse', 'chinext', 'star50']).nullable().describe('指数：sse=上证指数，csi300=沪深300，szse=深证成指，chinext=创业板指，star50=科创50；默认sse'),
    }),
    execute: ({ days, index }) => execMarketHistory(deps, userId, model, days ?? 100, index ?? 'sse'),
  })
}

function createMarketOverviewTool(deps: ToolDeps, userId: string) {
  return tool({
    description: '查看当前/最新大盘行情信号：市场状态（regime）、上证指数、A50、VIX、市场提示。只适合回答今天或当前的大盘状态。',
    inputSchema: z.object({}),
    execute: () => execMarketOverview(deps, userId),
  })
}

function formatPortfolioPlan({ action, code, name, shares, cost_price, stop_loss, reason }: { action: string; code: string; name: string | null; shares: number | null; cost_price: number | null; stop_loss: number | null; reason: string | null }) {
  const actionLabel = { add: '新增', update: '修改', delete: '删除' }[action] ?? action
  const lines = [`📋 **调仓方案**`, `- 操作：${actionLabel}`, `- 标的：${code} ${name || ''}`]
  if (shares) lines.push(`- 股数：${shares}`)
  if (cost_price) lines.push(`- 价格：¥${cost_price}`)
  if (stop_loss) lines.push(`- 止损：¥${stop_loss}`)
  if (reason) lines.push(`- 理由：${reason}`)
  lines.push('', '⚠️ 请确认是否执行此操作？')
  return lines.join('\n')
}

function buildTools(userId: string, config: LLMConfig, reasoningCache: string[]) {
  const deps: ToolDeps = { supabase, fetch: globalThis.fetch, generateText }
  const model = createProxiedProvider(config, reasoningCache).chat(config.model)
  return {
    search_stock: tool({
      description: '搜索股票，支持代码或名称。返回匹配的股票列表及最新行情。',
      inputSchema: z.object({ query: z.string().describe('股票代码或名称关键词') }),
      execute: ({ query }) => execSearchStock(deps, userId, query),
    }),

    view_portfolio: tool({
      description: '查看用户当前持仓列表（代码、名称、股数、成本价）和可用资金。',
      inputSchema: z.object({}),
      execute: () => execViewPortfolio(deps, userId),
    }),

    market_overview: createMarketOverviewTool(deps, userId),
    market_history: createMarketHistoryTool(deps, userId, model),

    query_recommendations: tool({
      description: '查询形态复盘记录，显示入选股票及其后续涨跌表现。',
      inputSchema: z.object({ limit: z.number().describe('返回条数，通常20') }),
      execute: ({ limit }) => execQueryRecommendations(deps, limit),
    }),

    query_tail_buy: tool({
      description: '查询尾盘买入策略的历史记录（BUY/WATCH 决策、评分、LLM 理由）。',
      inputSchema: z.object({ limit: z.number().describe('返回条数，通常20') }),
      execute: ({ limit }) => execQueryTailBuy(deps, limit),
    }),

    plan_portfolio_update: tool({
      description: '生成调仓方案（不执行）。展示给用户确认后再调用 execute_portfolio_update。',
      inputSchema: z.object({
        action: z.enum(['add', 'update', 'delete']).describe('操作类型'),
        code: z.string().describe('6位股票代码'),
        name: z.string().nullable().describe('股票名称'),
        shares: z.number().nullable().describe('股数'),
        cost_price: z.number().nullable().describe('成本价'),
        stop_loss: z.number().nullable().describe('止损价'),
        reason: z.string().nullable().describe('调仓理由'),
      }),
      execute: (params) => formatPortfolioPlan(params),
    }),

    execute_portfolio_update: tool({
      description: '用户确认后执行调仓。必须在 plan_portfolio_update 之后、用户确认后才能调用。',
      inputSchema: z.object({
        action: z.enum(['add', 'update', 'delete']).describe('操作类型'),
        code: z.string().describe('6位股票代码'),
        name: z.string().nullable().describe('股票名称'),
        shares: z.number().nullable().describe('股数'),
        cost_price: z.number().nullable().describe('成本价'),
        stop_loss: z.number().nullable().describe('止损价'),
      }),
      execute: ({ action, code, name, shares, cost_price, stop_loss }) =>
        execExecutePortfolioUpdate(deps, userId, action, code, name, shares, cost_price, stop_loss),
    }),

    analyze_stock: tool({
      description: '对单只股票做威科夫深度诊断：K线走势、量价关系、均线形态、阶段判断，并在A股可用时加入价值面校准（盈利质量、成长、杠杆、现金流）。需要股票代码。',
      inputSchema: z.object({
        code: z.string().describe('股票代码：A股6位数字；美股/港股使用 TickFlow 标准代码，如 AAPL.US / 00700.HK'),
        name: z.string().nullable().describe('股票名称'),
      }),
      execute: ({ code, name }) => execAnalyzeStock(deps, userId, config, model, code, name),
    }),

    screen_stocks: tool({
      description: '查看最新一期漏斗选股结果：AI入选的候选股票列表及其评分。',
      inputSchema: z.object({}),
      execute: () => execScreenStocks(deps),
    }),

    trigger_funnel_screening: tool({
      description: '发起一次全市场漏斗选股。将请求加入后台队列，系统完成筛选后结果可通过 screen_stocks 查看。通常需要1-2分钟。',
      inputSchema: z.object({}),
      execute: () => execTriggerFunnel(deps, userId),
    }),

    generate_ai_report: tool({
      description: '为指定股票生成威科夫深度研报（AI分析），支持多只股票批量生成。',
      inputSchema: z.object({ codes: z.array(z.string()).describe('股票代码数组，如 ["600519", "AAPL.US", "00700.HK"]') }),
      execute: ({ codes }) => execGenerateAiReport(deps, userId, config, model, codes),
    }),

    generate_strategy_decision: tool({
      description: '基于当前持仓和市场状态，给出买入/卖出/持有的操作建议。',
      inputSchema: z.object({}),
      execute: () => execStrategyDecision(deps, userId, model),
    }),

    intraday_analysis: tool({
      description: '盘中多周期分析：获取分钟线数据，返回VWAP位置、趋势方向、动量、量能分布和综合强度评分。用于判断当前是否适合交易。',
      inputSchema: z.object({ code: z.string().describe('股票代码：A股6位数字，如 000001') }),
      execute: ({ code }) => execIntradayAnalysis(deps, userId, code),
    }),

    get_signal_quality: tool({
      description: '信号质量评分报告：查询当前所有信号类型（sos/spring/lps/evr/compression/trend_pullback）的健康状态、胜率、平均收益、样本量等统计指标。用于评估威科夫信号在当前市场环境下的有效性。',
      inputSchema: z.object({}),
      execute: () => execGetSignalQuality(),
    }),

    manage_alerts: tool({
      description: '预警规则管理：CRUD 条件预警规则。action 支持 list（列出所有规则）、add（新增/更新规则，需传 ruleSpec JSON）、delete（删除规则，需传 ruleId）、run（立即评估所有规则并推送触发的告警）。条件类型：price_above/below（价格阈值）、pct_change（涨跌幅）、volume_spike（放量异动）、index_pct（指数波动）、regime（市场水温匹配）。',
      inputSchema: z.object({
        action: z.enum(['list', 'add', 'delete', 'run']).describe('操作类型'),
        ruleId: z.string().nullable().optional().describe('delete 时必填：规则 ID'),
        ruleSpec: z.record(z.unknown()).nullable().optional().describe('add 时必填：规则 JSON，包含 id/name/enabled/conditions/notify/cooldown_minutes'),
      }),
      execute: ({ action, ruleId, ruleSpec }) =>
        execManageAlerts(deps, action, ruleId ?? null, ruleSpec ?? null),
    }),

    portfolio_risk: tool({
      description: '组合风险管理：计算 VaR（历史/参数）、CVaR、最大回撤、相关性矩阵、压力测试。输入持仓列表 [{code, shares, cost_price}, ...] 和 lookbackDays（默认252≈1年），输出完整风险报告，包括高相关性警告和6种压力情景测试。',
      inputSchema: z.object({
        positions: z.array(z.record(z.unknown())).describe('持仓列表：[{code:"000001", shares:1000, cost_price:12.5}, ...]'),
        lookbackDays: z.number().nullable().optional().describe('回看交易日数，默认252（约1年）'),
      }),
      execute: ({ positions, lookbackDays }) =>
        execPortfolioRisk(deps, positions, lookbackDays ?? null),
    }),

    tune_parameters: tool({
      description: '自适应参数调优：分析大盘水温（上证+创业板），计算市场广度，输出 regime 分类（RISK_ON/NEUTRAL/RISK_OFF/CRASH/PANIC_REPAIR）和漏斗参数调优建议。自动显示"原始 vs 调优后"参数对照表。',
      inputSchema: z.object({
        benchCode: z.string().nullable().optional().describe('基准指数代码，默认 000001（上证）'),
        smallcapCode: z.string().nullable().optional().describe('小盘指数代码，默认 399006（创业板）'),
        lookbackDays: z.number().nullable().optional().describe('回看交易日数，默认252'),
      }),
      execute: ({ benchCode, smallcapCode, lookbackDays }) =>
        execTuneParameters(benchCode ?? null, smallcapCode ?? null, lookbackDays ?? null),
    }),

    walk_forward_optimize: tool({
      description: 'Walk-Forward 优化：滚动窗口参数寻优，防止过拟合。输入历史交易记录 trades[{signal_date, ret_pct, score}]，在训练窗网格搜索最优参数，在测试窗验证样本外表现。输出推荐参数 + 各窗口明细 + 参数稳定性。',
      inputSchema: z.object({
        trades: z.array(z.record(z.unknown())).describe('历史交易记录 [{signal_date, ret_pct, score}, ...]，至少10笔'),
        paramGrid: z.record(z.array(z.number())).nullable().optional().describe('参数搜索空间，如 {min_score: [0.1, 0.15, 0.2]}'),
        trainMonths: z.number().nullable().optional().describe('训练窗月数，默认12'),
        testMonths: z.number().nullable().optional().describe('测试窗月数，默认3'),
      }),
      execute: ({ trades, paramGrid, trainMonths, testMonths }) =>
        execWalkForwardOptimize(trades, paramGrid ?? null, trainMonths ?? null, testMonths ?? null),
    }),

    monte_carlo_simulate: tool({
      description: 'Monte Carlo 模拟：基于历史交易收益率，生成数千条可能权益曲线，输出概率化风险评估。输入 returns=[5.2, -3.1, ...]，输出 VaR/CVaR、盈利概率、破产概率、回撤分布。',
      inputSchema: z.object({
        returns: z.array(z.number()).nullable().optional().describe('历史交易收益率列表 [5.2, -3.1, 8.7, ...]'),
        nSimulations: z.number().nullable().optional().describe('模拟次数，默认5000'),
        nTrades: z.number().nullable().optional().describe('每次模拟交易笔数，默认100'),
        initialCapital: z.number().nullable().optional().describe('初始资金，默认100000'),
      }),
      execute: ({ returns, nSimulations, nTrades, initialCapital }) =>
        execMonteCarloSimulate(returns ?? null, nSimulations ?? null, nTrades ?? null, initialCapital ?? null),
    }),

    benchmark_exit_strategies: tool({
      description: '出场策略基准对比：对一批交易运行所有出场策略（ATR trailing、时间止损、波动率止损、MA出场、PSAR、混合），排名输出最佳策略。输入 ohlcData={code: {date: [o,h,l,c]}}, sortedDates={code: [date]}, trades=[{code, entry_date, entry_price}]。输出排名表 + 最佳策略推荐。',
      inputSchema: z.object({
        ohlcData: z.record(z.record(z.array(z.number()))).describe('OHLC 数据 {股票代码: {日期: [开盘,最高,最低,收盘]}}'),
        sortedDates: z.record(z.array(z.string())).describe('排序后的日期 {股票代码: [日期字符串]}'),
        trades: z.array(z.record(z.unknown())).describe('交易列表 [{code, entry_date, entry_price}]'),
        strategies: z.array(z.string()).nullable().optional().describe('要对比的策略列表，默认全部'),
        extraParams: z.record(z.record(z.unknown())).nullable().optional().describe('策略参数覆盖 {策略名: {参数: 值}}'),
      }),
      execute: ({ ohlcData, sortedDates, trades, strategies, extraParams }) =>
        execBenchmarkExitStrategies(ohlcData, sortedDates, trades, strategies ?? undefined, extraParams ?? undefined),
    }),

    analyze_exit_quality: tool({
      description: '出场质量评估：分析已有出场记录的过早离场率、利润回吐、MFE/MAE，给出 A-F 评级和改进建议。输入 exits=[{exit_price, entry_price, peak_high, trough_low, hold_days}]。输出评级 + 建议列表。',
      inputSchema: z.object({
        exits: z.array(z.record(z.unknown())).nullable().optional().describe('出场记录 [{exit_price, entry_price, peak_high, trough_low, hold_days}]'),
      }),
      execute: ({ exits }) => execAnalyzeExitQuality(exits ?? []),
    }),

    data_source_health: tool({
      description: '数据源健康状态：查询所有数据源（TickFlow、Tushare、AKShare、BaoStock、EFinance）的调用成功率、平均延迟、熔断状态、最后错误信息。用于诊断数据拉取问题。',
      inputSchema: z.object({}),
      execute: () => execDataSourceHealth(),
    }),
  }
}

export interface StepInfo {
  type: 'tool_call' | 'text'
  toolName?: string
  text?: string
  toolResult?: string
}

export interface StreamCallbacks {
  onStep: (step: StepInfo) => void
  onTextDelta: (delta: string) => void
  onFinish: (finalText: string, steps: StepInfo[]) => void
  onError: (error: Error) => void
}

export function runChatAgentStream(
  config: LLMConfig,
  userId: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  callbacks: StreamCallbacks,
  reasoningCache: string[],
): AbortController {
  const provider = createProxiedProvider(config, reasoningCache)

  const tools = buildTools(userId, config, reasoningCache)
  const steps: StepInfo[] = []

  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, CHAT_STREAM_TIMEOUT_MS)

  void (async () => {
    try {
      const preparedHistory = prepareChatMessagesForModel(messages, config.model)
      const result = streamText({
        model: provider.chat(config.model),
        system: SYSTEM_PROMPT,
        messages: preparedHistory.messages,
        tools,
        stopWhen: stepCountIs(10),
        abortSignal: abort.signal,
      })

      let finalText = ''
      for await (const event of result.fullStream) {
        switch (event.type) {
          case 'text-delta':
            finalText += event.text
            callbacks.onTextDelta(event.text)
            break
          case 'tool-call': {
            const step: StepInfo = { type: 'tool_call', toolName: event.toolName }
            steps.push(step)
            callbacks.onStep(step)
            break
          }
          case 'tool-result': {
            const s = steps.findLast(s => s.toolName === event.toolName)
            if (s) s.toolResult = typeof event.output === 'string' ? event.output : JSON.stringify(event.output)
            break
          }
          case 'error':
            throw event.error
        }
      }

      callbacks.onFinish(finalText, steps)
    } catch (err) {
      if (timedOut) {
        callbacks.onError(new Error('请求超过 120 秒已自动停止，请缩短问题或稍后重试。'))
      } else if (!abort.signal.aborted) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      clearTimeout(timer)
    }
  })()

  return abort
}
