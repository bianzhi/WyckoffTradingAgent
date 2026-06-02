/**
 * Phase 1.2 — 实时行情客户端 Hook
 *
 * 通过 WebSocket 连接 CF Worker，获取自选股分钟级行情推送。
 * 自动重连（指数退避），WebSocket 不可用时降级到 Supabase 轮询。
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { supabase } from './supabase'

export interface QuoteData {
  symbol: string
  price: number
  changePct: number
  volume: number
  timestamp: string
}

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'polling' | 'error' | 'closed'

interface UseRealtimeQuotesOptions {
  symbols: string[]
  wsUrl?: string
  enabled?: boolean
}

const DEFAULT_WS_URL = (() => {
  if (typeof window === 'undefined') return ''
  const isDev = window.location.hostname === 'localhost'
  if (isDev) return 'ws://localhost:8787/api/realtime/watchlist'
  const apiBase = import.meta.env.VITE_API_URL
  if (apiBase) {
    const wsScheme = apiBase.startsWith('https') ? 'wss' : 'ws'
    return `${wsScheme}://${new URL(apiBase).host}/api/realtime/watchlist`
  }
  // Self-hosted: derive from current host (nginx proxies both REST + WebSocket)
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/api/realtime/watchlist`
})()

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000
const MAX_RETRIES = 5
const POLL_INTERVAL_MS = 120_000

// ─── useWebSocket ────────────────────────────────────────────────────────────

type WsStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed'

function useWebSocket(
  wsUrl: string,
  enabled: boolean,
  symbolsRef: React.MutableRefObject<string[]>,
): { quotes: Map<string, QuoteData>; status: WsStatus; failed: boolean } {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map())
  const [status, setStatus] = useState<WsStatus>('closed')
  const [failed, setFailed] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
  }, [])

  const connectWs = useCallback(() => {
    if (!wsUrl || !enabled) return
    setStatus('connecting')
    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('connected')
        setFailed(false)
        reconnectAttemptRef.current = 0
        ws.send(JSON.stringify({ type: 'watchlist', symbols: symbolsRef.current }))
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'tick' && Array.isArray(msg.data)) {
            setQuotes((prev) => {
              const next = new Map(prev)
              for (const q of msg.data as QuoteData[]) {
                next.set(q.symbol, q)
              }
              return next
            })
          }
        } catch { /* ignore */ }
      }

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null
          reconnect()
        }
      }

      ws.onerror = () => ws.close()
    } catch {
      setFailed(true)
    }
  }, [wsUrl, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const reconnect = useCallback(() => {
    const attempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = attempt
    if (attempt > MAX_RETRIES) {
      setFailed(true)
      setStatus('closed')
      return
    }
    setStatus('reconnecting')
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS)
    timerRef.current = setTimeout(() => connectWs(), delay)
  }, [connectWs])

  const updateWatchlist = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'watchlist', symbols: symbolsRef.current }))
    }
  }, [])

  // Connect / disconnect
  useEffect(() => {
    if (!enabled) {
      clearTimers()
      setStatus('closed')
      return
    }
    connectWs()
    return () => clearTimers()
  }, [enabled, connectWs, clearTimers])

  // Update watchlist when symbols change
  useEffect(() => {
    updateWatchlist()
  }, [symbolsRef.current, updateWatchlist])

  return { quotes, status, failed }
}

// ─── useFallbackPoll ─────────────────────────────────────────────────────────

function useFallbackPoll(enabled: boolean): {
  quotes: Map<string, QuoteData>
  status: 'polling'
} {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('market_signal_daily')
        .select('*')
        .order('trade_date', { ascending: false })
        .limit(1)

      if (data?.[0]) {
        const row = data[0]
        const mainClose = Number(row.main_index_close || 0)
        if (mainClose > 0) {
          setQuotes((prev) => {
            const next = new Map(prev)
            next.set('000001.SH', {
              symbol: '000001.SH',
              price: mainClose,
              changePct: Number(row.main_index_today_pct || 0),
              volume: 0,
              timestamp: String(row.trade_date || ''),
            })
            return next
          })
        }
      }
    } catch { /* polling failed silently */ }
  }, [])

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      return
    }
    poll()
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
  }, [enabled, poll])

  return { quotes, status: 'polling' }
}

// ─── useRealtimeQuotes (public API) ─────────────────────────────────────────

export function useRealtimeQuotes({ symbols, wsUrl = DEFAULT_WS_URL, enabled = true }: UseRealtimeQuotesOptions) {
  const symbolsRef = useRef(symbols)
  symbolsRef.current = symbols

  const ws = useWebSocket(wsUrl, enabled, symbolsRef)
  const poll = useFallbackPoll(enabled && ws.failed)

  // Merge quotes: WebSocket data overrides polling data
  const quotes = useMemo(() => {
    const merged = new Map(poll.quotes)
    for (const [k, v] of ws.quotes) {
      merged.set(k, v)
    }
    return merged
  }, [ws.quotes, poll.quotes])

  // Determine combined connection status
  const status: ConnectionStatus = useMemo(() => {
    if (!enabled) return 'closed'
    if (ws.failed) return 'polling'
    return ws.status === 'closed' ? 'connecting' : ws.status
  }, [enabled, ws.failed, ws.status])

  return { quotes, status }
}
