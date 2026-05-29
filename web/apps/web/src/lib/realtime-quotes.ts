/**
 * Phase 1.2 — 实时行情客户端 Hook
 *
 * 通过 WebSocket 连接 CF Worker，获取自选股分钟级行情推送。
 * 自动重连（指数退避），WebSocket 不可用时降级到 Supabase 轮询。
 */

import { useEffect, useRef, useState, useCallback } from 'react'
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
  return isDev
    ? 'ws://localhost:8787/api/realtime/watchlist'
    : 'wss://wyckoff-api.your-username.workers.dev/api/realtime/watchlist'
})()

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000
const POLL_INTERVAL_MS = 120_000

export function useRealtimeQuotes({ symbols, wsUrl = DEFAULT_WS_URL, enabled = true }: UseRealtimeQuotesOptions) {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map())
  const [status, setStatus] = useState<ConnectionStatus>('closed')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const symbolsRef = useRef(symbols)
  symbolsRef.current = symbols

  const clearTimers = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
  }, [])

  // WebSocket connection
  const connect = useCallback(() => {
    if (!wsUrl || !enabled) return
    setStatus('connecting')

    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('connected')
        reconnectAttemptRef.current = 0
        // Send current watchlist
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
        } catch {
          // ignore
        }
      }

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null
          reconnect()
        }
      }

      ws.onerror = () => {
        ws.close()
      }
    } catch {
      // WebSocket not available, fall back to polling
      startPolling()
    }
  }, [wsUrl, enabled])

  const reconnect = useCallback(() => {
    const attempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = attempt
    setStatus('reconnecting')

    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS)
    timerRef.current = setTimeout(() => {
      connect()
    }, delay)
  }, [connect])

  const startPolling = useCallback(() => {
    setStatus('polling')
    const poll = async () => {
      try {
        const syms = symbolsRef.current
        if (syms.length === 0) return

        const { data } = await supabase
          .from('market_signal_daily')
          .select('*')
          .order('trade_date', { ascending: false })
          .limit(1)

        if (data?.[0]) {
          const row = data[0]
          // Only update if we have meaningful data
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
      } catch {
        // polling failed silently
      }
    }

    poll()
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS)
  }, [])

  // Main effect
  useEffect(() => {
    if (!enabled) {
      clearTimers()
      setStatus('closed')
      return
    }

    connect()

    return () => {
      clearTimers()
    }
  }, [enabled, connect, clearTimers])

  // Update watchlist on websocket
  useEffect(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'watchlist', symbols }))
    }
  }, [symbols])

  return { quotes, status }
}
