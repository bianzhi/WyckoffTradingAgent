import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Filter, X } from 'lucide-react'
import { usePreferences } from '@/lib/preferences'
import { useDocTitle } from '@/lib/doc-title'
import { Breadcrumb } from '@/components/ux/breadcrumb'
import { ScrollToTop } from '@/components/ux/scroll-top'
import { SkeletonTable } from '@/components/ux/skeleton'
import { dataSkill } from '@/lib/data-skill'

const STATUS_TABS = ['all', 'active', 'confirmed', 'expired'] as const
type StatusFilter = (typeof STATUS_TABS)[number]

type SortKey = 'code' | 'signal_type' | 'track' | 'trigger_score' | 'trade_date' | 'lifecycle_status'
type SortOrder = 'asc' | 'desc'

const PAGE_SIZE = 50

const SIGNAL_LABELS: Record<string, string> = {
  sos: '点火突破', spring: 'Spring', lps: 'LPS',
  evr: 'EVR', compression: '压缩', trend_pullback: '趋势回调',
}

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'bg-amber-500/10 text-amber-600',
  CONFIRMED: 'bg-emerald-500/10 text-emerald-600',
  EXPIRED: 'bg-slate-500/10 text-slate-500',
  REJECTED: 'bg-red-500/10 text-red-600',
}

const TRACK_BADGE: Record<string, string> = {
  Trend: 'bg-blue-500/10 text-blue-600',
  Accum: 'bg-purple-500/10 text-purple-600',
}

export function SignalPage() {
  const { locale, t } = usePreferences()
  const isZh = locale === 'zh-CN'
  useDocTitle(t('signal.title'))

  const [filter, setFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(0)
  const [sortBy, setSortBy] = useState<SortKey>('trade_date')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [signalTypeFilter, setSignalTypeFilter] = useState('')
  const [trackFilter, setTrackFilter] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['signal-observations', filter, page, sortBy, sortOrder, signalTypeFilter, trackFilter],
    queryFn: () => dataSkill.fetchSignalObservations({
      status: filter, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
      sortBy, sortOrder, signalType: signalTypeFilter, track: trackFilter,
    }),
    staleTime: 120_000,
    retry: 1,
  })

  const observations = data?.observations ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const breadcrumbItems = [{ label: isZh ? '信号池' : 'Signals' }]

  const handleSort = useCallback((key: SortKey) => {
    if (key === sortBy) {
      setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortBy(key)
      setSortOrder('desc')
    }
    setPage(0)
  }, [sortBy])

  const resetFilters = useCallback(() => {
    setSignalTypeFilter('')
    setTrackFilter('')
    setPage(0)
  }, [])

  const hasColumnFilters = signalTypeFilter || trackFilter

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Breadcrumb items={breadcrumbItems} />
      <ScrollToTop />
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{t('signal.title')}</h1>
          {data && !isLoading && (
            <p className="mt-1 text-xs text-muted-foreground">
              {total} {t('signal.totalSignals')}
            </p>
          )}
        </div>
        {hasColumnFilters && (
          <button
            onClick={resetFilters}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={12} />
            {isZh ? '清除筛选' : 'Clear filters'}
          </button>
        )}
      </header>
      <FilterTabs filter={filter} onFilter={(f) => { setFilter(f); setPage(0) }} t={t} />
      <SignalContent
        observations={observations} total={total} totalPages={totalPages}
        page={page} onPage={setPage} isLoading={isLoading}
        error={error ? String(error) : null} isZh={isZh} t={t as (key: string) => string}
        sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort}
        signalTypeFilter={signalTypeFilter} trackFilter={trackFilter}
        onSignalTypeChange={(v) => { setSignalTypeFilter(v); setPage(0) }}
        onTrackChange={(v) => { setTrackFilter(v); setPage(0) }}
      />
    </div>
  )
}

