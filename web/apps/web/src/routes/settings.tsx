import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { PROVIDERS, PROVIDER_LABELS } from '@wyckoff/shared'

type UserRole = 'admin' | 'member'

// ── simple Input component ──────────────────────────────────
function Input(p: { label: string; type?: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{p.label}</label>
      <input
        type={p.type || 'text'}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        placeholder={p.placeholder}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
    </div>
  )
}

export function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const [role, setRole] = useState<UserRole | null>(null)
  const [roleLoading, setRoleLoading] = useState(true)

  // ── admin state (system_settings) ─────────────────────────
  const [systemSettings, setSystemSettings] = useState<Record<string, string>>({})
  const [systemLoading, setSystemLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [toastKind, setToastKind] = useState<'success' | 'error'>('success')
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!user) return
    loadRole()
  }, [user])

  useEffect(() => () => clearTimeout(toastTimerRef.current), [])

  async function loadRole() {
    setRoleLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = {}
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      const res = await fetch('/api/settings/role', { headers })
      if (res.ok) {
        const json = await res.json()
        setRole(json.role || 'member')
      } else {
        setRole('member')
      }
    } catch {
      setRole('member')
    }
    setRoleLoading(false)
  }

  useEffect(() => {
    if (role === 'admin') loadSystemSettings()
  }, [role])

  async function loadSystemSettings() {
    setSystemLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = {}
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      const res = await fetch('/api/settings/admin', { headers })
      if (res.ok) {
        const json = await res.json()
        setSystemSettings(json as Record<string, string>)
      }
    } catch { /* keep defaults */ }
    setSystemLoading(false)
  }

  function updateSystemSetting(key: string, value: string) {
    setSystemSettings((prev) => ({ ...prev, [key]: value }))
  }

  async function handleAdminSave() {
    setSaving(true)
    setToast('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      const res = await fetch('/api/settings/admin', {
        method: 'PUT',
        headers,
        body: JSON.stringify(systemSettings),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed')
      }
      setToastKind('success')
      setToast('系统配置已保存')
    } catch (e: any) {
      setToastKind('error')
      setToast(e.message || '保存失败')
    }
    setSaving(false)
    clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(''), 3000)
  }

  // ── render ────────────────────────────────────────────────
  if (roleLoading) {
    return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">加载中…</div>
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-2xl">

        {toast && (
          <div className={`mb-4 rounded-lg px-4 py-2 text-sm ${toastKind === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-200'}`}>
            {toast}
          </div>
        )}

        {/* ── 账户信息 (所有角色可见) ───────────────────── */}
        {user && (
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">账户</h2>
            <div className="space-y-2 rounded-lg border border-border px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Email</span>
                <span>{user.email}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">角色</span>
                <span className={role === 'admin' ? 'font-medium text-indigo-600 dark:text-indigo-400' : ''}>
                  {role === 'admin' ? '管理员' : '普通用户'}
                </span>
              </div>
            </div>
          </section>
        )}

        {/* ── 管理员面板 ──────────────────────────────────── */}
        {role === 'admin' && (
          <>
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">大模型配置</h2>
              {systemLoading ? (
                <div className="text-sm text-muted-foreground">加载中…</div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">默认 Provider</label>
                    <select
                      value={systemSettings.llm_provider || ''}
                      onChange={(e) => updateSystemSetting('llm_provider', e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    >
                      <option value="">未设置</option>
                      {PROVIDERS.map((p) => (
                        <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                      ))}
                    </select>
                  </div>
                  <Input
                    label="API Key"
                    type="password"
                    value={systemSettings.llm_api_key || ''}
                    onChange={(v) => updateSystemSetting('llm_api_key', v)}
                    placeholder="sk-..."
                  />
                  <Input
                    label="默认模型"
                    value={systemSettings.llm_model || ''}
                    onChange={(v) => updateSystemSetting('llm_model', v)}
                    placeholder="deepseek-chat"
                  />
                  <Input
                    label="Base URL"
                    value={systemSettings.llm_base_url || ''}
                    onChange={(v) => updateSystemSetting('llm_base_url', v)}
                    placeholder="https://api.deepseek.com/v1"
                  />
                </div>
              )}
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">数据源</h2>
              {systemLoading ? (
                <div className="text-sm text-muted-foreground">加载中…</div>
              ) : (
                <div className="space-y-3">
                  <Input
                    label="TickFlow API Key"
                    type="password"
                    value={systemSettings.tickflow_api_key || ''}
                    onChange={(v) => updateSystemSetting('tickflow_api_key', v)}
                    placeholder="tf-..."
                  />
                  <Input
                    label="Tushare Token"
                    type="password"
                    value={systemSettings.tushare_token || ''}
                    onChange={(v) => updateSystemSetting('tushare_token', v)}
                    placeholder="token..."
                  />
                </div>
              )}
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">通知 (预留)</h2>
              {systemLoading ? (
                <div className="text-sm text-muted-foreground">加载中…</div>
              ) : (
                <div className="space-y-3">
                  <Input
                    label="飞书 Webhook"
                    type="password"
                    value={systemSettings.feishu_webhook || ''}
                    onChange={(v) => updateSystemSetting('feishu_webhook', v)}
                  />
                  <Input
                    label="企业微信 Webhook"
                    type="password"
                    value={systemSettings.wecom_webhook || ''}
                    onChange={(v) => updateSystemSetting('wecom_webhook', v)}
                  />
                  <Input
                    label="钉钉 Webhook"
                    type="password"
                    value={systemSettings.dingtalk_webhook || ''}
                    onChange={(v) => updateSystemSetting('dingtalk_webhook', v)}
                  />
                </div>
              )}
            </section>

            <button
              onClick={handleAdminSave}
              disabled={saving || systemLoading}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存系统配置'}
            </button>
          </>
        )}

        {/* ── 普通用户提示 ────────────────────────────────── */}
        {role === 'member' && (
          <section className="mb-8">
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
              系统资源（大模型、数据源、通知渠道）已由管理员集中配置，您无需额外设置即可直接使用。
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
