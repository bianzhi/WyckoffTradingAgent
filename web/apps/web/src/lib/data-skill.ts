/**
 * Phase 0.1 — DataSkill 客户端
 *
 * 所有 Agent 工具通过此模块统一请求行情数据。
 * 不再需要各自拼 TickFlow/tushare 参数、注入 Token、手写降级链。
 *
 * 用法：
 *   import { dataSkill } from './data-skill'
 *   const rows = await dataSkill.fetchKline(code, 250)
 */

import type { ValueSnapshot } from './kline'

export type KlineRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type { ValueSnapshot }

export interface IndexQuote {
  code: string
  label: string
  close: number
  pct: number
}

export interface DataResponse<T> {
  source?: string
  symbol?: string
  code?: string
  rows?: KlineRow[]
  quotes?: T[]
  metrics?: Record<string, unknown> | null
  reason?: string
  error?: string
  periods?: Record<string, KlineRow[]>
}

// ── internal fetcher ───────────────────────────────────────

async function authFetch(path: string): Promise<DataResponse<unknown>> {
  const { supabase } = await import('./supabase')
  const { data: { session } } = await supabase.auth.getSession()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`
  }
  const resp = await fetch(path, { headers })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const parsed = tryParse(text)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      throw new Error(String((parsed as Record<string, unknown>).error))
    }
    throw new Error(`DataSkill: ${resp.status} ${resp.statusText}`)
  }
  return resp.json()
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

// ── public API ─────────────────────────────────────────────

export const dataSkill = {
  /** 个股日线K线（TickFlow → tushare 降级） */
  async fetchKline(code: string, days = 250): Promise<{ source: string; rows: KlineRow[]; error?: string }> {
    const res = await authFetch(`/api/data/kline?symbol=${encodeURIComponent(code)}&days=${days}`)
    return {
      source: String(res.source || 'none'),
      rows: Array.isArray(res.rows) ? res.rows as KlineRow[] : [],
      error: res.error as string | undefined,
    }
  },

  /** 大盘指数日线K线 */
  async fetchIndex(code: string, days = 100): Promise<{ source: string; rows: KlineRow[]; error?: string }> {
    const res = await authFetch(`/api/data/index?code=${encodeURIComponent(code)}&days=${days}`)
    return {
      source: String(res.source || 'none'),
      rows: Array.isArray(res.rows) ? res.rows as KlineRow[] : [],
      error: res.error as string | undefined,
    }
  },

  /** 价值面快照（基本面指标） */
  async fetchValueSnapshot(code: string): Promise<ValueSnapshot> {
    const res = await authFetch(`/api/data/value?symbol=${encodeURIComponent(code)}`)
    return {
      symbol: String(res.symbol || code),
      source: (res.source as ValueSnapshot['source']) || 'none',
      metrics: (res.metrics ?? null) as unknown as ValueSnapshot['metrics'],
      reason: String(res.reason || '') as ValueSnapshot['reason'],
    } as ValueSnapshot
  },

  /** 实时指数行情（上证/深证/创业板/科创50） */
  async fetchIndexLive(): Promise<IndexQuote[]> {
    const res = await authFetch('/api/data/index-live')
    if (res.error) throw new Error(res.error)
    return (Array.isArray(res.quotes) ? res.quotes : []) as IndexQuote[]
  },

  /** 批量行情快照 */
  async fetchQuotes(symbols: string[]): Promise<Record<string, Record<string, number>>> {
    if (symbols.length === 0) return {}
    const res = await authFetch(`/api/data/quotes?symbols=${symbols.map(encodeURIComponent).join(',')}`)
    return (res.quotes ?? {}) as unknown as Record<string, Record<string, number>>
  },

  /** 分钟线日内数据 */
  async fetchIntraday(code: string): Promise<{ symbol: string; periods: Record<string, KlineRow[]>; error?: string }> {
    const res = await authFetch(`/api/data/intraday?symbol=${encodeURIComponent(code)}`)
    return {
      symbol: String(res.symbol || code),
      periods: (res.periods as Record<string, KlineRow[]>) || {},
      error: res.error as string | undefined,
    }
  },

  /** 信号质量评分报告 */
  async fetchSignalQuality(): Promise<{ report: string; error?: string }> {
    const res = (await authFetch('/api/data/signal-quality')) as unknown as Record<string, unknown>
    return {
      report: String(res.report || ''),
      error: res.error as string | undefined,
    }
  },

  /** 信号观察池列表 */
  async fetchSignalObservations(status: string, limit?: number, offset?: number): Promise<{ observations: Array<Record<string, unknown>>; total: number; error?: string }> {
    const params = new URLSearchParams({ status, limit: String(limit ?? 50), offset: String(offset ?? 0) })
    const res = (await authFetch(`/api/data/signal-observations?${params}`)) as unknown as Record<string, unknown>
    return {
      observations: (res.observations as Array<Record<string, unknown>>) || [],
      total: Number(res.total || 0),
      error: res.error as string | undefined,
    }
  },

  /** 预警规则列表 */
  async fetchAlerts(): Promise<{ rules: Array<Record<string, unknown>>; error?: string }> {
    const res = (await authFetch('/api/data/alerts')) as unknown as Record<string, unknown>
    return { rules: (res.rules as Array<Record<string, unknown>>) || [], error: res.error as string | undefined }
  },

  /** 保存预警规则 */
  async saveAlert(rule: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/alerts/save', { method: 'POST', headers, body: JSON.stringify({ rule }) })
    const json = await resp.json()
    return { ok: Boolean(json.ok), message: String(json.message || '') }
  },

  /** 删除预警规则 */
  async deleteAlert(id: string): Promise<{ ok: boolean; message: string }> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch(`/api/data/alerts/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
    const json = await resp.json()
    return { ok: Boolean(json.ok), message: String(json.message || '') }
  },

  /** 运行预警引擎 */
  async runAlerts(dryRun: boolean): Promise<Record<string, unknown>> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/alerts/run', { method: 'POST', headers, body: JSON.stringify({ dry_run: dryRun }) })
    return resp.json()
  },

  /** 组合风险分析 */
  async fetchPortfolioRisk(positions: Array<Record<string, unknown>>, lookbackDays?: number): Promise<Record<string, unknown>> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/portfolio-risk', {
      method: 'POST', headers,
      body: JSON.stringify({ positions, lookback_days: lookbackDays || 252 }),
    })
    return resp.json()
  },

  /** 自适应参数调优 */
  async fetchParameterTuning(benchCode?: string, smallcapCode?: string, lookbackDays?: number): Promise<Record<string, unknown>> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/parameter-tuning', {
      method: 'POST', headers,
      body: JSON.stringify({ bench_code: benchCode || '000001', smallcap_code: smallcapCode || '399006', lookback_days: lookbackDays || 252 }),
    })
    return resp.json()
  },

  /** Walk-Forward 优化 */
  async fetchWalkForward(trades: Array<Record<string, unknown>>, paramGrid?: Record<string, number[]>, trainMonths?: number, testMonths?: number): Promise<Record<string, unknown>> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/walk-forward', {
      method: 'POST', headers,
      body: JSON.stringify({ trades, param_grid: paramGrid, train_months: trainMonths || 12, test_months: testMonths || 3 }),
    })
    return resp.json()
  },

  /** Monte Carlo 模拟 */
  async fetchMonteCarlo(returns: number[], nSimulations?: number, nTrades?: number, initialCapital?: number): Promise<Record<string, unknown>> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/monte-carlo', {
      method: 'POST', headers,
      body: JSON.stringify({ returns, n_simulations: nSimulations || 5000, n_trades: nTrades || 100, initial_capital: initialCapital || 100000 }),
    })
    return resp.json()
  },

  /** 出场策略基准对比 */
  async fetchBenchmarkExits(ohlcData: Record<string, Record<string, number[]>>, sortedDates: Record<string, string[]>, trades: Array<Record<string, unknown>>, strategies?: string[], extraParams?: Record<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/benchmark-exit-strategies', {
      method: 'POST', headers,
      body: JSON.stringify({ ohlc_data: ohlcData, sorted_dates: sortedDates, trades, strategies, extra_params: extraParams }),
    })
    return resp.json()
  },

  /** 出场质量评估 */
  async fetchExitQuality(exits: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/analyze-exit-quality', {
      method: 'POST', headers,
      body: JSON.stringify({ exits }),
    })
    return resp.json()
  },

  /** 数据源健康状态快照 */
  async fetchDataSourceHealth(): Promise<Record<string, unknown>> {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/data/data-source-health', { headers })
    return resp.json()
  },
}
