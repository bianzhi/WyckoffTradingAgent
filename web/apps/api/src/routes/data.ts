/**
 * Phase 0.1 — 统一数据代理（DataSkill 后端）
 *
 * 所有 Agent 工具通过此路由统一获取行情数据。后端负责：
 * 1. Token 注入（从 user_settings + system_settings fallback）
 * 2. 降级链（TickFlow → tushare → 明确错误提示）
 * 3. 统一的数据清洗和格式化
 *
 * 客户端只需调用 /api/data/* 端点，不需要知道数据源细节。
 */
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import type { Env } from '../index'

// ── types ─────────────────────────────────────────────────

interface KlineRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface ValueSnapshot {
  symbol: string
  source: 'tickflow' | 'tushare' | 'none'
  metrics: Record<string, unknown> | null
  reason: string
}

interface IndexQuote {
  code: string
  label: string
  close: number
  pct: number
}

// ── helpers ───────────────────────────────────────────────

function isCnSymbol(code: string): boolean {
  return /^\d{5,6}$/.test(code.replace(/\.\w+$/, ''))
}

function normalizeTickFlowSymbol(code: string): string {
  const c = code.replace(/\.\w+$/, '').trim().toUpperCase()
  if (c.match(/^\d{5,6}$/)) {
    if (c.startsWith('6')) return `${c}.SH`
    if (c.startsWith('4') || c.startsWith('8') || c.startsWith('9')) return `${c}.BJ`
    return `${c}.SZ`
  }
  return c
}

function normalizeTushareCode(code: string): string {
  const c = code.replace(/\.\w+$/, '')
  if (c.startsWith('6')) return `${c}.SH`
  if (c.startsWith('4') || c.startsWith('8') || c.startsWith('9')) return `${c}.BJ`
  return `${c}.SZ`
}

function parseTickFlowKlineTable(table: Record<string, unknown[]>): KlineRow[] {
  const ts = Array.isArray(table.timestamp) ? table.timestamp : []
  if (ts.length === 0) return []
  const o = table.open || [], h = table.high || [], l = table.low || []
  const c = table.close || [], v = table.volume || []
  return ts.map((t, i) => ({
    date: formatTimestamp(t),
    open: Number(o[i] || 0), high: Number(h[i] || 0),
    low: Number(l[i] || 0), close: Number(c[i] || 0),
    volume: Number(v[i] || 0),
  })).filter(d => d.date && d.close > 0)
}

function parseTickFlowKline(payload: unknown, symbol: string): KlineRow[] {
  if (!payload || typeof payload !== 'object') return []
  const json = payload as Record<string, unknown>

  // Array form
  if (Array.isArray(json.data)) {
    return (json.data as Record<string, unknown>[]).map(r => ({
      date: String(r.date || r.trade_date || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
      open: Number(r.open || 0), high: Number(r.high || 0),
      low: Number(r.low || 0), close: Number(r.close || 0),
      volume: Number(r.volume || r.vol || 0),
    })).filter(d => d.date && d.close > 0)
  }
  if (Array.isArray(json.records)) {
    return (json.records as Record<string, unknown>[]).map(r => ({
      date: String(r.date || r.trade_date || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
      open: Number(r.open || 0), high: Number(r.high || 0),
      low: Number(r.low || 0), close: Number(r.close || 0),
      volume: Number(r.volume || r.vol || 0),
    })).filter(d => d.date && d.close > 0)
  }

  // Table form
  const data = json.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.timestamp)) return parseTickFlowKlineTable(obj as Record<string, unknown[]>)
    const direct = obj[symbol]
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      const t = direct as Record<string, unknown>
      if (Array.isArray(t.timestamp)) return parseTickFlowKlineTable(t as Record<string, unknown[]>)
    }
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const t = val as Record<string, unknown>
        if (Array.isArray(t.timestamp)) return parseTickFlowKlineTable(t as Record<string, unknown[]>)
      }
    }
  }
  return []
}

