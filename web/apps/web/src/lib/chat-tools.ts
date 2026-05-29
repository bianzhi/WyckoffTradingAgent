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
