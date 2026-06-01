/**
 * Phase 1.2 — 实时行情 WebSocket 端点 / Cloudflare Workers 版本
 *
 * 使用 upgradeWebSocket()，仅 Cloudflare Workers 运行时支持。
 * index.ts (CF Workers 入口) 使用此文件。
 */

import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/cloudflare-workers'

import type { Env } from '../index'

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
  const apiKey = env.SYSTEM_TICKFLOW_API_KEY || process.env.SYSTEM_TICKFLOW_API_KEY || ''
  let symbols: string[] = []

  return {
    onOpen(_event, ws) {
      // Send initial heartbeat immediately
      ws.send(JSON.stringify({
        type: 'heartbeat',
        ts: new Date().toISOString(),
      }))
    },
    onMessage(event, ws) {
      try {
        const msg = JSON.parse(event.data as string) as WsMessageIn
        if (msg.type === 'watchlist' && Array.isArray(msg.symbols)) {
          symbols = msg.symbols.filter((s) => typeof s === 'string' && s.length > 0)
        }
      } catch {
        // ignore malformed messages
      }
    },
    onClose(_event, _ws) {
      // cleanup handled by CF Workers runtime
    },
    onError(_event, _ws) {
      // cleanup handled by CF Workers runtime
    },
  }
}))

export { realtime as realtimeRoutes }
