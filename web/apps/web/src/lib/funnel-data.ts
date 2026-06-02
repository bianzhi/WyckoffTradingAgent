/**
 * Phase 1.3 — 漏斗数据获取
 *
 * 从 Supabase recommendation_tracking 表统计：
 * - 各层通过率
 * - 行业分布
 * - L4 触发类型分布
 */

import { supabase } from './supabase'

export interface FunnelLayerStats {
  layer: string
  label: string
  count: number
  total: number
  passRate: number
}

export interface SectorStat {
  sector: string
  count: number
  pct: number
}

export interface TriggerStat {
  trigger: string
  label: string
  count: number
  pct: number
}

export interface FunnelSummary {
  date: string
  layers: FunnelLayerStats[]
  sectors: SectorStat[]
  triggers: TriggerStat[]
  totalScanned: number
  aiCount: number
}

// ── Phase 4.0: 漏斗完整结果类型 ──────────────────────────────────────────────

export interface FunnelStockResult {
  code: string
  name: string
  channel: string          // L2 通道标签
  score: number            // 综合评分
  signals: string[]        // L4 触发信号列表
  stage: string            // 威科夫阶段
  latest_close: number | null
  exit_signal: string      // 退出信号（空=正常）
}

export interface FunnelLayerCondition {
  label: string
  desc: string
  passed: number
  detail?: Record<string, number>  // 各通道/信号细分统计
}

export interface FunnelFullResult {
  ok: boolean
  error?: string
  elapsed_s: number
  total_scanned: number
  total_input: number
  trigger_hits: number
  hit_codes: number
  triggers: Record<string, number>
  stocks: FunnelStockResult[]
  layer_conditions: Record<string, FunnelLayerCondition>
  top_sectors: string[]
  date: string
  persisted?: boolean
  persisted_count?: number
}

const TRIGGER_KEYWORDS: Record<string, string> = {
  '点火破局': 'sos_bypass',
  '吸筹通道': 'accum',
  '主升通道': 'trend',
  '潜伏通道': 'stealth',
  '趋势延续': 'trend_cont',
  '价值通道': 'value',
}

const SECTOR_MAP: Record<string, string> = {
  '银行': '金融', '券商': '金融', '保险': '金融', '金融': '金融',
  '医药': '医药', '医疗': '医药', '生物': '医药',
  '白酒': '消费', '食品': '消费', '饮料': '消费', '家电': '消费', '消费': '消费',
  '半导体': '科技', '芯片': '科技', '计算机': '科技', '软件': '科技', '通信': '科技',
  '电子': '科技', '5g': '科技', 'ai': '科技', '人工智能': '科技',
  '新能源': '新能源', '光伏': '新能源', '锂电': '新能源', '风电': '新能源', '储能': '新能源',
  '汽车': '汽车', '零部件': '汽车',
  '地产': '地产', '建材': '基建', '建筑': '基建', '基建': '基建',
  '有色': '周期', '煤炭': '周期', '钢铁': '周期', '化工': '周期', '石油': '周期', '航运': '周期',
  '军工': '军工',
  '农业': '农业', '牧业': '农业',
}

function guessSector(name: string): string {
  const n = name.toLowerCase().replace(/\s/g, '')
  for (const [keyword, sector] of Object.entries(SECTOR_MAP)) {
    if (n.includes(keyword)) return sector
  }
  // Try to get real sector from name prefix
  const first2 = name.slice(0, 2)
  for (const [keyword, sector] of Object.entries(SECTOR_MAP)) {
    if (first2.includes(keyword)) return sector
  }
  return '其他'
}

async function fetchRecommendations(date?: string) {
  let query = supabase
    .from('recommendation_tracking')
    .select('code, name, recommend_date, funnel_score, recommend_reason, is_ai_recommended')
    .order('recommend_date', { ascending: false })
    .limit(500)

  if (date) {
    query = query.eq('recommend_date', date)
  }

  const { data } = await query
  return (data || []) as Array<{
    code: number
    name: string
    recommend_date: string
    funnel_score: number | null
    recommend_reason: string | null
    is_ai_recommended: boolean
  }>
}

