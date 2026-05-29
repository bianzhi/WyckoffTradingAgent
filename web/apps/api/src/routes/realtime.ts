/**
 * Phase 1.2 — 实时行情 WebSocket 端点
 *
 * 客户端通过 WS 连接推送自选股列表，服务端每 60s 轮询 TickFlow 分钟线，
 * 将最新价/涨跌幅推送给客户端。A 股交易时段 (9:30-15:00) 延迟 < 5s。
 *
 * 回退：TickFlow 不可用时推送空数据，客户端自行降级到 Supabase 轮询。
 */

import type { Env } from '../index'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/cloudflare-workers'

const TICKFLOW_MINUTE_URL = 'https://api.tickflow.org/v1/minute'
const POLL_INTERVAL_MS = 60_000
const TRADING_START_H = 9
const TRADING_START_M = 30
const TRADING_END_H = 15
const TRADING_END_M = 0

interface MinuteQuote {
  symbol: string
  price: number
  change_pct: number
  volume: number
  timestamp: string
}

interface WsMessageIn {
  type: 'watchlist'
  symbols: string[]
}

interface WsMessageOut {
  type: 'tick' | 'error' | 'heartbeat'
  data?: MinuteQuote[]
  error?: string
  ts: string
}

function isTradingHour(): boolean {
  const now = new Date()
  const cnTime = new Date(now.getTime() + 8 * 3600_000)
  const day = cnTime.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = cnTime.getUTCHours() * 60 + cnTime.getUTCMinutes()
  return minutes >= TRADING_START_H * 60 + TRADING_START_M &&
         minutes < TRADING_END_H * 60 + TRADING_END_M
}

async function fetchMinuteQuotes(symbols: string[], apiKey: string): Promise<MinuteQuote[]> {
  if (!apiKey || symbols.length === 0) return []

  try {
    const resp = await fetch(`${TICKFLOW_MINUTE_URL}?symbols=${symbols.join(',')}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!resp.ok) return []
    const json = await resp.json() as { data?: Record<string, { price: number; change_pct: number; volume: number; timestamp: string }> }
    if (!json.data) return []

    return Object.entries(json.data).map(([symbol, row]) => ({
      symbol,
      price: row.price ?? 0,
      change_pct: row.change_pct ?? 0,
      volume: row.volume ?? 0,
      timestamp: row.timestamp ?? new Date().toISOString(),
    }))
  } catch {
    return []
  }
}

const realtime = new Hono<{ Bindings: Env }>()

realtime.get('/watchlist', upgradeWebSocket((c) => {
  const env = c.env
  const apiKey = env.TICKFLOW_API_BASE || ''
  let symbols: string[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let closed = false

  return {
    onMessage(event) {
      try {
        const msg = JSON.parse(event.data as string) as WsMessageIn
        if (msg.type === 'watchlist' && Array.isArray(msg.symbols)) {
          symbols = msg.symbols.filter((s) => typeof s === 'string' && s.length > 0)
        }
      } catch {
        // ignore malformed messages
      }
    },

    async onOpen(_event, ws) {
      // Send initial heartbeat
      ws.send(JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() } satisfies WsMessageOut))

      timer = setInterval(async () => {
        if (closed) return
        try {
          if (symbols.length > 0 && isTradingHour()) {
            const quotes = await fetchMinuteQuotes(symbols, apiKey)
            ws.send(JSON.stringify({ type: 'tick', data: quotes, ts: new Date().toISOString() } satisfies WsMessageOut))
          } else {
            ws.send(JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() } satisfies WsMessageOut))
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: String(err), ts: new Date().toISOString() } satisfies WsMessageOut))
        }
      }, POLL_INTERVAL_MS)
    },

    onClose() {
      closed = true
      if (timer) clearInterval(timer)
    },

    onError(_event) {
      closed = true
      if (timer) clearInterval(timer)
    },
  }
}))

export { realtime as realtimeRoutes }