function FilterTabs({ filter, onFilter, t }: { filter: StatusFilter; onFilter: (f: StatusFilter) => void; t: ReturnType<typeof usePreferences>['t'] }) {
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto">
      {STATUS_TABS.map((tab) => (
        <button
          key={tab}
          onClick={() => onFilter(tab)}
          className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
            filter === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          {t(`signal.${tab}`)}
        </button>
      ))}
    </nav>
  )
}

function SignalContent({
  observations, total: _total, totalPages, page, onPage, isLoading, error, isZh, t,
  sortBy, sortOrder, onSort, signalTypeFilter, trackFilter, onSignalTypeChange, onTrackChange,
}: {
  observations: Array<Record<string, unknown>>
  total: number; totalPages: number; page: number
  onPage: (p: number) => void; isLoading: boolean
  error: string | null; isZh: boolean; t: (key: string) => string
  sortBy: SortKey; sortOrder: SortOrder; onSort: (key: SortKey) => void
  signalTypeFilter: string; trackFilter: string
  onSignalTypeChange: (v: string) => void; onTrackChange: (v: string) => void
}) {
  if (isLoading) return <SkeletonTable rows={8} cols={7} />
  if (error) return (
    <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
      <Activity size={32} className="mx-auto mb-2 opacity-30" />
      <p className="text-sm">{error}</p>
    </div>
  )
  if (observations.length === 0) return <EmptyState isZh={isZh} t={t} />
  return (
    <>
      <SignalTable
        observations={observations} isZh={isZh} t={t}
        sortBy={sortBy} sortOrder={sortOrder} onSort={onSort}
        signalTypeFilter={signalTypeFilter} trackFilter={trackFilter}
        onSignalTypeChange={onSignalTypeChange} onTrackChange={onTrackChange}
      />
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPage={onPage} />}
    </>
  )
}

function SortIcon({ active, order }: { active: boolean; order: SortOrder }) {
  if (!active) return <ArrowUpDown size={11} className="text-muted-foreground/50" />
  return order === 'asc'
    ? <ArrowUp size={11} className="text-primary" />
    : <ArrowDown size={11} className="text-primary" />
}

