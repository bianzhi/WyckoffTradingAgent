/**
 * Phase 1.3 — 漏斗结果可视化页面
 *
 * 展示：漏斗各层通过率柱状图 + 板块热力图 + L4 触发分布
 * 支持一键发起全市场漏斗筛选
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createChart, HistogramSeries, type HistogramData, type Time } from 'lightweight-charts'
import { fetchFunnelSummary, fetchFunnelDates, fetchFunnelResult, fetchSignalQualityStats, downloadFunnelReport, fetchAgentHealth, type FunnelSummary, type SectorStat, type TriggerStat, type FunnelStockResult, type FunnelLayerCondition } from '@/lib/funnel-data'
import { SkeletonChart, SkeletonCard } from '@/components/ux/skeleton'
import { Breadcrumb } from '@/components/ux/breadcrumb'
import { ScrollToTop } from '@/components/ux/scroll-top'
import { relativeTime } from '@/lib/relative-time'
import { useDocTitle } from '@/lib/doc-title'
import { usePreferences } from '@/lib/preferences'

type FunnelState = 'idle' | 'running' | 'completed' | 'error'
type FunnelProgressState = { stage: string; detail: string; progress: number }
type FunnelProgressLog = { ts?: string; stage: string; detail: string; progress?: number }

const SECTOR_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#06b6d4',
  '#2563eb', '#7c3aed', '#ec4899', '#e11d48', '#8b5cf6', '#14b8a6',
]

const TRIGGER_COLORS: Record<string, string> = {
  sos_bypass: '#ef4444',
  accum: '#f97316',
  trend: '#22c55e',
  stealth: '#7c3aed',
  trend_cont: '#2563eb',
  value: '#06b6d4',
  other: '#6b7280',
}

export function FunnelPage() {
  const { locale } = usePreferences()
  const [selectedDate, setSelectedDate] = useState<string>('')
  const [funnelState, setFunnelState] = useState<FunnelState>('idle')
  const [funnelError, setFunnelError] = useState('')
  const [funnelRunning, setFunnelRunning] = useState(false)
  const [funnelProgress, setFunnelProgress] = useState<FunnelProgressState>({ stage: '', detail: '', progress: -1 })
  const [funnelLogs, setFunnelLogs] = useState<FunnelProgressLog[]>([])
  const [showAiOnly, setShowAiOnly] = useState(false)
  const stocksRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  // ── 页面加载时检查是否有正在运行的漏斗 ──────────────────────
  useEffect(() => {
    let stopped = false
    const check = async () => {
      try {
        const { supabase } = await import('@/lib/supabase')
        const { data: { session } } = await supabase.auth.getSession()
        const headers: Record<string, string> = {}
        if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
        const resp = await fetch('/api/funnel/status', { headers })
        const body = await resp.json() as Record<string, unknown>
        if (stopped) return
        if (body.status === 'running') {
          setFunnelState('running')
          setFunnelRunning(true)
          setFunnelProgress({
            stage: String(body.current_stage || ''),
            detail: String(body.current_detail || ''),
            progress: Number(body.current_progress ?? -1),
          })
          setFunnelLogs(normalizeProgressLogs(body.progress_logs))
        }
      } catch { /* agent maybe down, ignore */ }
    }
    check()
    return () => { stopped = true }
  }, [])

  // ── 后台轮询：探测读盘室等其他入口触发的漏斗 ──────────────
  useEffect(() => {
    if (funnelRunning) return // 已进入运行态，由主轮询接管
    let stopped = false

    const probe = async () => {
      if (stopped) return
      try {
        const { supabase } = await import('@/lib/supabase')
        const { data: { session } } = await supabase.auth.getSession()
        const headers: Record<string, string> = {}
        if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
        const resp = await fetch('/api/funnel/status', { headers })
        const status = await resp.json() as Record<string, unknown>
        if (stopped) return
        if (status.status === 'running') {
          setFunnelState('running')
          setFunnelRunning(true)
          setFunnelProgress({
            stage: String(status.current_stage || ''),
            detail: String(status.current_detail || ''),
            progress: Number(status.current_progress ?? -1),
          })
          setFunnelLogs(normalizeProgressLogs(status.progress_logs))
          return // 进入运行态后停止此轮询，由主轮询接管
        }
      } catch { /* agent down, ignore */ }
      if (!stopped) setTimeout(probe, 5000)
    }

    probe()
    return () => { stopped = true }
  }, [funnelRunning])

  const { data: dates, refetch: refetchDates } = useQuery({
    queryKey: ['funnel-dates'],
    queryFn: fetchFunnelDates,
    staleTime: 300_000,
  })

  const { data: summary, isLoading, refetch: refetchSummary } = useQuery({
    queryKey: ['funnel-summary', selectedDate],
    queryFn: () => fetchFunnelSummary(selectedDate || undefined),
    staleTime: 300_000,
  })

  // ── 漏斗完整结果（Agent API，含真实层级条件+个股详情） ──────────────
  const { data: funnelResult } = useQuery({
    queryKey: ['funnel-result'],
    queryFn: fetchFunnelResult,
    staleTime: 300_000,
    retry: 1,
  })

  const { data: agentHealth } = useQuery({
    queryKey: ['agent-health'],
    queryFn: fetchAgentHealth,
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: 1,
  })

  useEffect(() => {
    if (dates && dates.length > 0 && !selectedDate) {
      setSelectedDate(dates[0]!)
    }
  }, [dates, selectedDate])

  // ── 漏斗状态轮询 ──────────────────────────────────────────
  useEffect(() => {
    if (!funnelRunning) return
    let stopped = false

    const poll = async () => {
      try {
        const { supabase } = await import('@/lib/supabase')
        const { data: { session } } = await supabase.auth.getSession()
        const headers: Record<string, string> = {}
        if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
        const resp = await fetch('/api/funnel/status', { headers })
        const body = await resp.json() as Record<string, unknown>
        if (stopped) return

        const status = String(body.status || 'idle')
        if (status === 'running') {
          setFunnelState('running')
          setFunnelProgress({
            stage: String(body.current_stage || ''),
            detail: String(body.current_detail || ''),
            progress: Number(body.current_progress ?? -1),
          })
          setFunnelLogs(normalizeProgressLogs(body.progress_logs))
          setTimeout(poll, 2000)
        } else {
          setFunnelRunning(false)
          setFunnelLogs(normalizeProgressLogs(body.progress_logs))
          if (body.last_result && (body.last_result as Record<string, unknown>).ok) {
            setFunnelState('completed')
            // 刷新数据
            const freshDates = (await refetchDates()).data
            if (freshDates && freshDates.length > 0) {
              setSelectedDate(freshDates[0]!)
            }
            await refetchSummary()
            queryClient.invalidateQueries({ queryKey: ['funnel-summary'] })
            queryClient.invalidateQueries({ queryKey: ['funnel-dates'] })
            queryClient.invalidateQueries({ queryKey: ['funnel-result'] })
          } else if (body.last_result) {
            const lr = body.last_result as Record<string, unknown>
            setFunnelState('error')
            setFunnelError(String(lr.error || '未知错误'))
          } else {
            setFunnelState('idle')
          }
        }
      } catch {
        if (!stopped) {
          setFunnelRunning(false)
          setFunnelState('error')
          setFunnelError('无法连接漏斗服务')
        }
      }
    }

    poll()
    return () => { stopped = true }
  }, [funnelRunning, refetchDates, refetchSummary, queryClient])

  // ── 触发漏斗 ─────────────────────────────────────────────
  const triggerFunnel = async () => {
    setFunnelState('running')
    setFunnelRunning(true)
    setFunnelError('')
    setFunnelLogs([{ ts: currentClockTime(), stage: isZh ? '启动漏斗' : 'Starting funnel', detail: isZh ? '优先本地缓存，缺失时自动拉取' : 'Cache-first, fetching missing data as needed', progress: 0.02 }])
    try {
      const { supabase } = await import('@/lib/supabase')
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = {}
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      headers['Content-Type'] = 'application/json'
      const resp = await fetch('/api/funnel/trigger', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kline_cache_mode: 'cache_first' }),
      })
      const text = await resp.text()
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(text) } catch { /* non-JSON response */ }
      if (!resp.ok || !body.ok) {
        setFunnelRunning(false)
        setFunnelState('error')
        const err = (body.error as string) || (body.message as string) || (resp.status === 502 ? '后端服务暂不可用 (502)' : `请求失败 (${resp.status})`)
        setFunnelError(String(err))
        return
      }
    } catch (e) {
      setFunnelRunning(false)
      setFunnelState('error')
      setFunnelError(e instanceof Error ? e.message : '网络错误')
    }
  }

  // ── 停止漏斗 ─────────────────────────────────────────────
  const stopFunnel = async () => {
    try {
      const { supabase } = await import('@/lib/supabase')
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = {}
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      await fetch('/api/funnel/stop', { method: 'POST', headers })
    } catch { /* best-effort */ }
  }

  const isZh = locale === 'zh-CN'
  useDocTitle(isZh ? '威科夫漏斗 - Wyckoff' : 'Wyckoff Funnel - Wyckoff')

  const scrollToAiStocks = () => {
    setShowAiOnly(true)
    setTimeout(() => stocksRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  if (isLoading) return <FunnelPageSkeleton />
  if (!summary) {
    const agentOnline = agentHealth?.reachable
    return (
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <AgentStatusBar agentHealth={agentHealth} isZh={isZh} />
        <div className="flex flex-col items-center justify-center gap-4 py-16">
          <div className="text-3xl">📡</div>
          <div className="text-lg font-semibold">
            {isZh ? '暂无漏斗数据' : 'No funnel data yet'}
          </div>
          <p className="text-sm text-muted-foreground">
            {agentOnline
              ? (isZh ? '点击下方按钮启动全市场漏斗筛选' : 'Click the button below to start a funnel screening')
              : (isZh ? 'Agent 服务不可用，请检查服务状态' : 'Agent is unreachable — check service status')}
          </p>
          {!agentOnline && agentHealth?.detail && (
            <p className="max-w-md text-xs text-muted-foreground text-center">{agentHealth.detail}</p>
          )}
          <FunnelTriggerButton
            isZh={isZh}
            funnelState={funnelState}
            funnelError={funnelError}
            funnelProgress={funnelProgress}
            funnelLogs={funnelLogs}
            onTrigger={triggerFunnel}
            onStop={stopFunnel}
            agentOnline={agentOnline}
          />
        </div>
        <FunnelRunPanel isZh={isZh} funnelState={funnelState} logs={funnelLogs} error={funnelError} />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <Breadcrumb items={[{ label: isZh ? '首页' : 'Home', href: '/' }, { label: isZh ? '威科夫漏斗' : 'Wyckoff Funnel' }]} />
      <FunnelHeader
        isZh={isZh}
        summary={summary}
        dates={dates}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        funnelState={funnelState}
        funnelError={funnelError}
        funnelProgress={funnelProgress}
        funnelLogs={funnelLogs}
        onTriggerFunnel={triggerFunnel}
        onStopFunnel={stopFunnel}
        agentHealth={agentHealth}
        onAiCountClick={scrollToAiStocks}
      />
      <FunnelRunPanel isZh={isZh} funnelState={funnelState} logs={funnelLogs} error={funnelError} />

      {/* Layer pass rate chart + 层级条件手风琴 */}
      {funnelResult?.ok && funnelResult.layer_conditions ? (
        <FunnelLayerConditions isZh={isZh} layers={funnelResult.layer_conditions} />
      ) : (
        <section className="rounded-xl border border-border bg-card/50 p-4">
          <h2 className="mb-3 text-sm font-semibold">{isZh ? '各层通过率' : 'Layer Pass Rates'}</h2>
          <FunnelLayersChart layers={summary.layers} dataDate={summary.date} />
        </section>
      )}

      {/* Sector heatmap + Trigger distribution */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-card/50 p-4">
          <h2 className="mb-3 text-sm font-semibold">{isZh ? 'AI 精选板块分布' : 'AI-Picked Sector Distribution'}</h2>
          <SectorHeatmap sectors={summary.sectors} />
        </section>

        <section className="rounded-xl border border-border bg-card/50 p-4">
          <h2 className="mb-3 text-sm font-semibold">{isZh ? 'L4 触发类型分布' : 'L4 Trigger Distribution'}</h2>
          <TriggerDistribution triggers={summary.triggers} />
        </section>
      </div>

      {/* Phase 2.4: 信号质量面板 */}
      <SignalQualitySection isZh={isZh} />

      {/* Phase 4.0: 筛选结果个股列表 + 报告下载 */}
      <div ref={stocksRef}>
        {funnelResult?.ok && funnelResult.stocks && funnelResult.stocks.length > 0 ? (
          <FunnelStocksSection
            isZh={isZh}
            stocks={funnelResult.stocks}
            date={funnelResult.date}
            onDownloadReport={downloadFunnelReport}
            showAiOnly={showAiOnly}
            onClearAiOnly={() => setShowAiOnly(false)}
          />
        ) : summary.stocks.length > 0 ? (
          <FunnelStocksSection
            isZh={isZh}
            stocks={summary.stocks}
            date={summary.date}
            onDownloadReport={downloadFunnelReport}
            showAiOnly={showAiOnly}
            onClearAiOnly={() => setShowAiOnly(false)}
          />
        ) : null}
      </div>
      <ScrollToTop />
    </div>
  )
}

function FunnelPageSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <div className={`${SKEL_PULSE} h-6 w-40`} />
          <div className={`${SKEL_PULSE} mt-1 h-3 w-64`} />
        </div>
      </div>
      <SkeletonChart height={240} />
      <div className="grid gap-6 lg:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <SkeletonCard lines={4} />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  )
}

const SKEL_PULSE = 'animate-pulse rounded bg-muted/60'

function AgentStatusBar({ agentHealth, isZh }: { agentHealth?: { reachable: boolean; error?: string; detail?: string } | undefined; isZh: boolean }) {
  if (!agentHealth) return null
  const online = agentHealth.reachable
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs ${
        online ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300'
      }`}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-red-500'}`} />
      <span className="font-medium">
        {online ? (isZh ? '🧠 Agent 在线' : '🧠 Agent Online') : (isZh ? '⚠️ Agent 离线' : '⚠️ Agent Offline')}
      </span>
      {!online && agentHealth.error && (
        <span className="opacity-80">— {agentHealth.error}</span>
      )}
    </div>
  )
}

