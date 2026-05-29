import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { chatRoutes } from './routes/chat'
import { dataRoutes } from './routes/data'
import { portfolioRoutes } from './routes/portfolio'
import { settingsRoutes } from './routes/settings'
import { llmProxyRoutes } from './routes/llm-proxy'
import { realtimeRoutes } from './routes/realtime'

export type Env = {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string
  TICKFLOW_API_BASE: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: ['http://localhost:5173', 'https://wyckoff.pages.dev'],
  credentials: true,
}))

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.route('/api/chat', chatRoutes)
app.route('/api/data', dataRoutes)
app.route('/api/portfolio', portfolioRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/llm-proxy', llmProxyRoutes)
app.route('/api/realtime', realtimeRoutes)

export default app