function ColumnFilterDropdown({
  options, value, onChange, label,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded p-0.5 transition-colors hover:bg-muted ${value ? 'text-primary' : 'text-muted-foreground/50'}`}
        aria-label={label}
      >
        <Filter size={10} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[120px] rounded-lg border border-border bg-card p-1 shadow-lg">
          <button
            onClick={() => { onChange(''); setOpen(false) }}
            className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${!value ? 'font-medium text-primary' : 'text-foreground'}`}
          >
            All
          </button>
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${value === opt.value ? 'font-medium text-primary' : 'text-foreground'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const SIGNAL_TYPE_OPTIONS = Object.entries(SIGNAL_LABELS).map(([v, l]) => ({ value: v, label: l }))
const TRACK_OPTIONS = Object.entries(TRACK_BADGE).map(([v]) => ({ value: v, label: v }))

function SignalTable({
  observations, isZh, t, sortBy, sortOrder, onSort,
  signalTypeFilter, trackFilter, onSignalTypeChange, onTrackChange,
}: {
  observations: Array<Record<string, unknown>>
  isZh: boolean
  t: (key: string) => string
  sortBy: SortKey; sortOrder: SortOrder; onSort: (key: SortKey) => void
  signalTypeFilter: string; trackFilter: string
  onSignalTypeChange: (v: string) => void; onTrackChange: (v: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-muted-foreground">
            <th className="px-3 py-2.5 text-left font-medium">
              <button type="button" onClick={() => onSort('code')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
                <span>{t('common.code')}</span>
                <SortIcon active={sortBy === 'code'} order={sortOrder} />
              </button>
            </th>
            <th className="px-3 py-2.5 text-left font-medium">{t('common.name')}</th>
            <th className="px-3 py-2.5 text-left font-medium">
              <div className="inline-flex items-center gap-1">
                <button type="button" onClick={() => onSort('signal_type')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
                  <span>{t('signal.type')}</span>
                  <SortIcon active={sortBy === 'signal_type'} order={sortOrder} />
                </button>
                <ColumnFilterDropdown
                  options={SIGNAL_TYPE_OPTIONS}
                  value={signalTypeFilter}
                  onChange={onSignalTypeChange}
                  label={isZh ? '筛选信号类型' : 'Filter signal type'}
                />
              </div>
            </th>
            <th className="px-3 py-2.5 text-left font-medium">
              <div className="inline-flex items-center gap-1">
                <button type="button" onClick={() => onSort('track')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
                  <span>{t('signal.track')}</span>
                  <SortIcon active={sortBy === 'track'} order={sortOrder} />
                </button>
                <ColumnFilterDropdown
                  options={TRACK_OPTIONS}
                  value={trackFilter}
                  onChange={onTrackChange}
                  label={isZh ? '筛选跟踪阶段' : 'Filter track'}
                />
              </div>
            </th>
            <th className="px-3 py-2.5 text-right font-medium">
              <button type="button" onClick={() => onSort('trigger_score')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
                <span>{t('signal.score')}</span>
                <SortIcon active={sortBy === 'trigger_score'} order={sortOrder} />
              </button>
            </th>
            <th className="px-3 py-2.5 text-left font-medium">
              <button type="button" onClick={() => onSort('trade_date')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
                <span>{t('signal.date')}</span>
                <SortIcon active={sortBy === 'trade_date'} order={sortOrder} />
              </button>
            </th>
            <th className="px-3 py-2.5 text-center font-medium">
              <button type="button" onClick={() => onSort('lifecycle_status')} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
                <span>{t('signal.status')}</span>
                <SortIcon active={sortBy === 'lifecycle_status'} order={sortOrder} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {observations.map((obs, i) => (
            <SignalRow key={obs.id != null ? String(obs.id) : `${i}`} obs={obs} isZh={isZh} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SignalRow({ obs, isZh }: { obs: Record<string, unknown>; isZh: boolean }) {
  const signalType = String(obs.signal_type || '')
  const track = String(obs.track || '')
  const status = String(obs.lifecycle_status || '')
  return (
    <tr className="border-b border-border/50 transition-colors hover:bg-muted/20">
      <td className="px-3 py-2.5 font-mono font-medium tabular-nums">
        {String(obs.code || '')}
      </td>
      <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[120px]">
        {String(obs.name || '-')}
      </td>
      <td className="px-3 py-2.5 font-medium">
        {isZh ? (SIGNAL_LABELS[signalType] ?? signalType) : signalType}
      </td>
      <td className="px-3 py-2.5">
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TRACK_BADGE[track] || 'bg-muted text-muted-foreground'}`}>
          {track || '-'}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
        {typeof obs.trigger_score === 'number' ? obs.trigger_score.toFixed(2) : '-'}
      </td>
      <td className="px-3 py-2.5 text-muted-foreground tabular-nums">
        {String(obs.trade_date || '-')}
      </td>
      <td className="px-3 py-2.5 text-center">
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[status] || 'bg-muted text-muted-foreground'}`}>
          {status || '-'}
        </span>
      </td>
    </tr>
  )
}

function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  return (
    <div className="mt-3 flex items-center justify-center gap-3 text-xs text-muted-foreground">
      <button
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-muted disabled:opacity-30"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="tabular-nums">{page + 1} / {totalPages}</span>
      <button
        disabled={page >= totalPages - 1}
        onClick={() => onPage(page + 1)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-muted disabled:opacity-30"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

function EmptyState({ isZh: _isZh, t }: { isZh: boolean; t: (key: string) => string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-12 text-center">
      <Activity size={40} className="mx-auto mb-3 opacity-20" />
      <p className="text-sm font-medium text-muted-foreground">{t('signal.empty')}</p>
      <p className="mt-1 text-xs text-muted-foreground/70">{t('signal.emptyHint')}</p>
    </div>
  )
}
