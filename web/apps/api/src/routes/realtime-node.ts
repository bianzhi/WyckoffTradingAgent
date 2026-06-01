/**
 * Phase 1.2 — 实时行情 WebSocket 端点 / Node.js 版本
 *
 * 使用 ws 包替代 Cloudflare Workers 的 upgradeWebSocket。
 * server.ts 负责 HTTP Upgrade 路由，此模块导出连接处理函数。
 */

import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'

const TICKFLOW_MINUTE_URL = 'https://api.tickflow.org/v1/minute'
const POLL_INTERVAL_MS = 60_000
const TRADING_START_H = 9
const TRADING_START_M = 30
const TRADING_END_H = 15
const TRADING_END_M = 0

export const WATCHLIST_PATH = '/api/realtime/watchlist'

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

/**
 * 处理单个 WebSocket 连接（由 server.ts 在 /api/realtime/watchlist 路径上调用）。
 */
export function handleWatchlistConnection(ws: WebSocket, _req: IncomingMessage): void {
  const apiKey = process.env.SYSTEM_TICKFLOW_API_KEY || ''
  let symbols: string[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let closed = false

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

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as WsMessageIn
      if (msg.type === 'watchlist' && Array.isArray(msg.symbols)) {
        symbols = msg.symbols.filter((s) => typeof s === 'string' && s.length > 0)
      }
    } catch {
      // ignore malformed messages
    }
  })

  ws.on('close', () => {
    closed = true
    if (timer) clearInterval(timer)
    timer = null
  })

  ws.on('error', () => {
    closed = true
    if (timer) clearInterval(timer)
    timer = null
  })
}
