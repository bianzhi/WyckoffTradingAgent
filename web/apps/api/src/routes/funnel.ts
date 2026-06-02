/**
 * Wyckoff API — Funnel trigger proxy
 *
 * Forwards funnel requests to the Agent container (Python),
 * which runs run_funnel_job() and persists results to Supabase.
 */
import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'

const AGENT_URL = process.env.AGENT_URL || 'http://agent:8080'

function classifyFetchError(err: unknown): { msg: string; detail: string } {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()
  if (lower.includes('econnrefused') || lower.includes('connection refused')) {
    return {
      msg: 'Agent 容器未运行或端口未监听',
      detail: `${AGENT_URL} 拒绝连接 — 请检查 wyckoff-agent 容器状态 (docker ps | grep agent)`,
    }
  }
  if (lower.includes('enotfound') || lower.includes('dns') || lower.includes('resolve')) {
    return {
      msg: 'Agent 容器 DNS 解析失败',
      detail: `无法解析 ${AGENT_URL} — 请确认 agent 服务在 docker-compose 网络中`,
    }
  }
  if (lower.includes('timeout') || lower.includes('abort')) {
    return {
      msg: `连接 ${AGENT_URL} 超时 (10s)`,
      detail: 'Agent 容器可能在运行但响应过慢，请检查 agent 日志 (docker logs wyckoff-agent)',
    }
  }
  return { msg: raw, detail: `请求 ${AGENT_URL} 失败` }
}

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
    const { msg, detail } = classifyFetchError(err)
    return c.json({ ok: false, error: msg, detail, agent_url: AGENT_URL }, 502)
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
    const { msg, detail } = classifyFetchError(err)
    return c.json({ status: 'unknown', error: msg, detail, agent_url: AGENT_URL }, 502)
  }
})

// GET /api/funnel/result — 获取漏斗完整结果
funnelRoutes.get('/result', async (c) => {
  try {
    const resp = await fetch(`${AGENT_URL}/api/funnel/result`, {
      signal: AbortSignal.timeout(10_000),
    })
    const body = await resp.json() as Record<string, unknown>
    return c.json(body)
  } catch (err) {
    const { msg, detail } = classifyFetchError(err)
    return c.json({ ok: false, error: msg, detail, agent_url: AGENT_URL }, 502)
  }
})

// GET /api/funnel/report — 获取漏斗 HTML 报告
funnelRoutes.get('/report', async (c) => {
  try {
    const resp = await fetch(`${AGENT_URL}/api/funnel/report`, {
      signal: AbortSignal.timeout(10_000),
    })
    const html = await resp.text()
    return c.html(html)
  } catch (err) {
    const { msg, detail } = classifyFetchError(err)
    return c.json({ ok: false, error: msg, detail, agent_url: AGENT_URL }, 502)
  }
})

// GET /api/funnel/agent-health — Agent 可达性诊断
funnelRoutes.get('/agent-health', async (c) => {
  const result: Record<string, unknown> = { agent_url: AGENT_URL }
  try {
    const resp = await fetch(`${AGENT_URL}/api/funnel/status`, {
      signal: AbortSignal.timeout(5_000),
    })
    result.reachable = true
    result.agent_status = resp.status
    if (resp.ok) {
      const body = await resp.json() as Record<string, unknown>
      result.agent_response = body
    }
    return c.json(result)
  } catch (err) {
    const { msg, detail } = classifyFetchError(err)
    result.reachable = false
    result.error = msg
    result.detail = detail
    return c.json(result, 502)
  }
})

export { funnelRoutes }
