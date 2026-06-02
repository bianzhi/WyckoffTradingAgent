import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, ChevronLeft, ChevronRight } from 'lucide-react'
import { usePreferences } from '@/lib/preferences'
import { useDocTitle } from '@/components/ux/doc-title'
import { Breadcrumb } from '@/components/ux/breadcrumb'
import { ScrollToTop } from '@/components/ux/scroll-top'
import { SkeletonTable } from '@/components/ux/skeleton'
import { dataSkill } from '@/lib/data-skill'

const STATUS_TABS = ['all', 'active', 'confirmed', 'expired'] as const
type StatusFilter = (typeof STATUS_TABS)[number]

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

  const { data, isLoading, error } = useQuery({
    queryKey: ['signal-observations', filter, page],
    queryFn: () => dataSkill.fetchSignalObservations(filter, PAGE_SIZE, page * PAGE_SIZE),
    staleTime: 120_000,
    retry: 1,
  })

  const observations = data?.observations ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const breadcrumbItems = [{ label: isZh ? '信号池' : 'Signals' }]

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
      </header>

      {/* Filter tabs */}
      <nav className="mb-4 flex gap-1 overflow-x-auto">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => { setFilter(tab); setPage(0) }}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              filter === tab
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {t(`signal.${tab}`)}
          </button>
        ))}
      </nav>

      {/* Content */}
      {isLoading ? (
        <SkeletonTable rows={8} cols={7} />
      ) : error ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
          <Activity size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">{String(error)}</p>
        </div>
      ) : observations.length === 0 ? (
        <EmptyState isZh={isZh} t={t} />
      ) : (
        <>
          <SignalTable observations={observations} isZh={isZh} t={t} />
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} onPage={setPage} />
          )}
        </>
      )}
    </div>
  )
}

function SignalTable({
  observations, isZh, t,
}: {
  observations: Array<Record<string, unknown>>
  isZh: boolean
  t: (key: string) => string
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-muted-foreground">
            <th className="px-3 py-2.5 text-left font-medium">{t('common.code')}</th>
            <th className="px-3 py-2.5 text-left font-medium">{t('common.name')}</th>
            <th className="px-3 py-2.5 text-left font-medium">{t('signal.type')}</th>
            <th className="px-3 py-2.5 text-left font-medium">{t('signal.track')}</th>
            <th className="px-3 py-2.5 text-right font-medium">{t('signal.score')}</th>
            <th className="px-3 py-2.5 text-left font-medium">{t('signal.date')}</th>
            <th className="px-3 py-2.5 text-center font-medium">{t('signal.status')}</th>
          </tr>
        </thead>
        <tbody>
          {observations.map((obs, i) => {
            const signalType = String(obs.signal_type || '')
            const track = String(obs.track || '')
            const status = String(obs.lifecycle_status || '')
            return (
              <tr
                key={obs.id != null ? String(obs.id) : `${i}`}
                className="border-b border-border/50 transition-colors hover:bg-muted/20"
              >
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
          })}
        </tbody>
      </table>
    </div>
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

function EmptyState({ isZh, t }: { isZh: boolean; t: (key: string) => string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-12 text-center">
      <Activity size={40} className="mx-auto mb-3 opacity-20" />
      <p className="text-sm font-medium text-muted-foreground">{t('signal.empty')}</p>
      <p className="mt-1 text-xs text-muted-foreground/70">{t('signal.emptyHint')}</p>
    </div>
  )
}
