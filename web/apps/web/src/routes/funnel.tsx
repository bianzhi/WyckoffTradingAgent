/**
 * Phase 1.3 — 漏斗结果可视化页面
 *
 * 展示：漏斗各层通过率柱状图 + 板块热力图 + L4 触发分布
 * 支持一键发起全市场漏斗筛选
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createChart, HistogramSeries, type HistogramData, type Time } from 'lightweight-charts'
import { fetchFunnelSummary, fetchFunnelDates, fetchSignalQualityStats, type FunnelSummary, type SectorStat, type TriggerStat } from '@/lib/funnel-data'
import { WyckoffLoading } from '@/components/loading'
import { usePreferences } from '@/lib/preferences'

type FunnelState = 'idle' | 'running' | 'completed' | 'error'

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
  const queryClient = useQueryClient()

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
        const resp = await fetch('/api/funnel/status')
        const body = await resp.json() as Record<string, unknown>
        if (stopped) return

        const status = String(body.status || 'idle')
        if (status === 'running') {
          setFunnelState('running')
          setTimeout(poll, 3000)
        } else {
          setFunnelRunning(false)
          if (body.last_result && (body.last_result as Record<string, unknown>).ok) {
            setFunnelState('completed')
            // 刷新数据
            await refetchDates()
            await refetchSummary()
            queryClient.invalidateQueries({ queryKey: ['funnel-summary'] })
            queryClient.invalidateQueries({ queryKey: ['funnel-dates'] })
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
    try {
      const { supabase } = await import('@/lib/supabase')
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = {}
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      const resp = await fetch('/api/funnel/trigger', { method: 'POST', headers })
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

  const isZh = locale === 'zh-CN'

  if (isLoading) return <WyckoffLoading />
  if (!summary) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col items-center justify-center gap-4 py-20">
          <div className="text-lg font-semibold">{isZh ? '暂无漏斗数据' : 'No funnel data yet'}</div>
          <p className="text-sm text-muted-foreground">{isZh ? '点击下方按钮启动全市场漏斗筛选' : 'Click the button below to start a funnel screening'}</p>
          <FunnelTriggerButton
            isZh={isZh}
            funnelState={funnelState}
            funnelError={funnelError}
            onTrigger={triggerFunnel}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <FunnelHeader
        isZh={isZh}
        summary={summary}
        dates={dates}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        funnelState={funnelState}
        funnelError={funnelError}
        onTriggerFunnel={triggerFunnel}
      />

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
  onTriggerFunnel: () => void
}) {
  const { isZh, summary, dates, selectedDate, onDateChange, funnelState, funnelError, onTriggerFunnel } = props
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 className="text-lg font-bold">{isZh ? '威科夫漏斗' : 'Wyckoff Funnel'}</h1>
        <p className="text-xs text-muted-foreground">
          {isZh
            ? `日期: ${summary.date} · 扫描 ${summary.totalScanned} 只 · AI 精选 ${summary.aiCount} 只`
            : `Date: ${summary.date} · Scanned ${summary.totalScanned} · AI picked ${summary.aiCount}`}
        </p>
        {funnelError && <p className="text-xs text-red-500 mt-1">{funnelError}</p>}
      </div>
      <div className="flex items-center gap-2">
        <FunnelTriggerButton isZh={isZh} funnelState={funnelState} funnelError={funnelError} onTrigger={onTriggerFunnel} />
        <FunnelDateSelect dates={dates} selectedDate={selectedDate} onDateChange={onDateChange} />
      </div>
    </div>
  )
}

function FunnelDateSelect({ dates, selectedDate, onDateChange }: {
  dates: string[] | undefined
  selectedDate: string
  onDateChange: (d: string) => void
}) {
  if (!dates || dates.length === 0) return null
  return (
    <select value={selectedDate} onChange={(e) => onDateChange(e.target.value)}
      className="rounded-md border border-border bg-background px-3 py-1.5 text-xs">
      {dates.map((d) => (<option key={d} value={d}>{d}</option>))}
    </select>
  )
}

function FunnelTriggerButton({
  isZh,
  funnelState,
  funnelError,
  onTrigger,
}: {
  isZh: boolean
  funnelState: FunnelState
  funnelError: string
  onTrigger: () => void
}) {
  const isRunning = funnelState === 'running'

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={onTrigger}
        disabled={isRunning}
        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
          isRunning
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-primary text-primary-foreground hover:bg-primary/90'
        }`}
      >
        {isRunning ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        ) : null}
        {isRunning
          ? (isZh ? '筛选中...' : 'Running...')
          : (isZh ? '🔍 发起筛选' : '🔍 Run Funnel')}
      </button>
      {funnelError && <p className="text-xs text-red-500">{funnelError}</p>}
    </div>
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
    const data: HistogramData<Time>[] = layers.map((layer, i) => ({
      time: layer.layer as Time,
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
