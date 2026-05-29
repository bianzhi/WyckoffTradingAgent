/**
 * Phase 1.4 — 回测结果可视化
 *
 * 支持粘贴 CLI 回测输出的 JSON，展示资金曲线、回撤曲线、月度收益热力图。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart, LineSeries, HistogramSeries,
  type LineData, type HistogramData, type Time, LineStyle,
} from 'lightweight-charts'
import { usePreferences } from '@/lib/preferences'

interface BacktestResult {
  dates: string[]
  nav: number[]
  benchmark_nav?: number[]
  trades?: { date: string; code: string; action: string; price: number; shares: number }[]
  metrics?: Record<string, string | number>
}

interface MonthlyReturn {
  month: string
  label: string
  returnPct: number
}

const METRIC_LABELS_ZH: Record<string, string> = {
  total_return: '累计收益', sharpe: '夏普比率', max_drawdown: '最大回撤',
  win_rate: '胜率', calmar: '卡玛比率', annual_return: '年化收益',
  trades: '交易次数', avg_win: '平均盈利', avg_loss: '平均亏损',
}

export function BacktestPage() {
  const { locale } = usePreferences()
  const isZh = locale === 'zh-CN'
  const [input, setInput] = useState('')
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState('')

  const handlePaste = (text: string) => {
    setError('')
    try {
      const parsed = JSON.parse(text)
      if (!parsed.dates || !parsed.nav || !Array.isArray(parsed.dates) || !Array.isArray(parsed.nav)) {
        setError(isZh ? 'JSON 需要包含 dates 和 nav 数组' : 'JSON must contain dates and nav arrays')
        return
      }
      if (parsed.dates.length !== parsed.nav.length) {
        setError(isZh ? 'dates 和 nav 长度不一致' : 'dates and nav arrays must have the same length')
        return
      }
      setResult(parsed)
    } catch {
      setError(isZh ? 'JSON 格式无效' : 'Invalid JSON format')
    }
  }

  const monthlyReturns = useMemo(() => {
    if (!result || result.dates.length < 2) return []
    return computeMonthlyReturns(result.dates, result.nav)
  }, [result])

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-lg font-bold">{isZh ? '回测结果' : 'Backtest Results'}</h1>
        <p className="text-xs text-muted-foreground">
          {isZh ? '粘贴 CLI 回测输出的 JSON 数据' : 'Paste CLI backtest JSON output'}
        </p>
      </div>

      <PasteInputArea input={input} error={error} isZh={isZh} onPaste={(text) => { setInput(text); if (text.trim()) handlePaste(text) }} />

      {result && result.dates.length > 0 && (
        <>
          {/* Metrics panel */}
          {result.metrics && (
            <section className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              {Object.entries(result.metrics).map(([key, value]) => (
                <div key={key} className="rounded-lg border border-border bg-card/50 px-3 py-2 text-center">
                  <div className="text-[11px] text-muted-foreground">{METRIC_LABELS_ZH[key] || key}</div>
                  <div className="mt-0.5 text-sm font-semibold">{String(value)}</div>
                </div>
              ))}
            </section>
          )}

          {/* Equity curve */}
          <section className="rounded-xl border border-border bg-card/50 p-4">
            <h2 className="mb-3 text-sm font-semibold">{isZh ? '资金曲线' : 'Equity Curve'}</h2>
            <EquityCurveChart result={result} />
          </section>

          {/* Monthly returns heatmap */}
          {monthlyReturns.length > 0 && (
            <section className="rounded-xl border border-border bg-card/50 p-4">
              <h2 className="mb-3 text-sm font-semibold">{isZh ? '月度收益' : 'Monthly Returns'}</h2>
              <MonthlyReturnsHeatmap returns={monthlyReturns} />
            </section>
          )}
        </>
      )}
    </div>
  )
}

