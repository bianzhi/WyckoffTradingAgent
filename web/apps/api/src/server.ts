import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { chatRoutes } from './routes/chat'
import { dataRoutes } from './routes/data'
import { funnelRoutes } from './routes/funnel'
import { portfolioRoutes } from './routes/portfolio'
import { settingsRoutes } from './routes/settings'
import { llmProxyRoutes } from './routes/llm-proxy'
import { realtimeRoutes } from './routes/realtime'
import { authMiddleware } from './middleware/auth'

const app = new Hono()

// Load env vars as if they were Cloudflare bindings
// (the auth middleware reads SUPABASE_URL / SUPABASE_ANON_KEY from env)
Object.assign(app, {
  env: {
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
  },
})

// Monkey-patch: authMiddleware uses c.env which maps to Mini's getter.
// Hono on Node doesn't have the same bindings mechanism, so we provide
// env vars on every request context via a tiny middleware.
app.use('*', async (c, next) => {
  // Mirror CF Worker bindings so routes using c.env work unchanged
  const bindings = {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(c as any).env = bindings
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

console.log(`🚀 Wyckoff API listening on http://0.0.0.0:${port}`)
serve({ fetch: app.fetch, port })
