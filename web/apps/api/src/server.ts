import { createServer } from 'node:http'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { WebSocketServer } from 'ws'
import { chatRoutes } from './routes/chat'
import { dataRoutes } from './routes/data'
import { funnelRoutes } from './routes/funnel'
import { portfolioRoutes } from './routes/portfolio'
import { settingsRoutes } from './routes/settings'
import { llmProxyRoutes } from './routes/llm-proxy'
import { realtimeRoutes } from './routes/realtime'
import { handleWatchlistConnection, WATCHLIST_PATH } from './routes/realtime-node'
import { authMiddleware } from './middleware/auth'

const app = new Hono()

// Mirror CF Worker bindings so routes using c.env work unchanged
const BINDINGS = {
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  TICKFLOW_API_BASE: process.env.TICKFLOW_API_BASE || '',
  SYSTEM_LLM_PROVIDER: process.env.SYSTEM_LLM_PROVIDER || '',
  SYSTEM_LLM_API_KEY: process.env.SYSTEM_LLM_API_KEY || '',
  SYSTEM_LLM_MODEL: process.env.SYSTEM_LLM_MODEL || '',
  SYSTEM_LLM_BASE_URL: process.env.SYSTEM_LLM_BASE_URL || '',
  SYSTEM_TICKFLOW_API_KEY: process.env.SYSTEM_TICKFLOW_API_KEY || '',
  SYSTEM_TUSHARE_TOKEN: process.env.SYSTEM_TUSHARE_TOKEN || '',
}

app.use('*', async (c, next) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(c as any).env = BINDINGS
  await next()
})

app.use('*', cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:8080',
    'https://wyckoff.pages.dev',
    process.env.CORS_ORIGIN || '',
  ].filter(Boolean),
  credentials: true,
}))

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.route('/api/chat', chatRoutes)
app.route('/api/data', dataRoutes)
app.route('/api/funnel', funnelRoutes)
app.route('/api/portfolio', portfolioRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/llm-proxy', llmProxyRoutes)
app.route('/api/realtime', realtimeRoutes)

const port = parseInt(process.env.PORT || '8787', 10)

// ── WebSocket server (noServer mode → share HTTP port) ──
const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (ws, req) => {
  if (req.url !== WATCHLIST_PATH) {
    ws.close(4000, 'bad path')
    return
  }
  handleWatchlistConnection(ws, req)
})

// ── Combined HTTP server ──
const server = createServer(async (req, res) => {
  try {
    // Build a proper URL object for Hono's request parsing
    const host = req.headers.host || 'localhost'
    const proto = (req.headers['x-forwarded-proto'] as string) || 'http'
    const url = `${proto}://${host}${req.url}`

    const honoReq = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).reduce((h, [k, v]) => {
        if (v != null) (h as Record<string, string>)[k] = Array.isArray(v) ? v.join(', ') : v
        return h
      }, {} as Record<string, string>),
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
      duplex: 'half',
    })

    const honoRes = await app.fetch(honoReq)

    res.writeHead(honoRes.status, Object.fromEntries(honoRes.headers.entries()))
    if (honoRes.body) {
      const reader = honoRes.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    }
    res.end()
  } catch (err) {
    console.error('api: request error:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
})

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url!, `http://${req.headers.host}`)
  if (pathname === WATCHLIST_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

console.log(`🚀 Wyckoff API listening on http://0.0.0.0:${port}`)
server.listen(port)