function formatTimestamp(value: unknown): string {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return new Date((n + 8 * 3600) * 1000).toISOString().slice(0, 10)
  return String(value || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3').slice(0, 10)
}

function compactDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

// ── key resolution ────────────────────────────────────────

async function resolveDataKeys(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<{ tickflow: string | null; tushare: string | null }> {
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // 1) user settings
  const { data: userRow } = await supabase
    .from('user_settings')
    .select('tickflow_api_key, tushare_token')
    .eq('user_id', userId)
    .maybeSingle()
  const tickflow = String(userRow?.tickflow_api_key || '').trim() || null
  const tushare = String(userRow?.tushare_token || '').trim() || null
  if (tickflow && tushare) return { tickflow, tushare }

  // 2) system fallback
  const { data: sysRows } = await supabase
    .from('system_settings')
    .select('key, value')
  const sysMap: Record<string, string> = {}
  if (sysRows) {
    for (const r of sysRows as Array<{ key: string; value: string }>) {
      sysMap[r.key] = r.value || ''
    }
  }

  return {
    tickflow: tickflow || sysMap.tickflow_api_key || null,
    tushare: tushare || sysMap.tushare_token || null,
  }
}

// ── tushare helpers ───────────────────────────────────────

async function tusharePost(token: string, apiName: string, params: Record<string, string>, fields: string) {
  const resp = await fetch('https://api.tushare.pro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token, params, fields }),
  })
  if (!resp.ok) return null
  return (await resp.json()) as { data?: { fields?: string[]; items?: unknown[][] } }
}

// ── data-source functions ─────────────────────────────────

async function fetchKlineTickFlow(code: string, apiKey: string, count = 250): Promise<KlineRow[]> {
  const symbol = normalizeTickFlowSymbol(code)
  const params = new URLSearchParams({ symbol, period: '1d', count: String(count), adjust: 'forward' })
  const resp = await fetch(`https://api.tickflow.org/v1/klines?${params}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (resp.ok) {
    const rows = parseTickFlowKline(await resp.json(), symbol)
    if (rows.length) return rows
  }
  // Batch fallback
  const bParams = new URLSearchParams({ symbols: symbol, period: '1d', count: String(count), adjust: 'forward' })
  const bResp = await fetch(`https://api.tickflow.org/v1/klines/batch?${bParams}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!bResp.ok) return []
  return parseTickFlowKline(await bResp.json(), symbol)
}

async function fetchKlineTushare(code: string, token: string, startDate: string, endDate: string): Promise<KlineRow[]> {
  const tsCode = normalizeTushareCode(code)
  const [dailyJson, adjJson] = await Promise.all([
    tusharePost(token, 'daily', { ts_code: tsCode, start_date: startDate, end_date: endDate }, 'trade_date,open,high,low,close,vol'),
    tusharePost(token, 'adj_factor', { ts_code: tsCode, start_date: startDate, end_date: endDate }, 'trade_date,adj_factor'),
  ])
  const items = dailyJson?.data?.items
  if (!Array.isArray(items) || items.length === 0) return []

  const adjItems = adjJson?.data?.items
  if (!Array.isArray(adjItems) || adjItems.length === 0) return []
  const adjMap = new Map<string, number>()
  let latestDate = ''
  for (const row of adjItems) {
    const dt = String(row[0])
    adjMap.set(dt, Number(row[1]))
    if (dt > latestDate) latestDate = dt
  }
  const latestFactor = adjMap.get(latestDate) || 1

  return items.map(row => {
    const dt = String(row[0] || '')
    const factor = adjMap.get(dt)
    if (!factor) return null
    const ratio = factor / latestFactor
    return {
      date: dt.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
      open: Number(row[1] || 0) * ratio, high: Number(row[2] || 0) * ratio,
      low: Number(row[3] || 0) * ratio, close: Number(row[4] || 0) * ratio,
      volume: Number(row[5] || 0),
    }
  }).filter((d): d is KlineRow => d !== null && d.date !== '' && d.close > 0)
}

async function fetchIndexTushare(token: string, code: string, startDate: string, endDate: string): Promise<KlineRow[]> {
  const json = await tusharePost(token, 'index_daily',
    { ts_code: code, start_date: startDate, end_date: endDate },
    'trade_date,open,high,low,close,vol,pct_chg')
  const items = json?.data?.items
  if (!Array.isArray(items) || items.length === 0) return []
  return items.map((row: unknown[]) => ({
    date: String(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
  })).reverse()
}

async function fetchLiveQuoteTickFlow(code: string, apiKey: string): Promise<{ close: number; pct: number } | null> {
  try {
    const params = new URLSearchParams({ symbol: code, period: '1d', count: '5', adjust: 'forward' })
    const resp = await fetch(`https://api.tickflow.org/v1/klines?${params}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!resp.ok) return null
    const rows = parseTickFlowKline(await resp.json(), code)
    if (rows.length < 2) return null
    const latest = rows[rows.length - 1]!
    const prev = rows[rows.length - 2]!
    return { close: latest.close, pct: prev.close > 0 ? ((latest.close - prev.close) / prev.close) * 100 : 0 }
  } catch { return null }
}

async function fetchQuotesTickFlow(symbols: string[], apiKey: string): Promise<Record<string, Record<string, number>>> {
  try {
    const joined = symbols.join(',')
    const resp = await fetch(`https://api.tickflow.org/v1/quotes?symbols=${joined}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!resp.ok) return {}
    const json = await resp.json() as { data?: Record<string, number>[] }
    const result: Record<string, Record<string, number>> = {}
    for (const row of (json.data || [])) {
      const sym = String((row as Record<string, unknown>).symbol || '')
      const code6 = sym.split('.')[0] || ''
      if (code6) result[code6] = row
    }
    return result
  } catch { return {} }
}

async function fetchIntradayTickFlow(symbol: string, apiKey: string, period: string, count: string): Promise<KlineRow[]> {
  const params = new URLSearchParams({ symbol, period, count })
  const resp = await fetch(`https://api.tickflow.org/v1/klines/intraday?${params}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!resp.ok) return []
  return parseTickFlowKline(await resp.json(), symbol)
}

async function fetchFundamentalsTickFlow(code: string, apiKey: string): Promise<Record<string, unknown> | null> {
  const symbol = normalizeTickFlowSymbol(code)
  const params = new URLSearchParams({ symbols: symbol, latest: 'true' })
  const resp = await fetch(`https://api.tickflow.org/v1/financials/metrics?${params}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!resp.ok) return null
  const json = await resp.json() as Record<string, unknown>

  // Find the financial record in the response
  const data = json.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    const direct = obj[symbol]
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const r = val as Record<string, unknown>
        if (r.end_date || r.eps || r.roe) return r
      }
    }
  }
  return null
}

async function fetchFundamentalsTushare(code: string, token: string): Promise<Record<string, unknown> | null> {
  const tsCode = normalizeTushareCode(code)
  const fields = 'ts_code,end_date,ann_date,eps,bps,cfps,roe,roe_dt,or_yoy,netprofit_yoy,grossprofit_margin,netprofit_margin,debt_to_assets,ocf_to_or,inv_turn'
  const json = await tusharePost(token, 'fina_indicator', { ts_code: tsCode }, fields)
  const items = json?.data?.items
  const fieldNames = json?.data?.fields
  if (!Array.isArray(items) || !Array.isArray(fieldNames) || items.length === 0) return null
  const row = items[0]!
  return Object.fromEntries(fieldNames.map((f: unknown, i: number) => [f, row[i]])) as Record<string, unknown>
}

// ── route ─────────────────────────────────────────────────

export const dataRoutes = new Hono<{ Bindings: Env }>()

dataRoutes.use('*', authMiddleware)

// ── GET /api/data/kline?symbol=xxx&days=250 ────────────────

dataRoutes.get('/kline', async (c) => {
  const symbol = c.req.query('symbol')?.trim()
  if (!symbol) return c.json({ error: 'missing symbol' }, 400)

  const days = Math.min(Math.max(parseInt(c.req.query('days') || '250', 10) || 250, 1), 500)
  const env = (c as any).env || {}
  const userId = c.get('auth').userId
  const keys = await resolveDataKeys(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, userId)

  const isCn = isCnSymbol(symbol)

  // TickFlow (primary)
  if (keys.tickflow) {
    try {
      const rows = await fetchKlineTickFlow(symbol, keys.tickflow, days)
      if (rows.length) return c.json({ source: 'tickflow', symbol, rows })
    } catch { /* fall through */ }
  }

  // tushare (CN-only)
  if (isCn && keys.tushare) {
    try {
      const end = new Date(); end.setDate(end.getDate() - 1)
      const start = new Date(); start.setDate(start.getDate() - days * 2)
      const rows = await fetchKlineTushare(symbol, keys.tushare, compactDate(start), compactDate(end))
      if (rows.length) {
        return c.json({ source: 'tushare', symbol, rows: rows.sort((a, b) => a.date.localeCompare(b.date)) })
      }
    } catch { /* fall through */ }
  }

  const hasTickflow = !!keys.tickflow; const hasTushare = !!keys.tushare
  const hint = !hasTickflow && !hasTushare
    ? '请先在设置页配置 TickFlow API Key 或 tushare Token'
    : `已配置${hasTickflow ? ' TickFlow' : ''}${hasTickflow && hasTushare ? ' +' : ''}${hasTushare ? ' tushare' : ''}，但K线获取失败`
  return c.json({ source: 'none', symbol, rows: [], error: hint }, 502)
})

// ── GET /api/data/index?code=000001.SH&days=100 ────────────

dataRoutes.get('/index', async (c) => {
  const code = c.req.query('code')?.trim()
  if (!code) return c.json({ error: 'missing code' }, 400)

  const days = Math.min(Math.max(parseInt(c.req.query('days') || '100', 10) || 100, 1), 250)
  const env = (c as any).env || {}
  const userId = c.get('auth').userId
  const keys = await resolveDataKeys(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, userId)

  // TickFlow (primary)
  if (keys.tickflow) {
    try {
      const rows = await fetchKlineTickFlow(code, keys.tickflow, days)
      if (rows.length) return c.json({ source: 'tickflow', code, rows })
    } catch { /* fall through */ }
  }

  // tushare index_daily
  if (keys.tushare) {
    try {
      const end = new Date()
      const start = new Date(); start.setDate(start.getDate() - days * 2 - 30)
      const tsCode = `${code.split('.')[0]}.${code.split('.')[1]}`
      const rows = await fetchIndexTushare(keys.tushare, tsCode, compactDate(start), compactDate(end))
      if (rows.length) return c.json({ source: 'tushare', code, rows })
    } catch { /* fall through */ }
  }

  const hasTickflow = !!keys.tickflow; const hasTushare = !!keys.tushare
  const hint = !hasTickflow && !hasTushare
    ? '请先在设置页配置 TickFlow API Key 或 tushare Token'
    : `已配置${hasTickflow ? ' TickFlow' : ''}${hasTickflow && hasTushare ? ' +' : ''}${hasTushare ? ' tushare' : ''}，但指数K线获取失败`
  return c.json({ source: 'none', code, rows: [], error: hint }, 502)
})

// ── GET /api/data/value?symbol=xxx ─────────────────────────

dataRoutes.get('/value', async (c) => {
  const symbol = c.req.query('symbol')?.trim()
  if (!symbol) return c.json({ error: 'missing symbol' }, 400)

  if (!isCnSymbol(symbol)) {
    return c.json({ symbol, source: 'none', metrics: null, reason: 'unsupported-market' } satisfies ValueSnapshot)
  }

  const env = (c as any).env || {}
  const userId = c.get('auth').userId
  const keys = await resolveDataKeys(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, userId)

  if (!keys.tickflow && !keys.tushare) {
    return c.json({ symbol, source: 'none', metrics: null, reason: 'missing-source' } satisfies ValueSnapshot)
  }

  if (keys.tickflow) {
    try {
      const metrics = await fetchFundamentalsTickFlow(symbol, keys.tickflow)
      if (metrics) return c.json({ symbol, source: 'tickflow', metrics })
    } catch { /* fall through */ }
  }

  if (keys.tushare) {
    try {
      const metrics = await fetchFundamentalsTushare(symbol, keys.tushare)
      if (metrics) return c.json({ symbol, source: 'tushare', metrics })
    } catch { /* fall through */ }
  }

  return c.json({ symbol, source: 'none', metrics: null, reason: 'not-found' } satisfies ValueSnapshot)
})

// ── GET /api/data/index-live ───────────────────────────────

dataRoutes.get('/index-live', async (c) => {
  const env = (c as any).env || {}
  const userId = c.get('auth').userId
  const keys = await resolveDataKeys(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, userId)

  if (!keys.tickflow) {
    return c.json({ error: '未配置 TickFlow API Key，无法获取实时行情。请在设置中配置。', quotes: [] }, 502)
  }

  const indices = [
    { code: '000001.SH', label: '上证指数' },
    { code: '399001.SZ', label: '深证成指' },
    { code: '399006.SZ', label: '创业板指' },
    { code: '000688.SH', label: '科创50' },
  ]

  const quotes: IndexQuote[] = []
  for (const idx of indices) {
    const q = await fetchLiveQuoteTickFlow(idx.code, keys.tickflow)
    if (q) quotes.push({ code: idx.code, label: idx.label, ...q })
  }

  return c.json({ quotes })
})

// ── GET /api/data/intraday?symbol=xxx ──────────────────────

dataRoutes.get('/intraday', async (c) => {
  const symbol = c.req.query('symbol')?.trim()
  if (!symbol) return c.json({ error: 'missing symbol' }, 400)

  const env = (c as any).env || {}
  const userId = c.get('auth').userId
  const keys = await resolveDataKeys(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, userId)

  if (!keys.tickflow) {
    return c.json({ error: '未配置 TickFlow API Key，无法获取分钟线数据。请在设置中配置。', periods: {} }, 502)
  }

  const tfSymbol = normalizeTickFlowSymbol(symbol)
  const periods = ['1m', '5m', '15m'] as const
  const result: Record<string, KlineRow[]> = {}

  await Promise.all(periods.map(async (period) => {
    const count = period === '1m' ? '500' : '100'
    try {
      result[period] = await fetchIntradayTickFlow(tfSymbol, keys.tickflow, period, count)
    } catch { result[period] = [] }
  }))

  return c.json({ symbol: tfSymbol, periods: result })
})

// ── GET /api/data/quotes?symbols=xxx,yyy ───────────────────

dataRoutes.get('/quotes', async (c) => {
  const raw = c.req.query('symbols')?.trim()
  if (!raw) return c.json({ quotes: {} })

  const env = (c as any).env || {}
  const userId = c.get('auth').userId
  const keys = await resolveDataKeys(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, userId)

  if (!keys.tickflow) return c.json({ quotes: {} })

  const symbols = raw.split(',').map(s => s.trim()).filter(Boolean)
  const quotes = await fetchQuotesTickFlow(symbols, keys.tickflow)
  return c.json({ quotes })
})

// ── GET /api/data/signal-quality ───────────────────────────

dataRoutes.get('/signal-quality', async (c) => {
  try {
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      'from tools.signal_quality import generate_signal_quality_report; print(generate_signal_quality_report())',
    ], {
      timeout: 15_000,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) {
      return c.json({ error: `signal_quality: ${proc.error.message}`, report: '' })
    }
    return c.json({ report: proc.stdout?.trim() || '', error: proc.stderr?.trim() || undefined })
  } catch (err: any) {
    return c.json({ error: `signal_quality: ${err.message}`, report: '' })
  }
})

// ── GET /api/data/signal-quality-stats ─────────────────────

dataRoutes.get('/signal-quality-stats', async (c) => {
  try {
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      'from tools.signal_quality import get_signal_quality_json; import json; print(json.dumps(get_signal_quality_json(), ensure_ascii=False))',
    ], {
      timeout: 15_000,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) {
      return c.json({ error: `signal_quality_stats: ${proc.error.message}` })
    }
    return c.json(JSON.parse(proc.stdout?.trim() || '{}'))
  } catch (err: any) {
    return c.json({ error: `signal_quality_stats: ${err.message}` })
  }
})

