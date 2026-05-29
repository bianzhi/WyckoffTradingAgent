import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import { adminMiddleware } from '../middleware/admin'
import type { Env } from '../index'

export const settingsRoutes = new Hono<{ Bindings: Env }>()

settingsRoutes.use('*', authMiddleware)

// ── system-config (所有认证用户可读) ──────────────────────
settingsRoutes.get('/system-config', async (c) => {
  const env = (c as any).env || {}
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

  // 从 DB 的 system_settings 表读取，env vars 仅做 fallback
  const { data: rows, error } = await supabase
    .from('system_settings')
    .select('key, value')

  const db: Record<string, string> = {}
  if (!error && rows) {
    for (const r of rows as Array<{ key: string; value: string }>) {
      db[r.key] = r.value || ''
    }
  }

  const get = (key: string, envKey: string) =>
    db[key] || env[envKey] || process.env[envKey] || null

  return c.json({
    llm_provider: get('llm_provider', 'SYSTEM_LLM_PROVIDER') as string | null,
    llm_api_key: get('llm_api_key', 'SYSTEM_LLM_API_KEY') as string | null,
    llm_model: get('llm_model', 'SYSTEM_LLM_MODEL') as string | null,
    llm_base_url: get('llm_base_url', 'SYSTEM_LLM_BASE_URL') as string | null,
    tickflow_api_key: get('tickflow_api_key', 'SYSTEM_TICKFLOW_API_KEY') as string | null,
    tushare_token: get('tushare_token', 'SYSTEM_TUSHARE_TOKEN') as string | null,
  })
})

// ── admin: 获取当前用户角色 ───────────────────────────────
settingsRoutes.get('/role', async (c) => {
  const env = (c as any).env || {}
  const userId = c.get('auth').userId
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

  const { data } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle()

  return c.json({ role: data?.role || 'member' })
})

// ── admin: 读取全部 system_settings ──────────────────────
settingsRoutes.get('/admin', adminMiddleware, async (c) => {
  const env = (c as any).env || {}
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

  const { data: rows, error } = await supabase
    .from('system_settings')
    .select('key, value')

  if (error) return c.json({ error: error.message }, 500)

  const settings: Record<string, string> = {}
  for (const r of rows as Array<{ key: string; value: string }>) {
    settings[r.key] = r.value || ''
  }
  return c.json(settings)
})

// ── admin: 批量更新 system_settings ──────────────────────
settingsRoutes.put('/admin', adminMiddleware, async (c) => {
  const env = (c as any).env || {}
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  const body = await c.req.json()

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'body must be a key→value object' }, 400)
  }

  const entries = Object.entries(body as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')
    .map(([key, value]) => ({ key, value: value as string, updated_at: new Date().toISOString() }))

  if (entries.length === 0) return c.json({ error: 'no valid key/value pairs' }, 400)

  const { error } = await supabase.from('system_settings').upsert(entries)
  if (error) return c.json({ error: error.message }, 500)

  return c.json({ ok: true })
})
