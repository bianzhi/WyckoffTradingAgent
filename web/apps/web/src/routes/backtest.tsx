/**
 * Phase 1.4 — 回测结果可视化 + Web 运行
 *
 * 支持两种模式：
 * 1. Run — 配置参数，点「运行回测」直接调 Python 引擎
 * 2. Paste — 粘贴 CLI 回测输出的 JSON（保留兼容）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart, LineSeries, HistogramSeries,
  type Time, LineStyle,
} from 'lightweight-charts'
import { usePreferences } from '@/lib/preferences'
import { dataSkill } from '@/lib/data-skill'

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
  total_return: '累计收益', sharpe_ratio: '夏普比率', max_drawdown_pct: '最大回撤',
  win_rate_pct: '胜率', calmar_ratio: '卡玛比率', portfolio_ann_ret_pct: '年化收益',
  trades: '交易次数', avg_ret_pct: '平均盈利', avg_ret_pct_loss: '平均亏损',
  portfolio_total_ret_pct: '总收益',
}

// ── Default form values ──────────────────────────────────

function defaultDateRange() {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setFullYear(start.getFullYear() - 1)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

// ── Run-mode state hook ──────────────────────────────────

function useBacktestRunForm(
  setError: (v: string) => void,
  setResult: (v: BacktestResult | null) => void,
  setRunning: (v: boolean) => void,
) {
  const d = defaultDateRange()
  const [start, setStart] = useState(d.start)
  const [end, setEnd] = useState(d.end)
  const [holdDays, setHoldDays] = useState(30)
  const [topN, setTopN] = useState(10)
  const [board, setBoard] = useState('main_chinext')
  const [exitMode, setExitMode] = useState('sltp')
  const [stopLoss, setStopLoss] = useState(-7)
  const [takeProfit, setTakeProfit] = useState(18)
  const [regimeFilter, setRegimeFilter] = useState(false)

  const doRun = useCallback(async () => {
    setError('')
    setRunning(true)
    try {
      const data = await dataSkill.fetchRunBacktest({
        start, end, hold_days: holdDays, top_n: topN, board,
        exit_mode: exitMode, stop_loss_pct: stopLoss,
        take_profit_pct: takeProfit, regime_filter: regimeFilter,
      })
      if (data.error) { setError(String(data.error)); setResult(null) }
      else { setResult(data as unknown as BacktestResult) }
    } catch (e: any) {
      setError(e.message)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [start, end, holdDays, topN, board, exitMode, stopLoss, takeProfit, regimeFilter, setError, setResult, setRunning])

  return { start, setStart, end, setEnd, holdDays, setHoldDays, topN, setTopN,
    board, setBoard, exitMode, setExitMode, stopLoss, setStopLoss,
    takeProfit, setTakeProfit, regimeFilter, setRegimeFilter, doRun }
}

// ── Main Page ────────────────────────────────────────────

export function BacktestPage() {
  const { locale } = usePreferences()
  const isZh = locale === 'zh-CN'
  const [tab, setTab] = useState<'run' | 'paste'>('run')
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [pasteInput, setPasteInput] = useState('')
  const form = useBacktestRunForm(setError, setResult, setRunning)

  const monthlyReturns = useMemo(() => {
    if (!result || !result.dates || result.dates.length < 2) return []
    return computeMonthlyReturns(result.dates, result.nav)
  }, [result])

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <BacktestTabs isZh={isZh} tab={tab} setTab={setTab} />
      {tab === 'run' ? (
        <RunTab form={form} running={running} isZh={isZh} error={error} />
      ) : (
        <PasteTab input={pasteInput} setInput={setPasteInput} isZh={isZh} setResult={setResult} setError={setError} />
      )}
      {running && <LoadingIndicator isZh={isZh} />}
      {result && result.dates?.length > 0 && !running && (
        <BacktestResults result={result} monthlyReturns={monthlyReturns} isZh={isZh} />
      )}
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────

function BacktestTabs({ isZh, tab, setTab }: { isZh: boolean; tab: string; setTab: (v: 'run' | 'paste') => void }) {
  const btn = (val: 'run' | 'paste', label: string, rounded: string) => (
    <button onClick={() => setTab(val)}
      className={`px-3 py-1.5 ${rounded} ${tab === val ? 'bg-primary text-primary-foreground' : ''}`}>
      {label}
    </button>
  )
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-lg font-bold">{isZh ? '回测结果' : 'Backtest'}</h1>
      <div className="flex rounded-md border border-border text-xs">{btn('run', isZh ? '运行' : 'Run', 'rounded-l-md')}{btn('paste', isZh ? '粘贴' : 'Paste', 'rounded-r-md')}</div>
    </div>
  )
}

function LoadingIndicator({ isZh }: { isZh: boolean }) {
  return (
    <div className="text-center py-8 text-sm text-muted-foreground">
      <div className="animate-spin inline-block w-5 h-5 border-2 border-primary border-t-transparent rounded-full mr-2 align-middle" />
      {isZh ? '回测运行中… 通常需要 30-120 秒' : 'Running backtest… 30-120s typical'}
    </div>
  )
}

function PasteTab({ input, setInput, isZh, setResult, setError }: {
  input: string; setInput: (v: string) => void; isZh: boolean
  setResult: (v: BacktestResult | null) => void; setError: (v: string) => void
}) {
  const onPaste = (text: string) => {
    setInput(text)
    const t = text.trim()
    if (!t) return
    setError('')
    try {
      const parsed = JSON.parse(t)
      if (!parsed.dates || !parsed.nav) { setError(isZh ? 'JSON 需包含 dates 和 nav 数组' : 'JSON needs dates and nav'); return }
      if (parsed.dates.length !== parsed.nav.length) { setError(isZh ? 'dates 和 nav 长度不一致' : 'length mismatch'); return }
      setResult(parsed)
    } catch { setError(isZh ? 'JSON 格式无效' : 'Invalid JSON') }
  }
  return <PasteInputArea input={input} error="" isZh={isZh} onPaste={onPaste} />
}

function RunTab({ form, running, isZh, error }: {
  form: ReturnType<typeof useBacktestRunForm>
  running: boolean; isZh: boolean; error: string
}) {
  return (
    <RunForm
      start={form.start} end={form.end} holdDays={form.holdDays} topN={form.topN}
      board={form.board} exitMode={form.exitMode} stopLoss={form.stopLoss} takeProfit={form.takeProfit}
      regimeFilter={form.regimeFilter} running={running} isZh={isZh}
      setStart={form.setStart} setEnd={form.setEnd} setHoldDays={form.setHoldDays}
      setTopN={form.setTopN} setBoard={form.setBoard} setExitMode={form.setExitMode}
      setStopLoss={form.setStopLoss} setTakeProfit={form.setTakeProfit}
      setRegimeFilter={form.setRegimeFilter} onRun={form.doRun}
      error={error}
    />
  )
}

// ── Run Form ─────────────────────────────────────────────

interface RunFormProps {
  start: string; end: string; holdDays: number; topN: number; board: string
  exitMode: string; stopLoss: number; takeProfit: number; regimeFilter: boolean
  running: boolean; isZh: boolean; error: string
  setStart: (v: string) => void; setEnd: (v: string) => void; setHoldDays: (v: number) => void
  setTopN: (v: number) => void; setBoard: (v: string) => void; setExitMode: (v: string) => void
  setStopLoss: (v: number) => void; setTakeProfit: (v: number) => void
  setRegimeFilter: (v: boolean) => void; onRun: () => void
}

function ParamGrid(props: Omit<RunFormProps, 'regimeFilter' | 'setRegimeFilter' | 'running' | 'isZh' | 'error' | 'onRun'> & { isZh: boolean }) {
  const { start, end, holdDays, topN, board, exitMode, stopLoss, takeProfit,
    setStart, setEnd, setHoldDays, setTopN, setBoard, setExitMode,
    setStopLoss, setTakeProfit, isZh } = props
  const c = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs'
  const l = 'text-[11px] text-muted-foreground mb-0.5 block'

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div><span className={l}>{isZh ? '开始日期' : 'Start'}</span><input type="date" value={start} onChange={e => setStart(e.target.value)} className={c} /></div>
      <div><span className={l}>{isZh ? '结束日期' : 'End'}</span><input type="date" value={end} onChange={e => setEnd(e.target.value)} className={c} /></div>
      <div><span className={l}>{isZh ? '持有天数' : 'Hold Days'}</span><input type="number" value={holdDays} onChange={e => setHoldDays(Number(e.target.value))} min={1} max={180} className={c} /></div>
      <div><span className={l}>Top N</span><input type="number" value={topN} onChange={e => setTopN(Number(e.target.value))} min={1} max={50} className={c} /></div>
      <div><span className={l}>{isZh ? '板块' : 'Board'}</span>
        <select value={board} onChange={e => setBoard(e.target.value)} className={c}>
          <option value="main_chinext">沪深主板+创业板</option>
          <option value="main">沪深主板</option>
          <option value="chinext">创业板</option>
          <option value="all">全A股</option>
        </select>
      </div>
      <div><span className={l}>{isZh ? '离场模式' : 'Exit'}</span>
        <select value={exitMode} onChange={e => setExitMode(e.target.value)} className={c}>
          <option value="sltp">止损+止盈</option>
          <option value="close_only">收盘离场</option>
          <option value="atr">ATR 动态止损</option>
        </select>
      </div>
      {exitMode === 'sltp' && (<>
        <div><span className={l}>{isZh ? '止损 %' : 'Stop Loss %'}</span><input type="number" value={stopLoss} onChange={e => setStopLoss(Number(e.target.value))} className={c} /></div>
        <div><span className={l}>{isZh ? '止盈 %' : 'Take Profit %'}</span><input type="number" value={takeProfit} onChange={e => setTakeProfit(Number(e.target.value))} className={c} /></div>
      </>)}
    </div>
  )
}

function RunForm(props: RunFormProps) {
  const { regimeFilter, setRegimeFilter, running, isZh, error, onRun, ...gridProps } = props
  return (
    <div className="rounded-xl border border-border bg-card/50 p-4 space-y-4">
      <ParamGrid {...gridProps} isZh={isZh} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={regimeFilter} onChange={e => setRegimeFilter(e.target.checked)} />
        {isZh ? '启用大盘水温仓控 (CRASH 不开仓)' : 'Regime filter (skip CRASH market)'}
      </label>
      <button onClick={onRun} disabled={running}
        className="rounded-md bg-primary px-6 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
        {running ? (isZh ? '运行中…' : 'Running…') : (isZh ? '运行回测' : 'Run Backtest')}
      </button>
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  )
}

// ── Results ──────────────────────────────────────────────

function BacktestResults({ result, monthlyReturns, isZh }: {
  result: BacktestResult; monthlyReturns: MonthlyReturn[]; isZh: boolean
}) {
  return (
    <>
      {result.metrics && (
        <MetricsPanel metrics={result.metrics} />
      )}
      <section className="rounded-xl border border-border bg-card/50 p-4">
        <h2 className="mb-3 text-sm font-semibold">{isZh ? '资金曲线' : 'Equity Curve'}</h2>
        <EquityCurveChart result={result} />
      </section>
      {monthlyReturns.length > 0 && (
        <section className="rounded-xl border border-border bg-card/50 p-4">
          <h2 className="mb-3 text-sm font-semibold">{isZh ? '月度收益' : 'Monthly Returns'}</h2>
          <MonthlyReturnsHeatmap returns={monthlyReturns} />
        </section>
      )}
    </>
  )
}

function MetricsPanel({ metrics }: { metrics: Record<string, string | number> }) {
  const items = Object.entries(metrics).filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
  if (items.length === 0) return null
  return (
    <section className="grid grid-cols-3 gap-3 sm:grid-cols-5">
      {items.map(([key, value]) => (
        <div key={key} className="rounded-lg border border-border bg-card/50 px-3 py-2 text-center">
          <div className="text-[11px] text-muted-foreground">{METRIC_LABELS_ZH[key] || key}</div>
          <div className="mt-0.5 text-sm font-semibold">{String(value)}</div>
        </div>
      ))}
    </section>
  )
}

// ── Charts ───────────────────────────────────────────────

function initEquityChart(container: HTMLDivElement, result: BacktestResult) {
  const theme = readTheme()
  const chart = createChart(container, {
    height: 360,
    layout: { background: { color: theme.background }, textColor: theme.mutedText, fontSize: 11 },
    grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
    rightPriceScale: { borderColor: theme.border },
    timeScale: { borderColor: theme.border, timeVisible: false },
    crosshair: { mode: 0 },
  })
  const navSeries = chart.addSeries(LineSeries, {
    color: '#2563eb', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'Strategy',
  })
  navSeries.setData(result.dates.map((d, i) => ({ time: d as Time, value: result.nav[i] ?? 1 })))
  if (result.benchmark_nav && result.benchmark_nav.length === result.dates.length) {
    const bench = chart.addSeries(LineSeries, {
      color: '#94a3b8', lineWidth: 1, lineStyle: LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: true, title: 'Benchmark',
    })
    bench.setData(result.dates.map((d, i) => ({ time: d as Time, value: result.benchmark_nav![i] ?? 1 })))
  }
  const dd = computeDrawdownSeries(result.nav)
  const ddPane = chart.addSeries(HistogramSeries, {
    priceFormat: { type: 'custom', formatter: (v: number) => `${(v * 100).toFixed(1)}%` },
    priceScaleId: 'drawdown',
  })
  chart.priceScale('drawdown').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
  ddPane.setData(result.dates.map((d, i) => ({
    time: d as Time, value: dd[i] ?? 0,
    color: (dd[i] ?? 0) < -0.05 ? '#ef4444' : (dd[i] ?? 0) < -0.02 ? '#f97316' : '#94a3b8',
  })))
  chart.timeScale().fitContent()
  return chart
}

function useEquityChart(containerRef: React.RefObject<HTMLDivElement | null>, result: BacktestResult): void {
  useEffect(() => {
    if (!containerRef.current || result.dates.length === 0) return
    const chart = initEquityChart(containerRef.current, result)
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

// ── Helpers ──────────────────────────────────────────────

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
    month, label: `${month.slice(5, 7)}月`, returnPct: startNav > 0 ? ((endNav - startNav) / startNav) * 100 : 0,
  }))
}

function readTheme() {
  if (typeof document === 'undefined') return { background: '#ffffff', mutedText: '#6b7194', border: '#e2e5f1', grid: '#eef1f6' }
  const style = getComputedStyle(document.documentElement)
  return {
    background: style.getPropertyValue('--color-background').trim() || '#ffffff',
    mutedText: style.getPropertyValue('--color-muted-foreground').trim() || '#6b7194',
    border: style.getPropertyValue('--color-border').trim() || '#e2e5f1',
    grid: document.documentElement.classList.contains('dark') ? '#202938' : '#eef1f6',
  }
}

function PasteInputArea({ input, error, isZh, onPaste }: {
  input: string; error: string; isZh: boolean; onPaste: (text: string) => void
}) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      <textarea className="h-32 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
        placeholder={isZh ? '粘贴 JSON: {"dates":["2024-01-02",...], "nav":[1.0,1.01,...]}' : 'Paste JSON'}
        value={input} onChange={(e) => onPaste(e.target.value)} />
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
        const cls = ret == null ? 'text-muted-foreground/30'
          : ret >= 5 ? 'bg-red-500/20 text-red-600 font-semibold' : ret >= 2 ? 'bg-red-400/15 text-red-500'
          : ret > -2 ? 'text-muted-foreground' : ret > -5 ? 'bg-emerald-400/15 text-emerald-500' : 'bg-emerald-500/20 text-emerald-600 font-semibold'
        return (
          <td key={m} className={`px-1 py-1.5 text-center tabular-nums ${cls}`}>
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