function FunnelHeader(props: {
  isZh: boolean
  summary: FunnelSummary
  dates: string[] | undefined
  selectedDate: string
  onDateChange: (date: string) => void
  funnelState: FunnelState
  funnelError: string
  funnelProgress: { stage: string; detail: string; progress: number }
  funnelLogs: FunnelProgressLog[]
  onTriggerFunnel: () => void
  onStopFunnel: () => void
  agentHealth?: { reachable: boolean; error?: string; detail?: string }
  onAiCountClick: () => void
}) {
  const { isZh, summary, dates, selectedDate, onDateChange, funnelState, funnelError, funnelProgress, funnelLogs, onTriggerFunnel, onStopFunnel, agentHealth, onAiCountClick } = props
  const { locale } = usePreferences()
  const relTime = useMemo(() => summary.date ? relativeTime(summary.date, locale) : null, [summary.date, locale])
  return (
    <div className="space-y-2">
      <AgentStatusBar agentHealth={agentHealth} isZh={isZh} />
      <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 className="text-lg font-bold">{isZh ? '威科夫漏斗' : 'Wyckoff Funnel'}</h1>
        <p className="text-xs text-muted-foreground">
          {isZh
            ? <>数据日期: {summary.date} · 扫描 {summary.totalScanned} 只 · AI 精选 <button type="button" onClick={onAiCountClick} className="text-primary hover:underline font-medium">{summary.aiCount}</button> 只</>
            : <>Data date: {summary.date} · Scanned {summary.totalScanned} · AI picked <button type="button" onClick={onAiCountClick} className="text-primary hover:underline font-medium">{summary.aiCount}</button></>}
          {relTime && <span className="ml-2 rounded-full bg-muted/50 px-2 py-0.5 text-[11px]">{relTime}</span>}
        </p>
        {funnelError && <p className="text-xs text-red-500 mt-1">{funnelError}</p>}
      </div>
        <FunnelTriggerButton isZh={isZh} funnelState={funnelState} funnelError={funnelError} funnelProgress={funnelProgress} funnelLogs={funnelLogs} onTrigger={onTriggerFunnel} onStop={onStopFunnel} />
        <FunnelDateSelect dates={dates} selectedDate={selectedDate} onDateChange={onDateChange} isZh={isZh} />
      </div>
    </div>
  )
}