// ── GET /api/data/headless-analysis?code=600519 ─────────────

dataRoutes.get('/headless-analysis', async (c) => {
  try {
    const code = (c.req.query('code') || '').trim()
    if (!code) return c.json({ error: 'code required' }, 400)

    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      'tools/headless_analysis.py', code,
    ], {
      timeout: 30_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ error: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ error: 'parse error', raw: proc.stdout?.slice(0, 200) }, 500)
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── GET /api/data/signal-observations?status=active&limit=50&offset=0 ──

dataRoutes.get('/signal-observations', async (c) => {
  try {
    const status = c.req.query('status') || 'all'
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200)
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0)
    const env = (c as any).env || {}
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

    let query = supabase
      .from('signal_observations')
      .select('*', { count: 'exact' })
      .order('trade_date', { ascending: false })
      .order('trigger_score', { ascending: false })

    if (status !== 'all') {
      query = query.eq('lifecycle_status', status.toUpperCase())
    }

    const { data, count, error } = await query.range(offset, offset + limit - 1)
    if (error) return c.json({ error: error.message, observations: [], total: 0 })

    return c.json({ observations: data || [], total: count || 0 })
  } catch (err: any) {
    return c.json({ error: `signal_observations: ${err.message}`, observations: [], total: 0 })
  }
})

