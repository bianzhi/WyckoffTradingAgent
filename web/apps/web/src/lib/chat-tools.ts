import type { SupabaseClient } from '@supabase/supabase-js'
import type { generateText as GenerateTextFn } from 'ai'
import type { ValueSnapshot } from './kline'
import { buildValuePrompt, buildValueScore } from './value-analysis'
import { dataSkill, type KlineRow as DataKlineRow } from './data-skill'

export type KlineRow = DataKlineRow

export interface ToolDeps {
  supabase: SupabaseClient
  fetch: typeof globalThis.fetch
  generateText: typeof GenerateTextFn
}

export interface LLMToolConfig {
  api_key: string
  model: string
  base_url: string
}

// ── digest builders (no data fetching) ──────────────────────

export function buildKlineDigest(data: KlineRow[]): string {
  if (data.length === 0) return '无可用K线数据'
  const last = data[data.length - 1]!
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const slice = (n: number) => data.slice(-n)
  const ma = (n: number) => avg(slice(n).map(d => d.close))
  const vol = (n: number) => avg(slice(n).map(d => d.volume))
  const p20 = slice(20)

  const lines = [
    `K线共${data.length}根，最新日期 ${last.date}`,
    `最新收盘 ${last.close.toFixed(2)}，开盘 ${last.open.toFixed(2)}，高 ${last.high.toFixed(2)}，低 ${last.low.toFixed(2)}`,
    `MA5=${ma(5).toFixed(2)} MA10=${ma(10).toFixed(2)} MA20=${ma(20).toFixed(2)}`,
  ]
  if (data.length >= 50) lines.push(`MA50=${ma(50).toFixed(2)}`)
  if (data.length >= 120) lines.push(`MA120=${ma(120).toFixed(2)}`)
  lines.push(
    `近20日最高 ${Math.max(...p20.map(d => d.high)).toFixed(2)}，最低 ${Math.min(...p20.map(d => d.low)).toFixed(2)}`,
    `近5日均量 ${vol(5).toFixed(0)}，近20日均量 ${vol(20).toFixed(0)}`,
    `量比(5/20) ${(vol(5) / (vol(20) || 1)).toFixed(2)}`,
  )

  const recent5 = slice(5)
  lines.push('近5日走势: ' + recent5.map(d => {
    const chg = ((d.close - d.open) / d.open * 100).toFixed(1)
    return `${d.date.slice(5)} ${Number(chg) >= 0 ? '+' : ''}${chg}%`
  }).join(' → '))

  return lines.join('\n')
}

export function buildValueAgentDigest(snapshot: ValueSnapshot): string {
  const base = buildValuePrompt(snapshot)
  const score = buildValueScore(snapshot.metrics)
  if (!snapshot.metrics) return base
  const strengths = score.strengths.map((item) => item.label).join('；') || '暂无明显质量加分项'
  const risks = score.risks.map((item) => item.label).join('；') || '暂无明显价值面风险项'
  return [
    base,
    `价值面评级：${score.label}`,
    `质量信号：${strengths}`,
    `风险信号：${risks}`,
  ].join('\n')
}

// ── search stock ───────────────────────────────────────────

export async function execSearchStock(deps: ToolDeps, _userId: string, query: string): Promise<string> {
  const q = query.trim()
  const isCode = /^\d+$/.test(q)

  const tables = ['recommendation_tracking', 'portfolio_positions', 'tail_buy_history'] as const
  const allRows: { code: number; name: string }[] = []

  for (const table of tables) {
    const res = isCode
      ? await deps.supabase.from(table).select('code, name').eq('code', parseInt(q)).limit(5)
      : await deps.supabase.from(table).select('code, name').ilike('name', `%${q}%`).limit(10)
    if (res.data) allRows.push(...res.data)
  }

  if (allRows.length === 0) return `未找到匹配"${query}"的股票`

  const seen = new Set<number>()
  const unique = allRows.filter((r) => {
    if (seen.has(r.code)) return false
    seen.add(r.code)
    return true
  }).slice(0, 10)

  const symbols = unique.map(r => {
    const c = String(r.code).padStart(6, '0')
    if (c.startsWith('6')) return `${c}.SH`
    if (c.startsWith('4') || c.startsWith('8') || c.startsWith('9')) return `${c}.BJ`
    return `${c}.SZ`
  })
  const quotes = await dataSkill.fetchQuotes(symbols)

  const lines = unique.map(r => {
    const code6 = String(r.code).padStart(6, '0')
    const qt = quotes[code6]
    if (qt) {
      const price = qt.close || qt.last || qt.price || qt.current || 0
      const pct = qt.pct_chg ?? ((qt.close && qt.pre_close) ? ((qt.close - qt.pre_close) / qt.pre_close * 100) : null)
      const pctStr = pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''
      return `${code6} ${r.name} | ¥${price.toFixed(2)} ${pctStr}`
    }
    return `${code6} ${r.name}`
  })

  return lines.join('\n')
}

// ── portfolio ──────────────────────────────────────────────

