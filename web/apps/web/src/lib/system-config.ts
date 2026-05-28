import { supabase } from './supabase'

export interface SystemConfig {
  llm_provider: string | null
  llm_api_key: string | null
  llm_model: string | null
  llm_base_url: string | null
  tickflow_api_key: string | null
  tushare_token: string | null
}

const EMPTY: SystemConfig = {
  llm_provider: null, llm_api_key: null, llm_model: null, llm_base_url: null,
  tickflow_api_key: null, tushare_token: null,
}

let _systemConfigPromise: Promise<SystemConfig> | null = null
let _systemConfig: SystemConfig | null = null

/** Load system-level defaults (set via env vars on the API server). */
export async function loadSystemConfig(): Promise<SystemConfig> {
  if (_systemConfig) return _systemConfig
  if (!_systemConfigPromise) {
    _systemConfigPromise = supabase.auth.getSession().then(({ data }) => {
      const headers: Record<string, string> = {}
      if (data.session?.access_token) {
        headers['Authorization'] = `Bearer ${data.session.access_token}`
      }
      return fetch('/api/settings/system-config', { headers })
        .then(async (res) => {
          if (!res.ok) return EMPTY
          const json = await res.json()
          _systemConfig = json as SystemConfig
          return _systemConfig
        })
        .catch(() => EMPTY)
    })
  }
  return _systemConfigPromise
}
