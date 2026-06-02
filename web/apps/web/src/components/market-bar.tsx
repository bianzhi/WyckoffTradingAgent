import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useRealtimeQuotes, type ConnectionStatus } from '@/lib/realtime-quotes'
import { usePreferences, type TranslationKey } from '@/lib/preferences'
import { relativeTime, formatDate, type TimeLocale } from '@/lib/relative-time'

interface MarketSignal {
  benchmark_regime: string
  banner_title: string
  banner_message: string
  banner_tone: string
  main_index_close: number
  main_index_today_pct: number
  main_index_date: string
  a50_close: number
  a50_pct_chg: number
  a50_date: string
  vix_close: number
  vix_pct_chg: number
  vix_date: string
}

const REGIME_COLORS: Record<string, { className: string; labelKey: TranslationKey }> = {
  RISK_ON: { className: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200', labelKey: 'market.riskOn' },
  NEUTRAL: { className: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200', labelKey: 'market.neutral' },
  RISK_OFF: { className: 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-200', labelKey: 'market.riskOff' },
  CRASH: { className: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-200', labelKey: 'market.crash' },
  BLACK_SWAN: { className: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-100', labelKey: 'market.blackSwan' },
}

const TONE_META: Record<string, { className: string; labelKey: TranslationKey }> = {
  '乐观': { className: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-200', labelKey: 'market.optimistic' },
  '谨慎乐观': { className: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-200', labelKey: 'market.cautiouslyOptimistic' },
  '谨慎': { className: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200', labelKey: 'market.cautious' },
  '保守': { className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200', labelKey: 'market.defensive' },
  '恶劣': { className: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200', labelKey: 'market.blackSwan' },
}

function mergeRows(data: Record<string, unknown>[]): { merged: Record<string, unknown>; mainDate: string; a50Date: string; vixDate: string } {
  const merged: Record<string, unknown> = {}
  let mainDate = '', a50Date = '', vixDate = ''
  for (const row of data) {
    for (const key of ['benchmark_regime', 'main_index_close', 'main_index_today_pct', 'main_index_ma50', 'main_index_ma200']) {
      if (merged[key] == null && row[key] != null) {
        merged[key] = row[key]
        if (key === 'main_index_close') mainDate = (row.trade_date as string) || ''
      }
    }
    for (const key of ['a50_close', 'a50_pct_chg']) {
      if (merged[key] == null && row[key] != null) {
        merged[key] = row[key]
        if (key === 'a50_close' && !a50Date) a50Date = (row.a50_value_date as string) || (row.trade_date as string) || ''
      }
    }
    for (const key of ['vix_close', 'vix_pct_chg']) {
      if (merged[key] == null && row[key] != null) {
        merged[key] = row[key]
        if (key === 'vix_close' && !vixDate) vixDate = (row.vix_value_date as string) || (row.trade_date as string) || ''
      }
    }
    for (const key of ['banner_title', 'banner_message', 'banner_tone']) {
      if (!merged[key] && row[key]) merged[key] = row[key]
    }
  }
  return { merged, mainDate, a50Date, vixDate }
}

async function fetchSignal(): Promise<MarketSignal | null> {
  const { data } = await supabase
    .from('market_signal_daily')
    .select('*')
    .order('trade_date', { ascending: false })
    .limit(5)

  if (!data || data.length === 0) return null

  const { merged, mainDate, a50Date, vixDate } = mergeRows(data)

  return {
    benchmark_regime: String(merged.benchmark_regime || 'NEUTRAL'),
    banner_title: String(merged.banner_title || ''),
    banner_message: String(merged.banner_message || ''),
    banner_tone: String(merged.banner_tone || '谨慎'),
    main_index_close: Number(merged.main_index_close || 0),
    main_index_today_pct: Number(merged.main_index_today_pct || 0),
    main_index_date: mainDate,
    a50_close: Number(merged.a50_close || 0),
    a50_pct_chg: Number(merged.a50_pct_chg || 0),
    a50_date: a50Date,
    vix_close: Number(merged.vix_close || 0),
    vix_pct_chg: Number(merged.vix_pct_chg || 0),
    vix_date: vixDate,
  }
}

function LivePrice({ price, pct, symbol }: { price: number; pct: number; symbol: string }) {
  const fmtPct = (v: number) => v ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '--'
  return (
    <>
      <span className="text-sm font-medium tabular-nums">{price.toFixed(symbol === 'vix' ? 1 : 0)}</span>
      <span className={`text-xs font-medium tabular-nums ${pct >= 0 ? 'text-up' : 'text-down'}`}>
        {fmtPct(pct)}
      </span>
      <span className="text-[9px] bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 px-1 py-0.5 rounded animate-pulse">⚡ LIVE</span>
    </>
  )
}

const WS_LABEL: Record<ConnectionStatus, string> = {
  connecting: '🔄',
  connected: '🟢',
  reconnecting: '🔄',
  polling: '📡',
  error: '🔴',
  closed: '⏸️',
}

export function MarketBar() {
  const { t, locale } = usePreferences()
  const { data: signal } = useQuery({
    queryKey: ['market-signal'],
    queryFn: fetchSignal,
    refetchInterval: 60_000,
  })

  const { quotes: rtQuotes, status: wsStatus } = useRealtimeQuotes({
    symbols: ['000001.SH', '399001.SZ', '399006.SZ', '000688.SH'],
    enabled: true,
  })

  if (!signal) return null

  const regime = REGIME_COLORS[signal.benchmark_regime] || REGIME_COLORS.NEUTRAL!
  const tone = TONE_META[signal.banner_tone] || TONE_META['谨慎']!

  const fmtPct = (v: number) => v ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '--'
  const fmtDate = (d: string) => formatDate(d, locale as TimeLocale) || d?.slice(5).replace('-', '/')
  const dt = signal.main_index_date || signal.a50_date || signal.vix_date
  const relTime = relativeTime(dt, locale)

  // Merge live quotes into display: WebSocket data overrides Supabase snapshots
  const mainQuote = rtQuotes.get('000001.SH')
  const isLive = !!mainQuote && wsStatus === 'connected'

  const mainPrice = isLive ? mainQuote.price : signal.main_index_close
  const mainPct = isLive ? mainQuote.changePct : signal.main_index_today_pct

  return (
    <div className="border-b border-border bg-background px-6 py-2.5">
      <div className="flex flex-wrap items-center gap-4">
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone.className}`}>
          {t(tone.labelKey)}
        </span>

        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${regime.className}`}>
          {t(regime.labelKey)}
        </span>

        {signal.main_index_close > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t('market.mainIndex')}</span>
            {isLive ? (
              <LivePrice price={mainPrice} pct={mainPct} symbol="index" />
            ) : (
              <>
                <span className="text-sm font-medium">{signal.main_index_close.toFixed(0)}</span>
                <span className={`text-xs font-medium ${signal.main_index_today_pct >= 0 ? 'text-up' : 'text-down'}`}>
                  {fmtPct(signal.main_index_today_pct)}
                </span>
                {signal.main_index_date && <span className="text-[10px] text-muted-foreground">{fmtDate(signal.main_index_date)}</span>}
                <span className="text-xs" title={`WebSocket: ${wsStatus}`}>{WS_LABEL[wsStatus] || '🔌'}</span>
              </>
            )}
          </div>
        )}

        {signal.a50_close > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">A50</span>
            <span className="text-xs font-medium">{signal.a50_close.toFixed(0)}</span>
            <span className={`text-xs font-medium ${signal.a50_pct_chg >= 0 ? 'text-up' : 'text-down'}`}>
              {fmtPct(signal.a50_pct_chg)}
            </span>
            {signal.a50_date && <span className="text-[10px] text-muted-foreground">{fmtDate(signal.a50_date)}</span>}
          </div>
        )}

        {signal.vix_close > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">VIX</span>
            <span className="text-xs font-medium">{signal.vix_close.toFixed(1)}</span>
            <span className={`text-xs font-medium ${signal.vix_pct_chg <= 0 ? 'text-up' : 'text-down'}`}>
              {fmtPct(signal.vix_pct_chg)}
            </span>
            {signal.vix_date && <span className="text-[10px] text-muted-foreground">{fmtDate(signal.vix_date)}</span>}
          </div>
        )}

        {signal.banner_title && (
          <span className="ml-auto text-xs font-medium text-foreground">{signal.banner_title}</span>
        )}

        {relTime && (
          <span className="text-[10px] text-muted-foreground/60" title={dt}>{relTime}</span>
        )}

        {/* Connection status shown in main row only when NOT live (live mode has its own indicator) */}
        {!isLive && (
          <span className="text-xs" title={`WebSocket: ${wsStatus}`}>{WS_LABEL[wsStatus] || '🔌'}</span>
        )}
      </div>

      {/* Realtime ticker: show non-main-index symbols */}
      {rtQuotes.size > 0 && (
        <div className="mt-1 flex flex-wrap gap-3 border-t border-border/30 pt-1">
          {Array.from(rtQuotes.values())
            .filter((q) => q.symbol !== '000001.SH')
            .map((q) => (
              <span key={q.symbol} className="text-[11px]">
                <span className="text-muted-foreground">{q.symbol.replace(/\.(SH|SZ)$/, '')}</span>{' '}
                <span className="font-medium tabular-nums">{q.price.toFixed(2)}</span>{' '}
                <span className={q.changePct >= 0 ? 'text-up' : 'text-down'}>
                  {q.changePct >= 0 ? '+' : ''}{q.changePct.toFixed(2)}%
                </span>
              </span>
            ))}
        </div>
      )}

      {signal.banner_message && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{signal.banner_message}</p>
      )}
    </div>
  )
}