// ── 预警规则 API ───────────────────────────────────────────

dataRoutes.get('/alerts', async (c) => {
  try {
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      'from tools.alert_engine import list_rules; import json; print(json.dumps(list_rules(), ensure_ascii=False))',
    ], {
      timeout: 10_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ error: `alerts: ${proc.error.message}`, rules: [] })
    let rules: unknown[] = []
    try { rules = JSON.parse(proc.stdout?.trim() || '[]') } catch { /* empty */ }
    return c.json({ rules, error: proc.stderr?.trim() || undefined })
  } catch (err: any) {
    return c.json({ error: `alerts: ${err.message}`, rules: [] })
  }
})

dataRoutes.post('/alerts/save', async (c) => {
  try {
    const body = await c.req.json<{ rule: Record<string, unknown> }>()
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from tools.alert_engine import add_rule; import json; print(json.dumps(add_rule(${JSON.stringify(body.rule)})))`,
    ], {
      timeout: 10_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ ok: false, message: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ ok: false, message: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ ok: false, message: err.message }, 500)
  }
})

dataRoutes.delete('/alerts/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from tools.alert_engine import delete_rule; import json; print(json.dumps(delete_rule("${id.replace(/"/g, '\\"')}")))`,
    ], {
      timeout: 10_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ ok: false, message: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ ok: false, message: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ ok: false, message: err.message }, 500)
  }
})