export async function execViewPortfolio(deps: ToolDeps, userId: string): Promise<string> {
  const portfolioId = `USER_LIVE:${userId}`
  const [positionsRes, portfolioRes] = await Promise.all([
    deps.supabase.from('portfolio_positions').select('code, name, shares, cost_price, stop_loss, buy_dt').eq('portfolio_id', portfolioId),
    deps.supabase.from('portfolios').select('free_cash').eq('id', portfolioId).maybeSingle(),
  ])

  const positions = positionsRes.data || []
  const freeCash = portfolioRes.data?.free_cash ?? 0

  if (positions.length === 0) {
    return `当前无持仓。可用资金：¥${freeCash.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
  }

  const totalCost = positions.reduce((sum, p) => sum + (p.shares || 0) * (p.cost_price || 0), 0)
  const lines = [
    `持仓 ${positions.length} 只，总成本 ¥${totalCost.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}，可用资金 ¥${freeCash.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`,
    ...positions.map(p => {
      const cost = (p.shares || 0) * (p.cost_price || 0)
      const parts = [
        `${p.code} ${p.name || ''}`,
        `${p.shares}股 成本¥${p.cost_price}`,
        `持仓¥${cost.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`,
      ]
      if (p.stop_loss) parts.push(`止损¥${p.stop_loss}`)
      if (p.buy_dt) parts.push(`买入${p.buy_dt}`)
      return `- ${parts.join(' | ')}`
    }),
  ]
  return lines.join('\n')
}

// ── market overview ────────────────────────────────────────

function formatRegime(regime: string): string {
  const regimeMap: Record<string, string> = {
    RISK_ON: '偏强', NEUTRAL: '中性', RISK_OFF: '偏弱', CRASH: '极弱', BLACK_SWAN: '恶劣',
  }
  return regimeMap[regime] || regime
}

function formatMarketSignalLine(merged: Record<string, unknown>): string {
  const regime = String(merged.benchmark_regime || 'NEUTRAL')
  const close = Number(merged.main_index_close || 0)
  const pct = Number(merged.main_index_today_pct || 0)
  const sig = close && pct >= 0 ? '+' : ''
  const a50Close = Number(merged.a50_close || 0)
  const a50Pct = Number(merged.a50_pct_chg || 0)
  const vixClose = Number(merged.vix_close || 0)
  return [
    `大盘状态：${formatRegime(regime)}`,
    close ? `上证指数：${close.toFixed(0)} (${sig}${pct.toFixed(2)}%)` : '',
    a50Close ? `A50：${a50Close.toFixed(0)} (${a50Pct >= 0 ? '+' : ''}${a50Pct.toFixed(2)}%)` : '',
    vixClose ? `VIX：${vixClose.toFixed(1)}` : '',
    String(merged.banner_title || '') ? `\n${merged.banner_title}` : '',
    String(merged.banner_message || '') ? String(merged.banner_message) : '',
  ].filter(Boolean).join('\n')
}

export async function execMarketOverview(deps: ToolDeps, _userId?: string): Promise<string> {
  const { data } = await deps.supabase
    .from('market_signal_daily')
    .select('*')
    .order('trade_date', { ascending: false })
    .limit(3)

  if (data && data.length > 0) {
    const merged: Record<string, unknown> = { ...data[0] }
    for (const row of data) {
      for (const key of ['benchmark_regime', 'main_index_close', 'main_index_today_pct']) {
        if (!merged[key] && row[key]) merged[key] = row[key]
      }
      for (const key of ['a50_close', 'a50_pct_chg']) {
        if (!merged[key] && row[key]) merged[key] = row[key]
      }
      for (const key of ['vix_close', 'vix_pct_chg']) {
        if (!merged[key] && row[key]) merged[key] = row[key]
      }
    }
    return formatMarketSignalLine(merged)
  }

  try {
    const quotes = await dataSkill.fetchIndexLive()
    if (quotes.length > 0) {
      const lines = ['📡 实时行情（TickFlow）：']
      for (const q of quotes) {
        lines.push(`${q.label}：${q.close.toFixed(0)} (${q.pct >= 0 ? '+' : ''}${q.pct.toFixed(2)}%)`)
      }
      return lines.join('\n')
    }
  } catch { /* fall through to error */ }

  return '暂无最新市场信号数据（未配置 TickFlow API Key，无法获取实时行情）。请在设置中配置。'
}

// ── market history ─────────────────────────────────────────

type MarketIndexKey = 'sse' | 'csi300' | 'szse' | 'chinext' | 'star50'

const MARKET_INDEXES: Record<MarketIndexKey, { code: string; name: string }> = {
  sse: { code: '000001.SH', name: '上证指数' },
  csi300: { code: '000300.SH', name: '沪深300' },
  szse: { code: '399001.SZ', name: '深证成指' },
  chinext: { code: '399006.SZ', name: '创业板指' },
  star50: { code: '000688.SH', name: '科创50' },
}

function buildMarketHistoryDigest(name: string, rows: KlineRow[]): string {
  if (rows.length === 0) return '无数据'
  const last = rows[rows.length - 1]!
  const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / (values.length || 1)
  return [
    `${name}最近${rows.length}个交易日走势`,
    `最新收盘 ${last.close.toFixed(2)} 开盘 ${last.open.toFixed(2)} 高 ${last.high.toFixed(2)} 低 ${last.low.toFixed(2)}`,
    `近5日成交量均值 ${avg(rows.slice(-5).map(d => d.volume)).toFixed(0)}`,
    rows.length >= 20 ? `近20日均价 ${avg(rows.slice(-20).map(d => d.close)).toFixed(2)}` : '',
    rows.slice(-10).map(d => `${d.date.slice(5)} ${d.close.toFixed(2)}`).join(' → '),
  ].filter(Boolean).join('\n')
}

async function analyzeMarketDigest(
  deps: ToolDeps, model: unknown, name: string, rows: KlineRow[],
): Promise<string> {
  const digest = buildMarketHistoryDigest(name, rows)
  const result = await deps.generateText({
    model: model as Parameters<typeof GenerateTextFn>[0]['model'],
    system: '你是威科夫大盘量价分析师。基于指数历史OHLCV，判断过去一段时间的大盘阶段、供需关系、量价背离、关键支撑压力与当前市场位置。不得只引用当天水温，不得编造数据。',
    prompt: digest,
  })
  return result.text || digest
}

export async function execMarketHistory(
  deps: ToolDeps,
  _userId: string,
  model: unknown,
  days = 100,
  index: MarketIndexKey = 'sse',
): Promise<string> {
  const requestedDays = Math.min(Math.max(Math.trunc(days) || 100, 1), 250)
  const fetchDays = Math.max(requestedDays, 20)
  const target = MARKET_INDEXES[index] || MARKET_INDEXES.sse

  const { source, rows, error } = await dataSkill.fetchIndex(target.code, fetchDays)
  if (rows.length > 0) {
    return analyzeMarketDigest(deps, model, target.name, rows.slice(-requestedDays))
  }

  return `无法获取 ${target.name} 过去 ${requestedDays} 个交易日K线（来源：${source}，错误：${error || '未知'}）。请检查设置中的数据源配置。`
}

// ── query helpers ──────────────────────────────────────────

export async function execQueryRecommendations(deps: ToolDeps, limit: number): Promise<string> {
  const { data } = await deps.supabase
    .from('recommendation_tracking')
    .select('code, name, recommend_date, recommend_count, initial_price, current_price, change_pct, is_ai_recommended')
    .order('recommend_date', { ascending: false })
    .limit(limit)

  if (!data || data.length === 0) return '暂无推荐记录'

  return data.map(r => {
    const parts = [`${String(r.code).padStart(6, '0')} ${r.name}`]
    parts.push(`日期: ${r.recommend_date}`)
    parts.push(`推荐${r.recommend_count}次`)
    if (r.initial_price) parts.push(`入选价: ¥${r.initial_price}`)
    if (r.current_price) parts.push(`现价: ¥${r.current_price}${r.change_pct != null ? ` (${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(2)}%)` : ''}`)
    if (r.is_ai_recommended) parts.push('[AI]')
    return `- ${parts.join(' | ')}`
  }).join('\n')
}

export async function execQueryTailBuy(deps: ToolDeps, limit: number): Promise<string> {
  const { data } = await deps.supabase
    .from('tail_buy_history')
    .select('code, name, action, score, reason, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (!data || data.length === 0) return '暂无尾盘买入记录'

  return data.map(r => {
    const parts = [`${String(r.code).padStart(6, '0')} ${r.name || ''}`]
    parts.push(`${r.action || '--'}`)
    if (r.score != null) parts.push(`评分: ${r.score}`)
    if (r.reason) parts.push(`理由: ${r.reason.slice(0, 120)}`)
    return `- ${parts.join(' | ')}`
  }).join('\n')
}

// ── portfolio update ───────────────────────────────────────

export async function execExecutePortfolioUpdate(
  deps: ToolDeps, userId: string,
  action: string, code: string, name: string | null,
  shares: number | null, cost_price: number | null, stop_loss: number | null,
): Promise<string> {
  const portfolioId = `USER_LIVE:${userId}`

  if (action === 'delete') {
    const { error } = await deps.supabase.from('portfolio_positions').delete().eq('portfolio_id', portfolioId).eq('code', code)
    if (error) return `删除失败：${error.message}`
    return `✅ 已删除持仓 ${code} ${name || ''}`
  }

  const { data: existing } = await deps.supabase.from('portfolio_positions')
    .select('id, code').eq('portfolio_id', portfolioId).eq('code', code).maybeSingle()

  if (action === 'add' && (!shares || !cost_price)) {
    return '⛔ 执行失败：新增持仓必须提供 shares 和 cost_price。请先使用 plan_portfolio_update 确认参数。'
  }

  if (existing) {
    const { error } = await deps.supabase.from('portfolio_positions').update({
      name, shares, cost_price, stop_loss, updated_at: new Date().toISOString(),
    }).eq('id', existing.id)
    if (error) return `更新失败：${error.message}`
    return `✅ 已更新 ${code} ${name || ''} | ${shares}股 成本¥${cost_price}${stop_loss ? ` 止损¥${stop_loss}` : ''}`
  }

  await savePortfolioPosition(deps, portfolioId, code, name, shares, cost_price, stop_loss)
  return `✅ 已新增 ${code} ${name || ''} | ${shares}股 成本¥${cost_price}${stop_loss ? ` 止损¥${stop_loss}` : ''}`
}

async function savePortfolioPosition(
  deps: ToolDeps, portfolioId: string, code: string, name: string | null,
  shares: number | null, cost_price: number | null, stop_loss: number | null,
): Promise<void> {
  const now = new Date().toISOString()
  await deps.supabase.from('portfolio_positions').insert({
    portfolio_id: portfolioId, code, name, shares: shares ?? 0,
    cost_price: cost_price ?? 0, stop_loss, buy_dt: now.slice(0, 10),
    created_at: now, updated_at: now,
  })
}

// ── funnel ─────────────────────────────────────────────────

export async function execTriggerFunnel(deps: ToolDeps, _userId: string): Promise<string> {
  try {
    const { data: { session } } = await deps.supabase.auth.getSession()
    const headers: Record<string, string> = {}
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/funnel/trigger', { method: 'POST', headers })
    const body = await resp.json() as Record<string, unknown>
    if (resp.ok && body.ok) {
      return '✅ 漏斗筛选已启动，系统正在处理（通常需要30-60秒）。完成后请使用 screen_stocks 查看最新选股结果。'
    }
    const err = (body.error as string) || (body.message as string) || resp.statusText
    return `⛔ 漏斗触发失败：${err}`
  } catch (e) {
    return `⛔ 漏斗触发失败：${e instanceof Error ? e.message : '网络错误'}`
  }
}

// ── screen & analyze ───────────────────────────────────────

export interface ScreenStockItem {
  code: string
  name: string
  funnel_score: number | null
  change_pct: number | null
}

export interface ScreenResult {
  date: string
  stocks: ScreenStockItem[]
  meta: { ai_count: number }
}

export async function execScreenStocks(deps: ToolDeps): Promise<string> {
  const { data } = await deps.supabase
    .from('recommendation_tracking')
    .select('code, name, recommend_date, funnel_score, change_pct, is_ai_recommended')
    .eq('is_ai_recommended', true)
    .order('recommend_date', { ascending: false })
    .limit(30)

  if (!data || data.length === 0) return JSON.stringify({ date: '', stocks: [], meta: { ai_count: 0 } })

  const latestDate = data[0]!.recommend_date
  const latest = data.filter(r => r.recommend_date === latestDate)

  const result: ScreenResult = {
    date: latestDate,
    stocks: latest.map(r => ({
      code: String(r.code).padStart(6, '0'),
      name: r.name,
      funnel_score: r.funnel_score ?? null,
      change_pct: r.change_pct ?? null,
    })),
    meta: { ai_count: latest.length },
  }

  return JSON.stringify(result)
}

export async function execAnalyzeStock(
  deps: ToolDeps, _userId: string, _config: LLMToolConfig, model: unknown, code: string, name: string | null,
): Promise<string> {
  const [klineResult, valueSnapshot] = await Promise.all([
    dataSkill.fetchKline(code, 250),
    dataSkill.fetchValueSnapshot(code).catch((): ValueSnapshot => ({ symbol: code, source: 'none', metrics: null, reason: 'not-found' })),
  ])

  if (klineResult.rows.length === 0) {
    const isCn = /^\d{5,6}$/.test(code.replace(/\.\w+$/, ''))
    if (!isCn) {
      return `无法获取 ${code} ${name || ''} 的K线数据。美股/港股诊断需要 TickFlow 标准代码（如 AAPL.US / 00700.HK）。请在设置中配置 TickFlow API Key。`
    }
    return `无法获取 ${code} ${name || ''} 的K线数据（${klineResult.error || '数据源不可用'}）。请检查设置中的数据源配置。`
  }

  const digest = buildKlineDigest(klineResult.rows)
  const valueDigest = buildValueAgentDigest(valueSnapshot)
  const result = await deps.generateText({
    model: model as Parameters<typeof GenerateTextFn>[0]['model'],
    system: `你是威科夫分析大师。基于以下K线数据和价值面摘要，对 ${code} ${name || ''} 进行深度诊断。主框架仍是量价与威科夫阶段判断，价值面只作为质量、风险和仓位置信度校准：技术面负责时机，价值面负责是否值得提高/降低结论置信度。
1. 当前威科夫阶段（积累/上涨/派发/下跌），Phase A-E 定位
2. 量价关系分析（供需力量对比，近期量比变化）
3. 均线形态（多头/空头排列，金叉/死叉）
4. 关键支撑与阻力位
5. 价值面校准（盈利质量、成长、杠杆、现金流如何影响置信度）
6. 主力行为判断（是否有吸筹/出货迹象）
7. 操作建议与风险提示（含建议止损位）

用 Markdown 格式输出，简洁专业。`,
    prompt: `${valueDigest}\n\n${digest}`,
  })

  return result.text || '分析完成但无输出'
}

export async function execGenerateAiReport(
  deps: ToolDeps, _userId: string, _config: LLMToolConfig, model: unknown, codes: string[],
): Promise<string> {
  const results: string[] = []
  for (const code of codes.slice(0, 3)) {
    const [klineResult, valueSnapshot] = await Promise.all([
      dataSkill.fetchKline(code, 250),
      dataSkill.fetchValueSnapshot(code).catch((): ValueSnapshot => ({ symbol: code, source: 'none', metrics: null, reason: 'not-found' })),
    ])
    if (klineResult.rows.length === 0) {
      results.push(`## ${code}\n无法获取K线数据。美股/港股请使用 TickFlow 标准代码（如 AAPL.US / 00700.HK）。\n`)
      continue
    }
    const digest = buildKlineDigest(klineResult.rows)
    const valueDigest = buildValueAgentDigest(valueSnapshot)
    const result = await deps.generateText({
      model: model as Parameters<typeof GenerateTextFn>[0]['model'],
      system: `你是威科夫分析大师。为 ${code} 撰写一份简明研报，包含：阶段判断、量价特征、价值面校准、关键价位、操作建议。价值面只校准质量/风险/置信度，不替代技术面。250字以内。`,
      prompt: `${valueDigest}\n\n${digest}`,
    })
    results.push(`## ${code}\n${result.text || '无输出'}\n`)
  }

  return results.join('\n---\n\n')
}

export async function execStrategyDecision(deps: ToolDeps, userId: string, model: unknown): Promise<string> {
  const portfolioId = `USER_LIVE:${userId}`

  const [posResult, signalResult] = await Promise.all([
    deps.supabase.from('portfolio_positions').select('code, name, shares, cost_price, stop_loss').eq('portfolio_id', portfolioId),
    deps.supabase.from('market_signal_daily').select('*').order('trade_date', { ascending: false }).limit(1).single(),
  ])

  const positions = posResult.data || []
  const signal = signalResult.data

  if (positions.length === 0) return '当前无持仓，无法给出操作建议。建议先通过选股工具寻找标的。'

  const posInfo = positions.map(p =>
    `${p.code} ${p.name} | ${p.shares}股 成本¥${p.cost_price}${p.stop_loss ? ` 止损¥${p.stop_loss}` : ''}`
  ).join('\n')

  const marketInfo = signal
    ? `大盘状态: ${signal.benchmark_regime || '未知'}, 上证: ${signal.main_index_close || '--'}, A50涨幅: ${signal.a50_pct_chg || '--'}%, VIX: ${signal.vix_close || '--'}`
    : '暂无市场数据'

  const result = await deps.generateText({
    model: model as Parameters<typeof GenerateTextFn>[0]['model'],
    system: '你是威科夫大师。基于用户的持仓和当前市场环境，为每只持仓股给出操作建议（买入加仓/持有/减仓/卖出），并给出整体仓位管理建议。简洁明了，必须附带风险提示。',
    prompt: `当前持仓:\n${posInfo}\n\n市场环境:\n${marketInfo}`,
  })

  return result.text || '无法生成建议'
}


export async function execIntradayAnalysis(_deps: ToolDeps, _userId: string, code: string): Promise<string> {
  const { periods, error } = await dataSkill.fetchIntraday(code)
  if (error) return error

  const rows1m = periods['1m'] || []
  const rows5m = periods['5m'] || []
  const rows15m = periods['15m'] || []

  if (!rows1m || rows1m.length < 10) return `${code} 无法获取分钟线数据，可能非交易时段或代码有误。`

  const profile = computeIntradayProfile(rows1m, rows5m, rows15m)
  const lines = [
    `📊 ${code} 盘中简评（${rows1m.length}根1m线，仅供参考，权威评分以后端策略为准）`,
    `VWAP位置: ${profile.vwapPos > 0 ? '上方' : '下方'} ${profile.vwapPos.toFixed(2)}%`,
    `日内位置: ${(profile.closePos * 100).toFixed(0)}%（0=最低 100=最高）`,
    `5m趋势: ${profile.trendShort} | 15m趋势: ${profile.trendMid}`,
    `30m动量: ${profile.momentum30m.toFixed(2)}% | 15m动量: ${profile.momentum15m.toFixed(2)}%`,
    `量能分布: ${profile.volumeConcentration}`,
    `参考强度: ${profile.strengthScore.toFixed(0)}/100（简化算法，不含量价深度分析）`,
  ]
  return lines.join('\n')
}

// ── signal_quality ──────────────────────────────────────────

export async function execGetSignalQuality(): Promise<string> {
  const { report, error } = await dataSkill.fetchSignalQuality()
  if (error) return `信号质量数据获取失败：${error}`
  if (!report) return '暂无信号质量数据。信号反馈系统可能需要更多样本才能生成报告。'
  return report
}

// ── alert management ──────────────────────────────────────────

export async function execManageAlerts(
  _deps: ToolDeps,
  action: string,
  ruleId: string | null,
  ruleSpec: Record<string, unknown> | null,
): Promise<string> {
  if (action === 'list') {
    const { rules, error } = await dataSkill.fetchAlerts()
    if (error) return `预警规则获取失败：${error}`
    if (!rules || rules.length === 0) return '暂无预警规则。\n\n可以用"添加预警"来创建新规则，例如：价格突破、放量异动、指数波动等。'
    const lines = rules.map((r: Record<string, unknown>) => {
      const status = r.enabled ? '🟢' : '⚫'
      const conds = (r.conditions as Array<Record<string, unknown>>) || []
      const condStr = conds.map((c: Record<string, unknown>) =>
        `${c.type}: ${c.symbol || c.index_code || c.regime_value || ''} ${c.threshold || c.multiplier || ''}`
      ).join(', ')
      return `${status} **[${r.id}]** ${r.name}\n   └─ ${condStr}\n   冷却: ${r.cooldown_minutes}分钟`
    })
    return `## 预警规则 (${rules.length} 条)\n\n${lines.join('\n')}`
  }

  if (action === 'add') {
    if (!ruleSpec || !ruleSpec.id) return '⛔ 添加规则失败：缺少规则 id 字段。'
    const result = await dataSkill.saveAlert(ruleSpec)
    return result.ok ? `✅ ${result.message}` : `⛔ ${result.message}`
  }

  if (action === 'delete') {
    if (!ruleId) return '⛔ 删除规则失败：缺少规则 ID。'
    const result = await dataSkill.deleteAlert(ruleId)
    return result.ok ? `✅ ${result.message}` : `⛔ ${result.message}`
  }

  if (action === 'run') {
    const result = await dataSkill.runAlerts(false)
    const triggered = (result.triggered as number) || 0
    const total = (result.total as number) || 0
    if (triggered > 0) return `✅ 预警引擎已触发 ${triggered}/${total} 条规则。`
    return `· ${total} 条规则均未触发当前条件。`
  }

  return `未知操作：${action}。支持的操作：list, add, delete, run`
}

export async function execPortfolioRisk(
  _deps: ToolDeps,
  positions: Array<Record<string, unknown>>,
  lookbackDays: number | null,
): Promise<string> {
  if (!positions || positions.length === 0) return '⛔ 请提供持仓列表。用法：传入 positions=[{code, shares, cost_price}, ...]'
  const result = await dataSkill.fetchPortfolioRisk(positions, lookbackDays || 252)
  if ((result as Record<string, unknown>).error) return `⛔ 风险分析失败：${(result as Record<string, unknown>).error}`

  const r = result as Record<string, unknown>
  const portfolio = r.portfolio as Record<string, unknown>
  const var_ = r.var as Record<string, unknown>
  const vol = r.volatility as Record<string, unknown>
  const mdd = r.max_drawdown as Record<string, unknown>
  const corr = r.correlation as Record<string, unknown>
  const stress = r.stress_test as Array<Record<string, unknown>>
  const errors = r.fetch_errors as string[] | undefined

  const lines: string[] = []
  lines.push(`## 组合风险报告\n`)
  lines.push(`**总市值**: ${portfolio.total_value} 元 | **持仓数**: ${portfolio.position_count}\n`)
  lines.push(`### VaR（风险价值）`)
  lines.push(`| 指标 | 日 VaR(%) |`)
  lines.push(`|------|----------|`)
  lines.push(`| 历史 VaR(95%) | ${var_.historical_95pct}% |`)
  lines.push(`| 参数 VaR(95%) | ${var_.parametric_95pct}% |`)
  lines.push(`| 历史 VaR(99%) | ${var_.historical_99pct}% |`)
  lines.push(`| CVaR(95%) | ${var_.cvar_95pct}% |`)
  lines.push(`| CVaR(99%) | ${var_.cvar_99pct}% |`)
  lines.push(`| 组合 VaR(95%) | ${var_.portfolio_var_95pct}% |`)
  lines.push(`| 组合 CVaR(95%) | ${var_.portfolio_cvar_95pct}% |\n`)

  lines.push(`### 波动率`)
  lines.push(`年化波动率: **${vol.annualized_vol_pct}%**\n`)

  if (mdd.max_drawdown_pct != null) {
    lines.push(`### 最大回撤`)
    lines.push(`**${mdd.max_drawdown_pct}%** (峰值 ${mdd.peak_value} → 谷值 ${mdd.trough_value})\n`)
  }

  const hcWarnings = corr.high_correlation_warnings as string[] | undefined
  if (hcWarnings && hcWarnings.length > 0) {
    lines.push(`### 相关性预警`)
    for (const w of hcWarnings) lines.push(`- ${w}`)
    lines.push('')
  }

  if (stress && stress.length > 0) {
    lines.push(`### 压力测试（假设市场下跌）`)
    lines.push(`| 情景 | 损失金额 | 损失% | 剩余市值 | 剩余% |`)
    lines.push(`|------|---------|-------|---------|-------|`)
    for (const s of stress) {
      lines.push(`| ${s.scenario} | ${s.loss_amount} | ${s.loss_pct}% | ${s.remaining_value} | ${s.remaining_pct}% |`)
    }
    lines.push('')
  }

  if (errors && errors.length > 0) {
    lines.push(`### 数据源异常`)
    for (const e of errors) lines.push(`- ${e}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ── intraday helpers (no data fetching) ────────────────────

interface IntradayProfileWeb {
  vwapPos: number; closePos: number
  trendShort: string; trendMid: string
  momentum30m: number; momentum15m: number
  volumeConcentration: string; strengthScore: number
}

function computeIntradayProfile(rows1m: KlineRow[], rows5m: KlineRow[], rows15m: KlineRow[]): IntradayProfileWeb {
  const closes1m = rows1m.map(r => r.close)
  const volumes1m = rows1m.map(r => r.volume)
  const highs1m = rows1m.map(r => r.high || r.close)
  const lows1m = rows1m.map(r => r.low || r.close)
  const last = closes1m[closes1m.length - 1]!
  const dayHigh = Math.max(...highs1m)
  const dayLow = Math.min(...lows1m)
  const dayRange = Math.max(dayHigh - dayLow, 1e-8)
  const closePos = Math.max(0, Math.min(1, (last - dayLow) / dayRange))
  const totalAmount = rows1m.reduce((s, r) => s + r.close * r.volume, 0)
  const totalVol = volumes1m.reduce((s, v) => s + v, 0)
  const vwap = totalVol > 0 ? totalAmount / totalVol : last
  const vwapPos = vwap > 0 ? (last / vwap - 1) * 100 : 0
  const momentum30m = retPct(closes1m, 30)
  const momentum15m = retPct(closes1m, 15)
  const trendShort = rows5m.length >= 4 ? computeTrendDir(rows5m) : computeTrendDir(rows1m)
  const trendMid = rows15m.length >= 4 ? computeTrendDir(rows15m) : 'flat'
  const mid = (dayHigh + dayLow) / 2
  const volAbove = rows1m.filter(r => r.close >= mid).reduce((s, r) => s + r.volume, 0)
  const volTotal = totalVol || 1
  const ratio = volAbove / volTotal
  const volumeConcentration = ratio > 0.62 ? '堆量在高位' : ratio < 0.38 ? '堆量在低位' : '均匀分布'
  const strengthScore = computeStrength(vwapPos, closePos, momentum30m, momentum15m, trendShort, trendMid, volumeConcentration)
  return { vwapPos, closePos, trendShort, trendMid, momentum30m, momentum15m, volumeConcentration, strengthScore }
}

function retPct(closes: number[], lookback: number): number {
  if (closes.length <= lookback) return 0
  const base = closes[closes.length - 1 - lookback]!
  const now = closes[closes.length - 1]!
  return base > 0 ? ((now - base) / base) * 100 : 0
}

function computeTrendDir(rows: KlineRow[]): string {
  const closes = rows.map(r => r.close)
  const first = closes[0]!
  const last = closes[closes.length - 1]!
  const change = last - first
  if (change > first * 0.01) return '上升'
  if (change < -first * 0.01) return '下降'
  return '横盘'
}

export async function execTuneParameters(
  benchCode: string | null,
  smallcapCode: string | null,
  lookbackDays: number | null,
): Promise<string> {
  const result = await dataSkill.fetchParameterTuning(
    benchCode || undefined,
    smallcapCode || undefined,
    lookbackDays || 252,
  )
  if ((result as Record<string, unknown>).error) return `⛔ 参数调优失败：${(result as Record<string, unknown>).error}`

  const r = result as Record<string, unknown>
  const mc = r.market_context as Record<string, unknown> || {}
  const ba = r.before_after as Record<string, unknown> || {}
  const before = ba.before as Record<string, unknown> || {}
  const after = ba.after as Record<string, unknown> || {}
  const changed = ba.changed as Record<string, unknown> || {}
  const panic = r.panic as Record<string, unknown> || {}
  const breadth = r.breadth as Record<string, unknown> || {}

  const lines: string[] = []
  lines.push(`## 自适应参数调优报告\n`)
  lines.push(`**市场水温**: ${r.regime} | 上证 ${mc.close} (MA50: ${mc.ma50}, MA200: ${mc.ma200})\n`)

  lines.push(`### 大盘状态`)
  lines.push(`| 指标 | 值 |`)
  lines.push(`|------|----|`)
  if (mc.recent3_cum_pct != null) lines.push(`| 近3日涨跌 | ${mc.recent3_cum_pct}% |`)
  if (mc.main_volume_state) lines.push(`| 量能状态 | ${mc.main_volume_state} (5/20日比 ${mc.main_vol_ratio_5_20}) |`)
  if (mc.smallcap_recent3_cum_pct != null) lines.push(`| 创业板近3日 | ${mc.smallcap_recent3_cum_pct}% |`)

  if (breadth.ratio_pct != null) {
    lines.push(`| 市场广度 | ${breadth.ratio_pct}% (Δ${breadth.delta_pct}%, n=${breadth.sample_size}) |`)
  }
  if (r.breadth_note) lines.push(`\n*${r.breadth_note}*`)
  lines.push('')

  if (panic.triggered) {
    lines.push(`### ⚠️ 恐慌触发`)
    const reasons = panic.reasons as string[]
    for (const rr of reasons) lines.push(`- ${rr}`)
    lines.push('')
  }
  if ((r.repair as Record<string, unknown>)?.triggered) {
    lines.push(`### 🔧 修复中`)
    const rr = (r.repair as Record<string, unknown>).reasons as string[]
    for (const rrr of rr) lines.push(`- ${rrr}`)
    lines.push('')
  }

  lines.push(`### 参数调优对比`)
  lines.push(`| 参数 | 原始值 | 调优后 | 变动 |`)
  lines.push(`|------|--------|--------|:----:|`)
  const paramNames: Record<string, string> = {
    min_avg_amount_wan: 'L1 最小日均额(万)', rs_min_long: 'RS 长窗最小区间',
    rs_min_short: 'RS 短窗最小区间', rps_fast_min: 'RPS50 最小值',
    rps_slow_min: 'RPS120 最小值', enable_evr_trigger: 'EVR 触发',
  }
  for (const [k, label] of Object.entries(paramNames)) {
    const b = before[k]
    const a = after[k]
    const ch = changed[k] ? '✅' : '—'
    const bStr = typeof b === 'boolean' ? (b ? '开' : '关') : String(b ?? '—')
    const aStr = typeof a === 'boolean' ? (a ? '开' : '关') : String(a ?? '—')
    lines.push(`| ${label} | ${bStr} | ${aStr} | ${ch} |`)
  }
  lines.push('')

  if (r.outlook_summary) {
    lines.push(`### 量价推演`)
    lines.push(`${r.outlook}\n`)
  }

  const fetchErrors = r.fetch_errors as string[] | undefined
  if (fetchErrors && fetchErrors.length > 0) {
    lines.push(`---`)
    for (const e of fetchErrors) lines.push(`⚠️ ${e}`)
  }

  return lines.join('\n')
}

// ── walk_forward / monte_carlo ────────────────────────────

export async function execWalkForwardOptimize(
  trades: Array<Record<string, unknown>>,
  paramGrid: Record<string, number[]> | null,
  trainMonths: number | null,
  testMonths: number | null,
): Promise<string> {
  if (!trades || trades.length < 10) return '⛔ 请提供至少 10 笔交易记录。用法：trades=[{signal_date, ret_pct, score}, ...]'
  const result = await dataSkill.fetchWalkForward(trades, paramGrid || undefined, trainMonths || 12, testMonths || 3)
  if ((result as Record<string, unknown>).error) return `⛔ Walk-Forward 优化失败：${(result as Record<string, unknown>).error}`

  const r = result as Record<string, unknown>
  const lines: string[] = []
  lines.push(`## Walk-Forward 优化报告\n`)
  lines.push(`**窗口数**: ${r.n_windows} | **样本外夏普**: ${r.oos_sharpe} | **样本外胜率**: ${r.oos_win_rate_pct}%\n`)

  const rec = r.recommendation as Record<string, number>
  if (rec && Object.keys(rec).length > 0) {
    lines.push(`### 推荐参数`)
    for (const [k, v] of Object.entries(rec)) lines.push(`- ${k}: **${v}**`)
    lines.push('')
  }

  const stability = r.param_stability as Record<string, number>
  if (stability && Object.keys(stability).length > 0) {
    lines.push(`### 参数稳定性（标准差，越小越稳定）`)
    for (const [k, v] of Object.entries(stability)) lines.push(`- ${k}: ${v}`)
    lines.push('')
  }

  const windows = r.windows as Array<Record<string, unknown>>
  if (windows && windows.length > 0) {
    lines.push(`### 各窗口明细`)
    lines.push(`| 训练窗 | 测试窗 | 最优参数 | 训练夏普 | 测试夏普 | 测试笔数 |`)
    lines.push(`|--------|--------|----------|---------|---------|---------|`)
    for (const w of windows.slice(0, 10)) {
      lines.push(`| ${w.train} | ${w.test} | ${JSON.stringify(w.best_params)} | ${w.train_sharpe} | ${w.test_sharpe} | ${w.test_trades} |`)
    }
  }

  return lines.join('\n')
}

export async function execMonteCarloSimulate(
  returns: number[] | null,
  nSimulations: number | null,
  nTrades: number | null,
  initialCapital: number | null,
): Promise<string> {
  if (!returns || !Array.isArray(returns) || returns.length < 5) return '⛔ 请提供至少 5 笔收益率。用法：returns=[5.2, -3.1, 8.7, ...]'
  const result = await dataSkill.fetchMonteCarlo(returns, nSimulations || 5000, nTrades || 100, initialCapital || 100000)
  if ((result as Record<string, unknown>).error) return `⛔ Monte Carlo 模拟失败：${(result as Record<string, unknown>).error}`

  const r = result as Record<string, unknown>
  const is = r.input_stats as Record<string, unknown> || {}
  const lines: string[] = []
  lines.push(`## Monte Carlo 模拟报告\n`)
  lines.push(`**输入**: ${is.n_trades_input} 笔交易 | 平均收益 ${is.avg_ret_pct}% | 胜率 ${is.win_rate_pct}% | 偏度 ${is.skewness}\n`)
  lines.push(`**模拟**: ${r.n_simulations} 次 × ${r.n_trades_per_run} 笔/次 | 初始资金 ¥${r.initial_capital}\n`)

  lines.push(`### 最终权益分布`)
  lines.push(`| 分位数 | 权益 |`)
  lines.push(`|--------|------|`)
  lines.push(`| P5 (最差) | ¥${r.final_equity_p5} |`)
  lines.push(`| P25 | ¥${r.final_equity_p25} |`)
  lines.push(`| P50 (中位) | ¥${r.final_equity_p50} |`)
  lines.push(`| P75 | ¥${r.final_equity_p75} |`)
  lines.push(`| P95 (最佳) | ¥${r.final_equity_p95} |\n`)

  lines.push(`### 风险指标`)
  lines.push(`| 指标 | 值 |`)
  lines.push(`|------|----|`)
  lines.push(`| VaR(95%) | ${r.var95_pct}% |`)
  lines.push(`| CVaR(95%) | ${r.cvar95_pct}% |`)
  lines.push(`| 最大回撤 P50 | ${r.max_dd_p50_pct}% |`)
  lines.push(`| 最大回撤 P95 | ${r.max_dd_p95_pct}% |`)
  lines.push(`| 盈利概率 | ${r.prob_profit_pct}% |`)
  lines.push(`| 回撤>20%概率 | ${r.prob_ruin_20pct_pct}% |\n`)

  return lines.join('\n')
}

/** 出场策略基准对比 */
export async function execBenchmarkExitStrategies(
  ohlcData: Record<string, Record<string, number[]>>,
  sortedDates: Record<string, string[]>,
  trades: Array<Record<string, unknown>>,
  strategies?: string[],
  extraParams?: Record<string, Record<string, unknown>>,
): Promise<string> {
  const result = await dataSkill.fetchBenchmarkExits(ohlcData, sortedDates, trades, strategies, extraParams)
  if (result.error) return `出场策略对比失败：${result.error}`
  const rankings = result.rankings as Array<Record<string, unknown>> || []
  const lines: string[] = ['## 出场策略基准对比\n']
  lines.push(`| 排名 | 策略 | 平均收益% | 胜率% | 盈亏比 | Sharpe | 触发率% |`)
  lines.push('|------|------|----------|------|--------|--------|--------|')
  for (const r of rankings) {
    lines.push(`| ${r.rank || rankings.indexOf(r) + 1} | ${r.name} | ${r.avg_ret} | ${r.win_rate} | ${r.profit_factor} | ${r.sharpe_approx} | ${r.exit_rate} |`)
  }
  if (result.best_strategy) lines.push(`\n🏆 最佳策略：**${result.best_strategy}** (Sharpe=${result.best_sharpe})`)
  return lines.join('\n')
}

/** 出场质量评估 */
export async function execAnalyzeExitQuality(
  exits: Array<Record<string, unknown>>,
): Promise<string> {
  const result = await dataSkill.fetchExitQuality(exits)
  if (result.error) return `出场质量评估失败：${result.error}`
  const lines: string[] = ['## 出场质量评估\n']
  lines.push(`| 指标 | 数值 |`)
  lines.push('|------|------|')
  lines.push(`| 评级 | **${result.grade}** |`)
  lines.push(`| 过早离场率 | ${result.early_exit_rate}% |`)
  lines.push(`| 平均利润回吐 | ${result.profit_giveback_avg}% |`)
  lines.push(`| MFE(最大有利偏移) | ${result.mfe_avg}% |`)
  lines.push(`| MAE(最大不利偏移) | ${result.mae_avg}% |`)
  lines.push(`| 样本数 | ${result.sample_size} |`)
  if (Array.isArray(result.advice) && result.advice.length > 0) {
    lines.push('\n💡 改进建议：')
    for (const a of result.advice as string[]) lines.push(`- ${a}`)
  }
  return lines.join('\n')
}

function computeStrength(vwapPos: number, closePos: number, m30: number, _m15: number, trendShort: string, trendMid: string, volumeConcentration: string): number {
  let score = 50
  if (vwapPos > 0.5) score += 10
  if (vwapPos < -0.5) score -= 10
  if (closePos > 0.6) score += 10
  if (closePos < 0.4) score -= 10
  if (m30 > 1) score += 10
  if (m30 < -1) score -= 10
  if (trendShort === '上升') score += 5
  if (trendShort === '下降') score -= 5
  if (trendMid === '上升') score += 5
  if (trendMid === '下降') score -= 5
  if (volumeConcentration === '堆量在高位' && closePos > 0.5) score += 5
  if (volumeConcentration === '堆量在低位' && closePos < 0.5) score += 5
  return Math.max(0, Math.min(100, score))
}

export async function execDataSourceHealth(): Promise<string> {
  const health = await dataSkill.fetchDataSourceHealth()
  if (health.error) return `⚠️ 获取数据源健康状态失败: ${health.error}`

  const entries = Object.entries(health).filter(([k]) => k !== 'baostock_circuit' && k !== 'error')
  if (entries.length === 0) return '📡 数据源健康：暂无数据（尚未有数据源被调用）'

  const lines = ['📡 **数据源健康快照**\n']
  for (const [name, m] of entries) {
    const meta = m as Record<string, unknown>
    const rate = meta.success_rate_pct ?? 0
    const total = Number(meta.success ?? 0) + Number(meta.failure ?? 0)
    const status = Number(rate) >= 95 ? '🟢' : Number(rate) >= 70 ? '🟡' : '🔴'
    lines.push(
      `${status} **${name}** | 成功率: ${rate}% | 总调用: ${total} | ` +
      `均延迟: ${meta.avg_latency_ms ?? 0}ms | ` +
      `最后错误: ${meta.last_error || '无'}`
    )
  }

  // 熔断器状态
  const bao = health.baostock_circuit as Record<string, unknown> | undefined
  if (bao) {
    const open = bao.open as boolean
    const note = bao.note as string || ''
    if (open) lines.push(`\n⚠️ **BaoStock 熔断**：${note}`)
  }

  return lines.join('\n')
}
