import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import type { Env } from '../index'

export const settingsRoutes = new Hono<{ Bindings: Env }>()

settingsRoutes.use('*', authMiddleware)

settingsRoutes.get('/', async (c) => {
  // Phase 2: load user settings
  return c.json({ message: 'Settings endpoint - Phase 2' })
})

settingsRoutes.put('/', async (c) => {
  // Phase 2: save user settings
  return c.json({ message: 'Settings save endpoint - Phase 2' })
})

// GET /api/settings/system-config — authenticated, returns system defaults
// (including API keys) so users without personal keys can use them directly.
settingsRoutes.get('/system-config', async (c) => {
  const env = (c as any).env || {}
  const llmProvider = env.SYSTEM_LLM_PROVIDER || process.env.SYSTEM_LLM_PROVIDER || ''
  const llmApiKey = env.SYSTEM_LLM_API_KEY || process.env.SYSTEM_LLM_API_KEY || ''
  const llmModel = env.SYSTEM_LLM_MODEL || process.env.SYSTEM_LLM_MODEL || ''
  const llmBaseUrl = env.SYSTEM_LLM_BASE_URL || process.env.SYSTEM_LLM_BASE_URL || ''
  const tickflowKey = env.SYSTEM_TICKFLOW_API_KEY || process.env.SYSTEM_TICKFLOW_API_KEY || ''
  const tushareToken = env.SYSTEM_TUSHARE_TOKEN || process.env.SYSTEM_TUSHARE_TOKEN || ''

  return c.json({
    llm_provider: llmProvider || null,
    llm_api_key: llmApiKey || null,
    llm_model: llmModel || null,
    llm_base_url: llmBaseUrl || null,
    tickflow_api_key: tickflowKey || null,
    tushare_token: tushareToken || null,
  })
})
