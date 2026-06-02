/**
 * Phase 1.3 — 漏斗结果可视化页面
 *
 * 展示：漏斗各层通过率柱状图 + 板块热力图 + L4 触发分布
 * 支持一键发起全市场漏斗筛选
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createChart, HistogramSeries, type HistogramData, type Time } from 'lightweight-charts'
import { fetchFunnelSummary, fetchFunnelDates, fetchSignalQualityStats, fetchFunnelResult, downloadFunnelReport, fetchAgentHealth, type FunnelSummary, type SectorStat, type TriggerStat, type FunnelFullResult, type FunnelLayerCondition } from '@/lib/funnel-data'
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

  // ── Phase 4.0: 漏斗完整结果（个股+层级条件） ──────────────────────
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
      />
      <FunnelRunPanel isZh={isZh} funnelState={funnelState} logs={funnelLogs} error={funnelError} />

      {/* Layer pass rate chart */}
      <section className="rounded-xl border border-border bg-card/50 p-4">
        <h2 className="mb-3 text-sm font-semibold">{isZh ? '各层通过率' : 'Layer Pass Rates'}</h2>
        <FunnelLayersChart layers={summary.layers} />
      </section>

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

      {/* Phase 4.0: 层级筛选条件 */}
      {funnelResult?.ok && funnelResult.layer_conditions && (
        <FunnelLayerConditions isZh={isZh} layers={funnelResult.layer_conditions} />
      )}

      {/* Phase 4.0: 筛选结果个股列表 + 报告下载 */}
      {funnelResult?.ok && funnelResult.stocks && funnelResult.stocks.length > 0 && (
        <FunnelStocksSection
          isZh={isZh}
          stocks={funnelResult.stocks}
          date={funnelResult.date}
          onDownloadReport={downloadFunnelReport}
        />
      )}
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
}) {
  const { isZh, summary, dates, selectedDate, onDateChange, funnelState, funnelError, funnelProgress, funnelLogs, onTriggerFunnel, onStopFunnel, agentHealth } = props
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
            ? `数据日期: ${summary.date} · 扫描 ${summary.totalScanned} 只 · AI 精选 ${summary.aiCount} 只`
            : `Data date: ${summary.date} · Scanned ${summary.totalScanned} · AI picked ${summary.aiCount}`}
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
  return value.slice(-80).map((item) => {
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
  const recent = logs.slice(-15).reverse()
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
        <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
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
) {
  useEffect(() => {
    if (!containerRef.current || layers.length === 0) return

    const theme = readTheme()
    const chart = createChart(containerRef.current, {
      height: 220,
      layout: { background: { color: theme.background }, textColor: theme.mutedText, fontSize: 11 },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, visible: true, timeVisible: false },
      localization: { priceFormatter: (v: number) => `${v.toFixed(1)}%` },
    })

    const hist = chart.addSeries(HistogramSeries, {
      color: '#2563eb',
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(1)}%` },
    })

    const colors = ['#2563eb', '#22c55e', '#f59e0b', '#ef4444']
    // Use dummy dates to satisfy lightweight-charts' yyyy-mm-dd requirement.
    // Layer labels are rendered separately below the chart.
    const layerDates = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04']
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
  }, [layers])
}

function FunnelLayersChart({ layers }: { layers: FunnelSummary['layers'] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useFunnelLayersChart(containerRef, layers)

  return (
    <div>
      <div ref={containerRef} className="h-[220px] w-full overflow-hidden rounded-lg border border-border bg-background" />
      <div className="mt-2 flex justify-around text-[11px] text-muted-foreground">
        {layers.map(layer => (
          <div key={layer.layer} className="text-center">
            <div className="font-medium">{layer.label}</div>
            <div>{layer.count} 只</div>
            <div className="font-semibold text-foreground">{layer.passRate}%</div>
          </div>
        ))}
      </div>
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

const SIGNAL_LABELS: Record<string, string> = {
  sos: '点火突破', spring: 'Spring', lps: 'LPS',
  evr: 'EVR', compression: '压缩', trend_pullback: '趋势回调',
}

function FunnelLayerConditions({ isZh, layers }: { isZh: boolean; layers: Record<string, FunnelLayerCondition> }) {
  return (
    <section className="rounded-xl border border-border bg-card/50 p-4">
      <h2 className="mb-3 text-sm font-semibold">{isZh ? '各层筛选条件' : 'Layer Conditions'}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(['L1', 'L2', 'L3', 'L4', 'L5'] as const).map(key => {
          const l = layers[key]
          if (!l) return null
          return (
            <div key={key} className="rounded-lg border border-border/60 bg-background/50 p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">{key}</span>
                <span className="text-xs font-semibold">{l.label}</span>
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                  {isZh ? '通过' : 'Passed'} <b className="text-foreground">{l.passed}</b>
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{l.desc}</p>
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
          )
        })}
      </div>
    </section>
  )
}

// ── Phase 4.0: 个股结果表格 + 报告下载 ───────────────────────────────────────

function FunnelStocksSection({
  isZh, stocks, date, onDownloadReport,
}: {
  isZh: boolean
  stocks: FunnelFullResult['stocks']
  date: string
  onDownloadReport: () => void
}) {
  const [downloading, setDownloading] = useState(false)
  const activeStocks = stocks.filter(s => !s.exit_signal)
  const exitedStocks = stocks.filter(s => s.exit_signal)

  return (
    <section className="rounded-xl border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold">
          {isZh ? '筛选结果' : 'Screened Stocks'}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {stocks.length} {isZh ? '只' : ''} · {date}
          </span>
        </h2>
        <button
          type="button"
          onClick={async () => { setDownloading(true); await onDownloadReport(); setDownloading(false) }}
          disabled={downloading}
          className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
        >
          {downloading ? '⏳' : '📥'} {isZh ? '下载报告' : 'Download Report'}
        </button>
      </div>
      <FunnelStockTable isZh={isZh} activeStocks={activeStocks} exitedStocks={exitedStocks} />
    </section>
  )
}

function FunnelStockRow({ s, i }: { s: FunnelFullResult['stocks'][number]; i: number }) {
  return (
    <tr key={s.code} className="border-b border-border/50 hover:bg-muted/20">
      <td className="px-2 py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
      <td className="px-2 py-1.5">
        <a href={`/analysis?code=${s.code}`} className="font-mono font-medium text-primary hover:underline">
          {s.code}
        </a>
      </td>
      <td className="px-2 py-1.5 text-muted-foreground max-w-[120px] truncate" title={s.name}>{s.name || '-'}</td>
      <td className="px-2 py-1.5">
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">{s.channel || '-'}</span>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums font-semibold">{s.score.toFixed(1)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
        {s.latest_close != null ? s.latest_close.toFixed(2) : '-'}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex flex-wrap gap-0.5">
          {s.signals.map(sig => (
            <span key={sig} className="rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] text-emerald-400">
              {SIGNAL_LABELS[sig] ?? sig}
            </span>
          ))}
        </div>
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">{s.stage || '-'}</td>
    </tr>
  )
}

function FunnelExitedSection({ isZh, exitedStocks }: {
  isZh: boolean
  exitedStocks: FunnelFullResult['stocks']
}) {
  return (
    <>
      <tr>
        <td colSpan={8} className="px-2 py-1.5 text-[11px] text-muted-foreground">
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
          <td className="px-2 py-1.5 text-right font-mono tabular-nums">
            {s.latest_close != null ? s.latest_close.toFixed(2) : '-'}
          </td>
          <td className="px-2 py-1.5">
            <span className="rounded bg-red-500/10 px-1 py-0.5 text-[10px] text-red-400">⚠ {s.exit_signal}</span>
          </td>
          <td className="px-2 py-1.5 text-muted-foreground">{s.stage || '-'}</td>
        </tr>
      ))}
    </>
  )
}

function useStockSort(activeStocks: FunnelFullResult['stocks']) {
  const [sortBy, setSortBy] = useState<'score' | 'price' | 'channel' | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    if (!sortBy) return activeStocks
    const dir = sortDir === 'asc' ? 1 : -1
    return [...activeStocks].sort((a, b) => {
      if (sortBy === 'score') return (a.score - b.score) * dir
      if (sortBy === 'price') return ((a.latest_close ?? 0) - (b.latest_close ?? 0)) * dir
      if (sortBy === 'channel') return a.channel.localeCompare(b.channel) * dir
      return 0
    })
  }, [activeStocks, sortBy, sortDir])

  const toggleSort = (col: 'score' | 'price' | 'channel') => {
    if (sortBy === col) { setSortDir(prev => prev === 'asc' ? 'desc' : 'asc') }
    else { setSortBy(col); setSortDir('desc') }
  }

  const sortArrow = (col: 'score' | 'price' | 'channel') =>
    sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  return { sorted, toggleSort, sortArrow }
}

function FunnelStockTable({
  isZh, activeStocks, exitedStocks,
}: {
  isZh: boolean
  activeStocks: FunnelFullResult['stocks']
  exitedStocks: FunnelFullResult['stocks']
}) {
  const { sorted, toggleSort, sortArrow } = useStockSort(activeStocks)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-2 py-1.5 text-left w-8">#</th>
            <th className="px-2 py-1.5 text-left">{isZh ? '代码' : 'Code'}</th>
            <th className="px-2 py-1.5 text-left">{isZh ? '名称' : 'Name'}</th>
            <th className="px-2 py-1.5 text-left cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('channel')}>
              {isZh ? 'L2通道' : 'L2 Channel'}{sortArrow('channel')}
            </th>
            <th className="px-2 py-1.5 text-right cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('score')}>
              {isZh ? '评分' : 'Score'}{sortArrow('score')}
            </th>
            <th className="px-2 py-1.5 text-right cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('price')}>
              {isZh ? '最新价' : 'Price'}{sortArrow('price')}
            </th>
            <th className="px-2 py-1.5 text-left">{isZh ? 'L4信号' : 'L4 Signals'}</th>
            <th className="px-2 py-1.5 text-left">{isZh ? '阶段' : 'Stage'}</th>
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
