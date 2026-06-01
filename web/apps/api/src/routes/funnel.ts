/**
 * Wyckoff API — Funnel trigger proxy
 *
 * Forwards funnel requests to the Agent container (Python),
 * which runs run_funnel_job() and persists results to Supabase.
 */
import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'

const AGENT_URL = process.env.AGENT_URL || 'http://agent:8080'

const funnelRoutes = new Hono()
funnelRoutes.use('*', authMiddleware)

// POST /api/funnel/trigger — 发起漏斗筛选
funnelRoutes.post('/trigger', async (c) => {
  try {
    const resp = await fetch(`${AGENT_URL}/api/funnel/run`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000), // 10s connect timeout (agent returns immediately)
    })

    const body = await resp.json() as Record<string, unknown>
    const status = resp.ok ? 200 : resp.status

    return c.json(body, status as 200 | 409)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ ok: false, error: msg }, 502)
  }
})

// GET /api/funnel/status — 查询漏斗状态
funnelRoutes.get('/status', async (c) => {
  try {
    const resp = await fetch(`${AGENT_URL}/api/funnel/status`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = await resp.json() as Record<string, unknown>
    return c.json(body)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ status: 'unknown', error: msg }, 502)
  }
})

export { funnelRoutes }