dataRoutes.post('/alerts/run', async (c) => {
  try {
    const body = await c.req.json<{ dry_run?: boolean }>()
    const dryRun = body.dry_run === true
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from tools.alert_engine import run_engine; import json; print(json.dumps(run_engine(dry_run=${dryRun ? 'True' : 'False'})))`,
    ], {
      timeout: 30_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ ok: false, message: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ ok: false, message: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ ok: false, message: err.message }, 500)
  }
})

// ── POST /api/data/portfolio-risk ────────────────────────

dataRoutes.post('/portfolio-risk', async (c) => {
  try {
    const body = await c.req.json<{ positions: Array<Record<string, unknown>>; lookback_days?: number }>()
    const positions = body.positions
    if (!Array.isArray(positions) || positions.length === 0) {
      return c.json({ error: '请提供持仓列表 positions' }, 400)
    }
    const lookback = Math.min(Math.max(body.lookback_days || 252, 60), 1000)
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from tools.portfolio_risk import generate_risk_report; import json; print(json.dumps(generate_risk_report(json.loads('''${JSON.stringify(positions)}'''), ${lookback}), ensure_ascii=False, default=str))`,
    ], {
      timeout: 60_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ error: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ error: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── POST /api/data/parameter-tuning ──────────────────────

dataRoutes.post('/parameter-tuning', async (c) => {
  try {
    const body = await c.req.json<{ bench_code?: string; smallcap_code?: string; lookback_days?: number }>()
    const benchCode = body.bench_code || '000001'
    const smallcapCode = body.smallcap_code || '399006'
    const lookback = Math.min(Math.max(body.lookback_days || 252, 60), 1000)
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from tools.parameter_tuner import fetch_and_tune; import json; print(json.dumps(fetch_and_tune('${benchCode}', '${smallcapCode}', ${lookback}), ensure_ascii=False, default=str))`,
    ], {
      timeout: 60_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ error: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ error: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── POST /api/data/walk-forward ─────────────────────────

dataRoutes.post('/walk-forward', async (c) => {
  try {
    const body = await c.req.json<{ trades: Array<Record<string, unknown>>; param_grid?: Record<string, number[]>; train_months?: number; test_months?: number; step_months?: number }>()
    const trades = body.trades
    if (!Array.isArray(trades) || trades.length < 10) {
      return c.json({ error: '请提供至少 10 笔交易记录 trades=[{signal_date, ret_pct, score}, ...]' }, 400)
    }
    const paramGrid = body.param_grid || { min_score: [0.1, 0.15, 0.2, 0.25] }
    const trainMonths = body.train_months || 12
    const testMonths = body.test_months || 3
    const stepMonths = body.step_months || 3
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from tools.walk_forward_optimizer import run_walk_forward; import json, sys; trades=json.loads(sys.stdin.read()); print(json.dumps(run_walk_forward(pd.DataFrame(trades), ${JSON.stringify(paramGrid)}, date.today()-timedelta(days=365*2), date.today(), ${trainMonths}, ${testMonths}, ${stepMonths}), ensure_ascii=False, default=str))`,
    ], {
      timeout: 30_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
      input: JSON.stringify(trades),
    })
    if (proc.error) return c.json({ error: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ error: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── POST /api/data/monte-carlo ──────────────────────────

dataRoutes.post('/monte-carlo', async (c) => {
  try {
    const body = await c.req.json<{ returns: number[]; n_simulations?: number; n_trades?: number; initial_capital?: number }>()
    const returns = body.returns
    if (!Array.isArray(returns) || returns.length < 5) {
      return c.json({ error: '请提供至少 5 笔收益率 returns=[5.2, -3.1, 8.7, ...]' }, 400)
    }
    const nSim = Math.min(Math.max(body.n_simulations || 5000, 100), 50000)
    const nTrades = Math.min(Math.max(body.n_trades || 100, 10), 10000)
    const initCap = body.initial_capital || 100000
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from tools.monte_carlo_simulator import run_monte_carlo; import json; print(json.dumps(run_monte_carlo(${JSON.stringify(returns)}, ${nSim}, ${nTrades}, ${initCap}), ensure_ascii=False, default=str))`,
    ], {
      timeout: 30_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ error: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ error: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── POST /api/data/benchmark-exit-strategies ──────────────

dataRoutes.post('/benchmark-exit-strategies', async (c) => {
  try {
    const body = await c.req.json<{ ohlc_data: Record<string, Record<string, [number,number,number,number]>>; sorted_dates: Record<string, string[]>; trades: Array<Record<string, unknown>>; strategies?: string[]; extra_params?: Record<string, Record<string, unknown>> }>()
    const { ohlc_data, sorted_dates, trades } = body
    if (!ohlc_data || !sorted_dates || !Array.isArray(trades) || trades.length === 0) {
      return c.json({ error: '请提供 ohlc_data, sorted_dates, trades' }, 400)
    }
    const strategies = body.strategies || null
    const extraParams = body.extra_params || null
    const { spawnSync } = await import('node:child_process')
    const script = `
from tools.exit_strategies import benchmark_exit_strategies
import json, sys
from datetime import date

# 反序列化 date-keyed dicts
def parse_ohlc(raw):
    result = {}
    for code, d in raw.items():
        result[code] = {date.fromisoformat(k): tuple(v) for k, v in d.items()}
    return result

def parse_sdates(raw):
    return {k: [date.fromisoformat(x) for x in v] for k, v in raw.items()}

def parse_trades(raw):
    for t in raw:
        if 'entry_date' in t and isinstance(t['entry_date'], str):
            t['entry_date'] = date.fromisoformat(t['entry_date'])
    return raw

ohlc = parse_ohlc(json.loads('''${JSON.stringify(ohlc_data).replace(/'/g, "\\'")}'''))
sd = parse_sdates(json.loads('''${JSON.stringify(sorted_dates).replace(/'/g, "\\'")}'''))
trades = parse_trades(json.loads('''${JSON.stringify(trades).replace(/'/g, "\\'")}'''))
result = benchmark_exit_strategies(ohlc, sd, trades, ${strategies ? JSON.stringify(strategies) : 'None'}, ${extraParams ? JSON.stringify(extraParams) : 'None'})
print(json.dumps(result, ensure_ascii=False, default=str))
`.strip()
    const proc = spawnSync('python3', ['-c', script], {
      timeout: 60_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if ((proc as any).error) return c.json({ error: (proc as any).error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ error: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── POST /api/data/analyze-exit-quality ────────────────────

dataRoutes.post('/analyze-exit-quality', async (c) => {
  try {
    const body = await c.req.json<{ exits: Array<Record<string, unknown>> }>()
    const exits = body.exits
    if (!Array.isArray(exits) || exits.length === 0) {
      return c.json({ error: '请提供出场记录 exits=[{exit_price, entry_price, peak_high, ...}]' }, 400)
    }
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from tools.exit_strategies import analyze_exit_quality; import json; print(json.dumps(analyze_exit_quality(${JSON.stringify(exits)}), ensure_ascii=False))`,
    ], {
      timeout: 15_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ error: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ error: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ═══ POST /api/data/data-source-health ═══════════════════

dataRoutes.get('/data-source-health', async (c) => {
  try {
    const { spawnSync } = await import('node:child_process')
    const proc = spawnSync('python3', [
      '-c',
      `from integrations.data_source import get_data_source_health; import json; print(json.dumps(get_data_source_health(), ensure_ascii=False))`,
    ], {
      timeout: 10_000, encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH || process.cwd() },
      cwd: process.cwd(),
    })
    if (proc.error) return c.json({ error: proc.error.message }, 500)
    try { return c.json(JSON.parse(proc.stdout?.trim() || '{}')) } catch {
      return c.json({ error: 'parse error' }, 500)
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})