export async function fetchFunnelSummary(date?: string): Promise<FunnelSummary | null> {
  const rows = await fetchRecommendations(date)
  if (rows.length === 0) return null

  // Find latest date
  const dateCounts = new Map<string, number>()
  for (const r of rows) {
    dateCounts.set(r.recommend_date, (dateCounts.get(r.recommend_date) || 0) + 1)
  }
  const latestDate = [...dateCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''

  // Filter to latest date
  const latest = rows.filter(r => r.recommend_date === latestDate)
  const aiSelected = latest.filter(r => r.is_ai_recommended)

  // Layer stats (estimated from scores)
  const total = latest.length
  const layerBreakdown = {
    L1: latest.length, // all in latest date passed L1
    L2: latest.filter(r => (r.funnel_score ?? 0) >= 5).length,
    L3: latest.filter(r => (r.funnel_score ?? 0) >= 10).length,
    L4: aiSelected.length,
  }

  const layers: FunnelLayerStats[] = [
    { layer: 'L1', label: '初筛', count: layerBreakdown.L1, total, passRate: 100 },
    { layer: 'L2', label: '通道甄别', count: layerBreakdown.L2, total, passRate: safePct(layerBreakdown.L2, total) },
    { layer: 'L3', label: '深度评分', count: layerBreakdown.L3, total, passRate: safePct(layerBreakdown.L3, total) },
    { layer: 'L4', label: 'AI 精选', count: layerBreakdown.L4, total, passRate: safePct(layerBreakdown.L4, total) },
  ]

  const { sectors, triggers } = computeSectorsAndTriggers(aiSelected)

  return {
    date: latestDate,
    layers,
    sectors,
    triggers,
    totalScanned: total,
    aiCount: aiSelected.length,
  }
}

function computeSectorsAndTriggers(aiSelected: Array<{ name: string; recommend_reason: string | null }>): {
  sectors: SectorStat[]
  triggers: TriggerStat[]
} {
  // Sector stats
  const sectorCounts = new Map<string, number>()
  for (const r of aiSelected) {
    const sector = guessSector(r.name)
    sectorCounts.set(sector, (sectorCounts.get(sector) || 0) + 1)
  }
  const sectors: SectorStat[] = [...sectorCounts.entries()]
    .map(([sector, count]) => ({ sector, count, pct: safePct(count, aiSelected.length) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)

  // Trigger stats
  const triggerCounts = new Map<string, number>()
  for (const r of aiSelected) {
    const reason = (r.recommend_reason || '').toLowerCase()
    let matched = false
    for (const [keyword, key] of Object.entries(TRIGGER_KEYWORDS)) {
      if (reason.includes(keyword)) {
        triggerCounts.set(key, (triggerCounts.get(key) || 0) + 1)
        matched = true
        break
      }
    }
    if (!matched) {
      triggerCounts.set('other', (triggerCounts.get('other') || 0) + 1)
    }
  }
  const triggerLabels: Record<string, string> = {
    sos_bypass: '点火破局', accum: '吸筹通道', trend: '主升通道',
    stealth: '潜伏通道', trend_cont: '趋势延续', value: '价值通道', other: '其他',
  }
  const triggers: TriggerStat[] = [...triggerCounts.entries()]
    .map(([trigger, count]) => ({ trigger, label: triggerLabels[trigger] || trigger, count, pct: safePct(count, aiSelected.length) }))
    .sort((a, b) => b.count - a.count)

  return { sectors, triggers }
}

export async function fetchFunnelDates(): Promise<string[]> {
  const { data } = await supabase
    .from('recommendation_tracking')
    .select('recommend_date')
    .order('recommend_date', { ascending: false })
    .limit(30)

  if (!data) return []
  const seen = new Set<string>()
  const dates: string[] = []
  for (const r of data) {
    const d = String(r.recommend_date)
    if (d && !seen.has(d)) { seen.add(d); dates.push(d) }
  }
  return dates
}

// ── Phase 2.4: 信号质量 stats ──────────────────────────────────────────────

export interface SignalQualityEntry {
  signal_type: string
  track: string
  status: string
  health_state: string | null
  sample_count: number
  win_rate_pct: number | null
  avg_return_pct: number | null
  weight_multiplier: number
}

export interface TrackBreakdown {
  count: number
  win_rate_pct: number
  avg_return_pct: number
}

export interface SignalQualityStats {
  registry: SignalQualityEntry[]
  track_breakdown: Record<string, TrackBreakdown>
  summary: {
    total_signals: number
    healthy: number
    decayed: number
  }
}

export async function fetchSignalQualityStats(): Promise<SignalQualityStats> {
  const { supabase } = await import('./supabase')
  const { data: { session } } = await supabase.auth.getSession()
  const headers: Record<string, string> = {}
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
  const resp = await fetch('/api/data/signal-quality-stats', { headers })
  if (!resp.ok) throw new Error(`signal-quality-stats: ${resp.status}`)
  return resp.json()
}

function safePct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 1000) / 10 : 0
}

// ── Agent 连通性检查 ──────────────────────────────────────────────────────

export interface AgentHealth {
  reachable: boolean
  error?: string
  detail?: string
  agent_url?: string
}

export async function fetchAgentHealth(): Promise<AgentHealth> {
  try {
    const { supabase: s } = await import('./supabase')
    const { data: { session } } = await s.auth.getSession()
    const headers: Record<string, string> = {}
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/funnel/agent-health', { headers })
    if (!resp.ok) return { reachable: false, error: `API ${resp.status}` }
    return resp.json()
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : '网络错误' }
  }
}

// ── Phase 4.0: 漏斗完整结果 & 报告下载 ─────────────────────────────────────

export async function fetchFunnelResult(): Promise<FunnelFullResult | null> {
  try {
    const { supabase: s } = await import('./supabase')
    const { data: { session } } = await s.auth.getSession()
    const headers: Record<string, string> = {}
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/funnel/result', { headers })
    if (!resp.ok) return null
    return resp.json()
  } catch { return null }
}

export async function downloadFunnelReport(): Promise<void> {
  try {
    const { supabase: s } = await import('./supabase')
    const { data: { session } } = await s.auth.getSession()
    const headers: Record<string, string> = {}
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
    const resp = await fetch('/api/funnel/report', { headers })
    if (!resp.ok) throw new Error(`Report: ${resp.status}`)
    const html = await resp.text()
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `funnel-report-${new Date().toISOString().slice(0, 10)}.html`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    console.error('downloadFunnelReport:', e)
  }
}