function FunnelDateSelect({ dates, selectedDate, onDateChange, isZh }: {
  dates: string[] | undefined
  selectedDate: string
  onDateChange: (d: string) => void
  isZh: boolean
}) {
  if (!dates || dates.length === 0) return null
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{isZh ? '查看历史' : 'History'}</span>
      <select value={selectedDate} onChange={(e) => onDateChange(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1.5 text-xs">
        {dates.map((d) => (<option key={d} value={d}>{d}</option>))}
      </select>
    </div>
  )
}

function FunnelProgress({ stage, detail, progress }: {
  stage: string
  detail: string
  progress: number
}) {
  const pct = progress >= 0 ? Math.round(progress * 100) : null
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-[11px] text-muted-foreground">
        {stage}
        {detail ? ` — ${detail}` : ''}
        {pct !== null ? ` (${pct}%)` : ''}
      </span>
      {pct !== null && (
        <div className="h-1 w-32 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  )
}

function FunnelTriggerButton({
  isZh,
  funnelState,
  funnelError,
  funnelProgress,
  funnelLogs,
  onTrigger,
  onStop,
  agentOnline,
}: {
  isZh: boolean
  funnelState: FunnelState
  funnelError: string
  funnelProgress: { stage: string; detail: string; progress: number }
  funnelLogs: FunnelProgressLog[]
  onTrigger: () => void
  onStop: () => void
  agentOnline?: boolean
}) {
  const isRunning = funnelState === 'running'
  const isAgentDown = agentOnline === false
  const btnClass = isAgentDown
    ? 'cursor-not-allowed bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400'
    : isRunning
      ? 'cursor-not-allowed bg-muted text-muted-foreground'
      : 'bg-primary text-primary-foreground hover:bg-primary/90'

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onTrigger} disabled={isRunning || isAgentDown}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${btnClass}`}>
          {isRunning && <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />}
          {isAgentDown
            ? (isZh ? '⚠️ Agent 离线' : '⚠️ Agent Offline')
            : isRunning ? (isZh ? '筛选中...' : 'Running...') : (isZh ? '🔍 发起筛选' : '🔍 Run Funnel')}
        </button>
        {isRunning && (
          <button type="button" onClick={onStop}
            className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors">
            {isZh ? '⏹ 停止' : '⏹ Stop'}
          </button>
        )}
      </div>
      {isRunning && funnelProgress.stage && (
        <FunnelProgress stage={funnelProgress.stage} detail={funnelProgress.detail} progress={funnelProgress.progress} />
      )}
      {isRunning && funnelLogs.length > 0 && (
        <span className="text-[11px] text-muted-foreground">
          {isZh ? `已记录 ${funnelLogs.length} 条过程` : `${funnelLogs.length} progress events`}
        </span>
      )}
      {funnelError && <p className="text-xs text-red-500">{funnelError}</p>}
    </div>
  )
}

function normalizeProgressLogs(value: unknown): FunnelProgressLog[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const row = (item && typeof item === 'object' && !Array.isArray(item)) ? item as Record<string, unknown> : {}
    return {
      ts: String(row.ts || ''),
      stage: String(row.stage || ''),
      detail: String(row.detail || ''),
      progress: Number(row.progress ?? -1),
    }
  }).filter((row) => row.stage || row.detail)
}

function currentClockTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function FunnelProgressBar({ pct, isZh }: { pct: number; isZh: boolean }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
        <span>{isZh ? '整体进度' : 'Overall'}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  )
}

function FunnelRunPanel({ isZh, funnelState, logs, error }: {
  isZh: boolean
  funnelState: FunnelState
  logs: FunnelProgressLog[]
  error: string
}) {
  if (funnelState === 'idle' && logs.length === 0 && !error) return null
  const isRunning = funnelState === 'running'
  const recent = [...logs].reverse()
  const latestProgress = logs.length > 0 ? (logs[logs.length - 1]!.progress ?? -1) : -1
  const overallPct = latestProgress >= 0 ? Math.round(latestProgress * 100) : null

  return (
    <section className="rounded-lg border border-border bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{isZh ? '运行过程' : 'Run Progress'}</h2>
        <span className={`rounded-full px-2.5 py-1 text-[11px] ${isRunning ? 'bg-primary/10 text-primary animate-pulse' : funnelState === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-emerald-500/10 text-emerald-600'}`}>
          {isRunning ? (isZh ? '运行中' : 'Running') : funnelState === 'error' ? (isZh ? '异常' : 'Error') : (isZh ? '已完成' : 'Done')}
        </span>
      </div>

      {isRunning && overallPct !== null && <FunnelProgressBar pct={overallPct} isZh={isZh} />}

      {recent.length > 0 ? (
        <div className="space-y-1.5 max-h-[70vh] overflow-y-auto">
          {recent.map((log, index) => {
            const pct = log.progress != null && log.progress >= 0 ? Math.round(log.progress * 100) : null
            return (
              <div key={`${log.ts}-${log.stage}-${index}`} className="flex gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-xs items-center">
                <span className="w-14 shrink-0 text-[11px] text-muted-foreground tabular-nums">{log.ts || '--:--:--'}</span>
                <span className="min-w-[7rem] font-medium text-foreground">{log.stage}</span>
                <span className="min-w-0 flex-1 text-muted-foreground truncate">{log.detail}</span>
                {pct !== null && (
                  <span className="w-9 shrink-0 text-right tabular-nums text-[11px] text-muted-foreground">{pct}%</span>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{isZh ? '等待后端返回运行过程。' : 'Waiting for backend progress.'}</p>
      )}
      {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
    </section>
  )
}

function useFunnelLayersChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  layers: FunnelSummary['layers'],
  dataDate?: string,
) {
  useEffect(() => {
    if (!containerRef.current || layers.length === 0) return

    const theme = readTheme()
    const chart = createChart(containerRef.current, {
      height: 220,
      layout: { background: { color: theme.background }, textColor: theme.mutedText, fontSize: 11 },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, visible: false },
      localization: { priceFormatter: (v: number) => `${v.toFixed(1)}%` },
    })

    const hist = chart.addSeries(HistogramSeries, {
      color: '#2563eb',
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(1)}%` },
    })

    const colors = ['#2563eb', '#22c55e', '#f59e0b', '#ef4444']
    // Use actual date from data; each layer gets the same date (bar chart, not time series).
    // lightweight-charts requires yyyy-mm-dd format — we use the real date for correctness.
    const baseDate = dataDate && /^\d{4}-\d{2}-\d{2}$/.test(dataDate) ? dataDate : '2026-01-01'
    const layerDates = [baseDate, shiftDate(baseDate, 1), shiftDate(baseDate, 2), shiftDate(baseDate, 3)]
    const data: HistogramData<Time>[] = layers.map((layer, i) => ({
      time: layerDates[i] as Time,
      value: layer.passRate,
      color: colors[i % colors.length],
    }))

    hist.setData(data)
    chart.timeScale().fitContent()

    const resize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', resize)
    resize()

    return () => { window.removeEventListener('resize', resize); chart.remove() }
  }, [layers, dataDate])
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function FunnelLayersChart({ layers, dataDate }: { layers: FunnelSummary['layers']; dataDate?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useFunnelLayersChart(containerRef, layers, dataDate)

  return (
    <div>
      <div ref={containerRef} className="h-[220px] w-full overflow-hidden rounded-lg border border-border bg-background" />
      <FunnelLayerAccordion layers={layers} />
    </div>
  )
}

function FunnelLayerAccordion({ layers }: { layers: FunnelSummary['layers'] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))

  // L5 不在 summary.layers 中，手动补充
  const allLayers = [...layers]

  return (
    <div className="mt-3 space-y-2">
      {allLayers.map(layer => {
        const open = expanded[layer.layer] ?? false
        const criteria = LAYER_CRITERIA[layer.layer]
        return (
          <div key={layer.layer} className="rounded-lg border border-border/60 bg-background/50">
            <button
              type="button"
              onClick={() => toggle(layer.layer)}
              className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/30 transition-colors"
            >
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">{layer.layer}</span>
              <span className="text-xs font-semibold flex-1">{layer.label}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                通过 <b className="text-foreground">{layer.count}</b> 只 · {layer.passRate}%
              </span>
              <span className={`text-[10px] text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {open && (
              <div className="border-t border-border/40 px-3 pb-3 pt-2 space-y-1.5">
                <p className="text-[11px] leading-relaxed text-muted-foreground">{layer.desc}</p>
                {criteria && (
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                    {criteria.params.map(p => (
                      <div key={p.label} className="flex items-baseline gap-1.5 text-[11px]">
                        <span className="text-muted-foreground shrink-0">{p.label}:</span>
                        <span className="font-medium text-foreground">{p.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {layer.detail && Object.keys(layer.detail).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(layer.detail).map(([tag, count]) => (
                      <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                        {layer.layer === 'L4' ? (SIGNAL_LABELS[tag] ?? tag) : tag}: <b>{count}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SectorHeatmap({ sectors }: { sectors: SectorStat[] }) {
  const maxCount = Math.max(...sectors.map(s => s.count), 1)
  return (
    <div className="space-y-2">
      {sectors.map((s, i) => (
        <div key={s.sector} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 truncate text-muted-foreground">{s.sector}</span>
          <div className="flex-1">
            <div className="h-5 rounded-sm transition-all" style={{
              width: `${Math.max((s.count / maxCount) * 100, 3)}%`,
              backgroundColor: SECTOR_COLORS[i % SECTOR_COLORS.length],
              opacity: 0.85,
            }} />
          </div>
          <span className="w-12 text-right font-medium tabular-nums">{s.count}</span>
          <span className="w-10 text-right tabular-nums text-muted-foreground">{s.pct}%</span>
        </div>
      ))}
      {sectors.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">暂无数据</p>
      )}
    </div>
  )
}

function TriggerDistribution({ triggers }: { triggers: TriggerStat[] }) {
  return (
    <div className="space-y-2">
      {triggers.map(t => (
        <div key={t.trigger} className="flex items-center gap-2 text-xs">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: TRIGGER_COLORS[t.trigger] || '#6b7280' }} />
          <span className="w-20 truncate">{t.label}</span>
          <div className="flex-1">
            <div className="h-4 rounded-sm transition-all" style={{
              width: `${Math.max(t.pct, 2)}%`,
              backgroundColor: TRIGGER_COLORS[t.trigger] || '#6b7280',
              opacity: 0.75,
            }} />
          </div>
          <span className="w-8 text-right font-medium tabular-nums">{t.count}</span>
          <span className="w-10 text-right tabular-nums text-muted-foreground">{t.pct}%</span>
        </div>
      ))}
      {triggers.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">暂无数据</p>
      )}
    </div>
  )
}

// ── Phase 2.4: 信号质量面板 ──────────────────────────────────────────────────

const HEALTH_ICON: Record<string, string> = {
  HEALTHY: '✅', WATCH: '⚠️', DECAYED: '❌', INSUFFICIENT: '📊',
}

function SignalQualitySection({ isZh }: { isZh: boolean }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['signal-quality-stats'],
    queryFn: fetchSignalQualityStats,
    staleTime: 300_000,
    retry: 1,
  })

  if (isLoading) return null
  if (error || !data || data.registry.length === 0) return null

  const sorted = [...data.registry].sort((a, b) => b.sample_count - a.sample_count)

  return (
    <section className="rounded-xl border border-border bg-card/50 p-4">
      <h2 className="mb-3 text-sm font-semibold">{isZh ? '信号质量' : 'Signal Quality'}</h2>
      <div className="mb-3 flex gap-3 text-xs">
        <span className="rounded-full bg-muted px-2 py-0.5">
          {data.summary.total_signals} 种信号
        </span>
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600">
          ✅ {data.summary.healthy} 健康
        </span>
        {data.summary.decayed > 0 && (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-600">
            ❌ {data.summary.decayed} 衰减
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="px-2 py-1.5 text-left">信号</th>
              <th className="px-2 py-1.5 text-center">赛道</th>
              <th className="px-2 py-1.5 text-right">样本</th>
              <th className="px-2 py-1.5 text-right">胜率</th>
              <th className="px-2 py-1.5 text-right">均收益</th>
              <th className="px-2 py-1.5 text-center">状态</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.signal_type} className="border-b border-border/50 hover:bg-muted/20">
                <td className="px-2 py-1.5 font-medium">{r.signal_type}</td>
                <td className="px-2 py-1.5 text-center text-muted-foreground">{r.track}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.sample_count}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${
                  (r.win_rate_pct ?? 0) >= 50 ? 'text-up' : 'text-down'
                }`}>
                  {r.win_rate_pct != null ? `${r.win_rate_pct.toFixed(1)}%` : '-'}
                </td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${
                  (r.avg_return_pct ?? 0) >= 0 ? 'text-up' : 'text-down'
                }`}>
                  {r.avg_return_pct != null ? `${r.avg_return_pct >= 0 ? '+' : ''}${r.avg_return_pct.toFixed(2)}%` : '-'}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {r.health_state ? HEALTH_ICON[r.health_state] ?? '·' : '·'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Phase 4.0: 层级筛选条件组件 ──────────────────────────────────────────────

const LAYER_CRITERIA: Record<string, { params: { label: string; value: string }[] }> = {
  L1: { params: [
    { label: '板块限制', value: '沪深主板+创业板' },
    { label: 'ST/退市', value: '剔除' },
    { label: '最小市值', value: '≥ 35 亿' },
    { label: '最小日均成交额', value: '≥ 5000 万' },
    { label: 'ROE底线', value: '≥ -10%（剔除严重亏损）' },
    { label: '资产负债率', value: '≤ 85%' },
  ]},
  L2: { params: [
    { label: 'MA均线', value: 'MA50 / MA200' },
    { label: 'RS强弱', value: '10日RS≥2%, 3日RS≥1%' },
    { label: 'RPS动量', value: 'RPS50≥65, RPS120≥70' },
    { label: 'RPS斜率', value: '≥ 0.5%/天' },
    { label: '七通道策略', value: '主升/潜伏/吸筹/地量/护盘/延续/点火' },
  ]},
  L3: { params: [
    { label: '板块共振', value: '行业/概念热度Top-N过滤' },
    { label: '样本门槛', value: '单板块≥3只，分位数≥70%' },
    { label: 'ETF增强', value: '36只行业ETF注入板块权重' },
  ]},
  L4: { params: [
    { label: 'Spring', value: 'TR内破低反收+放量' },
    { label: 'LPS', value: '回踩支撑缩量确认' },
    { label: 'SOS', value: '放量突破阻力位' },
    { label: 'EVR', value: 'Effort vs Result 背离' },
    { label: 'Compression', value: '波动率压缩至极限' },
    { label: 'TrendPullback', value: '趋势回调至支撑位' },
  ]},
  L5: { params: [
    { label: '波动率止损', value: 'ATR(10)×2 动态跟踪' },
    { label: '时间止损', value: '持仓>20日且无新高' },
    { label: '派发预警', value: '高位放量+价格停滞' },
  ]},
}

const SIGNAL_LABELS: Record<string, string> = {
  sos: '点火突破', spring: 'Spring', lps: 'LPS',
  evr: 'EVR', compression: '压缩', trend_pullback: '趋势回调',
}

function FunnelLayerConditions({ isZh, layers }: { isZh: boolean; layers: Record<string, FunnelLayerCondition> }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <section className="rounded-xl border border-border bg-card/50 p-4">
      <h2 className="mb-3 text-sm font-semibold">{isZh ? '各层筛选条件' : 'Layer Conditions'}</h2>
      <div className="space-y-2">
        {(['L1', 'L2', 'L3', 'L4', 'L5'] as const).map(key => {
          const l = layers[key]
          if (!l) return null
          const open = expanded[key] ?? false
          const criteria = LAYER_CRITERIA[key]
          return (
            <div key={key} className="rounded-lg border border-border/60 bg-background/50">
              <button
                type="button"
                onClick={() => toggle(key)}
                className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/30 transition-colors"
              >
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">{key}</span>
                <span className="text-xs font-semibold flex-1">{l.label}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {isZh ? '通过' : 'Passed'} <b className="text-foreground">{l.passed}</b>
                </span>
                <span className={`text-[10px] text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
              </button>
              {open && (
                <div className="border-t border-border/40 px-3 pb-3 pt-2 space-y-1.5">
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{l.desc}</p>
                  {criteria && (
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      {criteria.params.map(p => (
                        <div key={p.label} className="flex items-baseline gap-1.5 text-[11px]">
                          <span className="text-muted-foreground shrink-0">{p.label}:</span>
                          <span className="font-medium text-foreground">{p.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {l.detail && Object.keys(l.detail).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {Object.entries(l.detail).map(([tag, count]) => (
                        <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                          {key === 'L4' ? (SIGNAL_LABELS[tag] ?? tag) : tag}: <b>{count}</b>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── Phase 4.0: 个股结果表格 + 报告下载 ───────────────────────────────────────

function FunnelStocksSection({
  isZh, stocks, date, onDownloadReport, showAiOnly, onClearAiOnly,
}: {
  isZh: boolean
  stocks: FunnelStockResult[]
  date: string
  onDownloadReport: () => void
  showAiOnly: boolean
  onClearAiOnly: () => void
}) {
  const [downloading, setDownloading] = useState(false)
  const activeStocks = stocks.filter(s => !s.exit_signal)
  const exitedStocks = stocks.filter(s => s.exit_signal)

  // 通道筛选
  const channels = useMemo(() => {
    const set = new Set<string>()
    for (const s of activeStocks) { if (s.channel) set.add(s.channel) }
    return [...set].sort()
  }, [activeStocks])
  const [channelFilter, setChannelFilter] = useState<Set<string>>(new Set())

  // 信号筛选
  const signalTypes = useMemo(() => {
    const set = new Set<string>()
    for (const s of activeStocks) { for (const sig of s.signals) set.add(sig) }
    return [...set].sort()
  }, [activeStocks])
  const [signalFilter, setSignalFilter] = useState<Set<string>>(new Set())

  // 是否显示退出信号股票
  const [showExited, setShowExited] = useState(false)

  const filtered = useMemo(() => {
    let result = activeStocks
    if (showAiOnly) result = result.filter(s => s.isAiRecommended)
    if (channelFilter.size > 0) result = result.filter(s => channelFilter.has(s.channel))
    if (signalFilter.size > 0) result = result.filter(s => s.signals.some(sig => signalFilter.has(sig)))
    return result
  }, [activeStocks, showAiOnly, channelFilter, signalFilter])

  const filterCount = channelFilter.size + signalFilter.size + (showAiOnly ? 1 : 0)

  return (
    <section className="rounded-xl border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold">
          {showAiOnly ? (isZh ? 'AI 精选结果' : 'AI-Picked Stocks') : (isZh ? '筛选结果' : 'Screened Stocks')}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {filtered.length}/{activeStocks.length} {isZh ? '只' : ''}{filterCount > 0 ? ` · ${filterCount} ${isZh ? '个筛选' : 'filters'}` : ''} · {date}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          {showAiOnly && (
            <button
              type="button"
              onClick={onClearAiOnly}
              className="inline-flex items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-500/20 transition-colors"
            >
              ✕ {isZh ? '显示全部' : 'Show All'}
            </button>
          )}
          {channels.length > 1 && (
            <MultiSelect
              label={isZh ? '通道' : 'Channel'}
              options={channels}
              selected={channelFilter}
              onChange={setChannelFilter}
            />
          )}
          {signalTypes.length > 1 && (
            <MultiSelect
              label={isZh ? '信号' : 'Signal'}
              options={signalTypes.map(s => ({ value: s, label: SIGNAL_LABELS[s] ?? s }))}
              selected={signalFilter}
              onChange={setSignalFilter}
            />
          )}
          {exitedStocks.length > 0 && (
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showExited}
                onChange={e => setShowExited(e.target.checked)}
                className="rounded border-border"
              />
              {isZh ? `已剔除(${exitedStocks.length})` : `Exited(${exitedStocks.length})`}
            </label>
          )}
          <button
            type="button"
            onClick={async () => { setDownloading(true); await onDownloadReport(); setDownloading(false) }}
            disabled={downloading}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
          >
            {downloading ? '⏳' : '📥'} {isZh ? '下载报告' : 'Download Report'}
          </button>
        </div>
      </div>
      <FunnelStockTable
        isZh={isZh}
        activeStocks={filtered}
        exitedStocks={showExited ? exitedStocks : []}
      />
    </section>
  )
}

// ── 多选下拉组件 ──────────────────────────────────────────────────────

function MultiSelect({
  label, options, selected, onChange,
}: {
  label: string
  options: string[] | { value: string; label: string }[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const items: { value: string; label: string }[] = Array.isArray(options) && typeof options[0] === 'string'
    ? (options as string[]).map(v => ({ value: v, label: v }))
    : options as { value: string; label: string }[]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) { document.addEventListener('keydown', onKey); document.addEventListener('click', onClick) }
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick) }
  }, [open])

  const toggle = (v: string) => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange(next)
  }
  const clear = () => onChange(new Set())
  const count = selected.size

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors ${
          count > 0 ? 'border-primary/40 bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
        }`}
      >
        {label}{count > 0 ? ` (${count})` : ''}
        <span className={`text-[9px] transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border border-border bg-popover p-1.5 shadow-lg">
          {count > 0 && (
            <button type="button" onClick={clear} className="w-full rounded px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-muted">
              清除筛选
            </button>
          )}
          <div className="max-h-[220px] overflow-y-auto">
            {items.map(item => (
              <label key={item.value} className="flex items-center gap-2 rounded px-2 py-1.5 text-[11px] hover:bg-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(item.value)}
                  onChange={() => toggle(item.value)}
                  className="rounded border-border"
                />
                <span className="truncate">{item.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function FunnelStockRow({ s, i }: { s: FunnelStockResult; i: number }) {
  return (
    <tr key={s.code} className={`border-b border-border/50 hover:bg-muted/20 ${s.isAiRecommended ? 'bg-indigo-500/[0.03] dark:bg-indigo-500/[0.05]' : ''}`}>
      <td className="px-2 py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
      <td className="px-2 py-1.5">
        <Link to={`/analysis?code=${s.code}`} className="font-mono font-medium text-primary hover:underline">
          {s.code}
        </Link>
      </td>
      <td className="px-2 py-1.5 max-w-[120px] truncate" title={s.name}>
        <Link to={`/analysis?code=${s.code}`} className="text-primary hover:underline truncate">
          {s.name || '-'}
        </Link>
      </td>
      <td className="px-2 py-1.5">
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">{s.channel || '-'}</span>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums font-semibold">{s.score.toFixed(1)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{s.rps50 != null ? s.rps50.toFixed(1) : '-'}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{s.rps120 != null ? s.rps120.toFixed(1) : '-'}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
        {s.latest_close != null ? s.latest_close.toFixed(2) : '-'}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex flex-wrap gap-0.5">
          {s.isAiRecommended && <span className="rounded bg-indigo-500/10 px-1 py-0.5 text-[10px] text-indigo-500 font-medium">AI</span>}
          {s.signals.map(sig => (
            <span key={sig} className="rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] text-emerald-400">
              {SIGNAL_LABELS[sig] ?? sig}
            </span>
          ))}
        </div>
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">{s.stage || '-'}</td>
      <td className="px-2 py-1.5 text-[11px] text-muted-foreground max-w-[200px] truncate" title={s.remark || ''}>
        {s.remark || '-'}
      </td>
    </tr>
  )
}

function FunnelExitedSection({ isZh, exitedStocks }: {
  isZh: boolean
  exitedStocks: FunnelStockResult[]
}) {
  return (
    <>
      <tr>
        <td colSpan={9} className="px-2 py-1.5 text-[11px] text-muted-foreground border-t border-border/50">
          {isZh ? `以下 ${exitedStocks.length} 只触发退出信号（已剔除）` : `${exitedStocks.length} stocks triggered exit signals`}
        </td>
      </tr>
      {exitedStocks.map(s => (
        <tr key={s.code} className="border-b border-border/50 opacity-40 line-through hover:opacity-60">
          <td className="px-2 py-1.5 text-muted-foreground">·</td>
          <td className="px-2 py-1.5 font-mono text-muted-foreground">{s.code}</td>
          <td className="px-2 py-1.5 text-muted-foreground max-w-[120px] truncate">{s.name || '-'}</td>
          <td className="px-2 py-1.5 text-muted-foreground">{s.channel || '-'}</td>
          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{s.score.toFixed(1)}</td>
          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{s.rps50 != null ? s.rps50.toFixed(1) : '-'}</td>
          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{s.rps120 != null ? s.rps120.toFixed(1) : '-'}</td>
          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
            {s.latest_close != null ? s.latest_close.toFixed(2) : '-'}
          </td>
          <td className="px-2 py-1.5">
            <span className="rounded bg-red-500/10 px-1 py-0.5 text-[10px] text-red-400">⚠ {s.exit_signal}</span>
          </td>
          <td className="px-2 py-1.5 text-muted-foreground">{s.stage || '-'}</td>
          <td className="px-2 py-1.5 text-[11px] text-muted-foreground">{s.remark || '-'}</td>
        </tr>
      ))}
    </>
  )
}

type StockSortKey = 'code' | 'name' | 'channel' | 'score' | 'rps50' | 'rps120' | 'price' | 'signals' | 'stage' | 'remark'

function useStockSort(activeStocks: FunnelStockResult[]) {
  const [sortBy, setSortBy] = useState<StockSortKey>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...activeStocks].sort((a, b) => {
      switch (sortBy) {
        case 'code': return a.code.localeCompare(b.code) * dir
        case 'name': return (a.name || '').localeCompare(b.name || '') * dir
        case 'channel': return (a.channel || '').localeCompare(b.channel || '') * dir
        case 'score': return ((a.score ?? 0) - (b.score ?? 0)) * dir
        case 'rps50': return ((a.rps50 ?? 0) - (b.rps50 ?? 0)) * dir
        case 'rps120': return ((a.rps120 ?? 0) - (b.rps120 ?? 0)) * dir
        case 'price': return ((a.latest_close ?? 0) - (b.latest_close ?? 0)) * dir
        case 'signals': return ((a.signals || []).length - (b.signals || []).length) * dir
        case 'stage': return (a.stage || '').localeCompare(b.stage || '') * dir
        case 'remark': return (a.remark || '').localeCompare(b.remark || '') * dir
        default: return 0
      }
    })
  }, [activeStocks, sortBy, sortDir])

  const toggleSort = (col: StockSortKey) => {
    if (sortBy === col) { setSortDir(prev => prev === 'asc' ? 'desc' : 'asc') }
    else { setSortBy(col); setSortDir(col === 'score' || col === 'price' || col === 'rps50' || col === 'rps120' ? 'desc' : 'asc') }
  }

  const sortArrow = (col: StockSortKey) =>
    sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  return { sorted, toggleSort, sortArrow }
}

function FunnelStockTable({
  isZh, activeStocks, exitedStocks,
}: {
  isZh: boolean
  activeStocks: FunnelStockResult[]
  exitedStocks: FunnelStockResult[]
}) {
  const { sorted, toggleSort, sortArrow } = useStockSort(activeStocks)

  const th = (key: StockSortKey, label: string, align: 'left' | 'right' = 'left') => (
    <th
      className={`px-2 py-1.5 text-${align} cursor-pointer hover:text-foreground select-none whitespace-nowrap`}
      onClick={() => toggleSort(key)}
    >
      {label}{sortArrow(key)}
    </th>
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-2 py-1.5 text-left w-8">#</th>
            {th('code', isZh ? '代码' : 'Code')}
            {th('name', isZh ? '名称' : 'Name')}
            {th('channel', isZh ? 'L2通道' : 'L2 Channel')}
            {th('score', isZh ? 'L3评分' : 'L3 Score', 'right')}
            {th('rps50', 'RPS50', 'right')}
            {th('rps120', 'RPS120', 'right')}
            {th('price', isZh ? '最新价' : 'Price', 'right')}
            {th('signals', isZh ? 'L4信号' : 'L4 Signals')}
            {th('stage', isZh ? 'L4阶段' : 'L4 Stage')}
            {th('remark', isZh ? '备注' : 'Remark')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => (
            <FunnelStockRow key={s.code} s={s} i={i} />
          ))}
          {exitedStocks.length > 0 && (
            <FunnelExitedSection isZh={isZh} exitedStocks={exitedStocks} />
          )}
        </tbody>
      </table>
      {sorted.length === 0 && activeStocks.length === 0 && (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {isZh ? '暂无筛选结果' : 'No results'}
        </p>
      )}
      {sorted.length === 0 && activeStocks.length > 0 && (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {isZh ? '当前筛选条件无匹配结果' : 'No stocks match current filters'}
        </p>
      )}
    </div>
  )
}

function readTheme() {
  if (typeof document === 'undefined') return { background: '#ffffff', mutedText: '#6b7194', border: '#e2e5f1', grid: '#eef1f6' }
  const style = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    background: color('--color-background', '#ffffff'),
    mutedText: color('--color-muted-foreground', '#6b7194'),
    border: color('--color-border', '#e2e5f1'),
    grid: document.documentElement.classList.contains('dark') ? '#202938' : '#eef1f6',
  }
}