function useEquityChart(containerRef: React.RefObject<HTMLDivElement | null>, result: BacktestResult): void {
  useEffect(() => {
    if (!containerRef.current || result.dates.length === 0) return

    const theme = readTheme()
    const chart = createChart(containerRef.current, {
      height: 360,
      layout: { background: { color: theme.background }, textColor: theme.mutedText, fontSize: 11 },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: false },
      crosshair: { mode: 0 },
    })

    // Equity line
    const navSeries = chart.addSeries(LineSeries, {
      color: '#2563eb', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'Strategy',
    })
    const navData: LineData<Time>[] = result.dates.map((d, i) => ({
      time: d as Time, value: result.nav[i] ?? 1,
    }))
    navSeries.setData(navData)

    // Benchmark line
    if (result.benchmark_nav && result.benchmark_nav.length === result.dates.length) {
      const benchSeries = chart.addSeries(LineSeries, {
        color: '#94a3b8', lineWidth: 1, lineStyle: LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: true, title: 'Benchmark',
      })
      const benchData: LineData<Time>[] = result.dates.map((d, i) => ({
        time: d as Time, value: result.benchmark_nav![i] ?? 1,
      }))
      benchSeries.setData(benchData)
    }

    // Drawdown as histogram on separate pane (simplified: compute from nav)
    const dd: number[] = computeDrawdownSeries(result.nav)
    const ddPane = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'custom', formatter: (v: number) => `${(v * 100).toFixed(1)}%` },
      priceScaleId: 'drawdown',
    })
    chart.priceScale('drawdown').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    const ddData: HistogramData<Time>[] = result.dates.map((d, i) => ({
      time: d as Time, value: dd[i] ?? 0,
      color: (dd[i] ?? 0) < -0.05 ? '#ef4444' : (dd[i] ?? 0) < -0.02 ? '#f97316' : '#94a3b8',
    }))
    ddPane.setData(ddData)

    chart.timeScale().fitContent()
    const resize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', resize)
    resize()
    return () => { window.removeEventListener('resize', resize); chart.remove() }
  }, [result])
}

function EquityCurveChart({ result }: { result: BacktestResult }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useEquityChart(containerRef, result)
  return <div ref={containerRef} className="h-[360px] w-full overflow-hidden rounded-lg border border-border bg-background" />
}

function MonthlyReturnsHeatmap({ returns }: { returns: MonthlyReturn[] }) {
  // Group by year
  const byYear = new Map<string, MonthlyReturn[]>()
  for (const r of returns) {
    const year = r.month.slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year)!.push(r)
  }

  const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']

  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left text-muted-foreground">Year</th>
            {months.map(m => <th key={m} className="px-1 py-1 text-center text-muted-foreground">{m}月</th>)}
            <th className="px-2 py-1 text-right text-muted-foreground">全年</th>
          </tr>
        </thead>
        <tbody>
          {[...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([year, monthly]) => (
            <YearRow key={year} year={year} monthly={monthly} months={months} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function computeDrawdownSeries(nav: number[]): number[] {
  const dd: number[] = []
  let peak = nav[0] ?? 0
  for (const v of nav) {
    if (v > peak) peak = v
    dd.push(peak > 0 ? (v - peak) / peak : 0)
  }
  return dd
}

function computeMonthlyReturns(dates: string[], nav: number[]): MonthlyReturn[] {
  const monthly = new Map<string, { startNav: number; endNav: number }>()
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]!
    const month = d.slice(0, 7)
    if (!monthly.has(month)) monthly.set(month, { startNav: nav[i] ?? 1, endNav: nav[i] ?? 1 })
    monthly.get(month)!.endNav = nav[i] ?? 1
  }
  return [...monthly.entries()].map(([month, { startNav, endNav }]) => ({
    month,
    label: `${month.slice(5, 7)}月`,
    returnPct: startNav > 0 ? ((endNav - startNav) / startNav) * 100 : 0,
  }))
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

function PasteInputArea({ input, error, isZh, onPaste }: {
  input: string; error: string; isZh: boolean
  onPaste: (text: string) => void
}) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      <textarea
        className="h-32 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
        placeholder={isZh
          ? '粘贴 JSON: {"dates":["2024-01-02",...], "nav":[1.0,1.01,...], "benchmark_nav":[...], "metrics":{...}}'
          : 'Paste JSON: {"dates":["2024-01-02",...], "nav":[1.0,1.01,...], "benchmark_nav":[...], "metrics":{...}}'
        }
        value={input}
        onChange={(e) => onPaste(e.target.value)}
      />
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  )
}

function YearRow({ year, monthly, months }: { year: string; monthly: MonthlyReturn[]; months: string[] }) {
  const yearMap = new Map(monthly.map(r => [r.month.slice(5, 7), r.returnPct]))
  const yearTotal = monthly.reduce((sum, r) => sum + r.returnPct, 0)
  return (
    <tr className="border-t border-border">
      <td className="px-2 py-1.5 font-medium">{year}</td>
      {months.map(m => {
        const ret = yearMap.get(m)
        const colorClass = ret == null ? 'text-muted-foreground/30'
          : ret >= 5 ? 'bg-red-500/20 text-red-600 font-semibold'
          : ret >= 2 ? 'bg-red-400/15 text-red-500'
          : ret > -2 ? 'text-muted-foreground'
          : ret > -5 ? 'bg-emerald-400/15 text-emerald-500'
          : 'bg-emerald-500/20 text-emerald-600 font-semibold'
        return (
          <td key={m} className={`px-1 py-1.5 text-center tabular-nums ${colorClass}`}>
            {ret != null ? `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%` : '·'}
          </td>
        )
      })}
      <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${yearTotal >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>
        {yearTotal >= 0 ? '+' : ''}{yearTotal.toFixed(1)}%
      </td>
    </tr>
  )
}
