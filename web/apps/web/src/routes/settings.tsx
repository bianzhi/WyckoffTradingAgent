import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { PROVIDERS, PROVIDER_LABELS } from '@wyckoff/shared'
import { usePreferences, type TranslationKey } from '@/lib/preferences'

type UserRole = 'admin' | 'member'
type SettingsTab = 'account' | 'memory'

interface AdminSectionProps {
  loading: boolean
  settings: Record<string, string>
  onChange: (key: string, value: string) => void
}

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

// ── AccountSection ──────────────────────────────────────────
function AccountSection({ user, role }: { user: { email?: string } | null; role: UserRole | null }) {
  if (!user) return null
  return (
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
  )
}

// ── AdminLLMSection ─────────────────────────────────────────
function AdminLLMSection({ loading, settings, onChange }: AdminSectionProps) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">大模型配置</h2>
      {loading ? (
        <div className="text-sm text-muted-foreground">加载中…</div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">默认 Provider</label>
            <select
              value={settings.llm_provider || ''}
              onChange={(e) => onChange('llm_provider', e.target.value)}
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
            value={settings.llm_api_key || ''}
            onChange={(v) => onChange('llm_api_key', v)}
            placeholder="sk-..."
          />
          <Input
            label="默认模型"
            value={settings.llm_model || ''}
            onChange={(v) => onChange('llm_model', v)}
            placeholder="deepseek-chat"
          />
          <Input
            label="Base URL"
            value={settings.llm_base_url || ''}
            onChange={(v) => onChange('llm_base_url', v)}
            placeholder="https://api.deepseek.com/v1"
          />
        </div>
      )}
    </section>
  )
}

// ── AdminDataSection ────────────────────────────────────────
function AdminDataSection({ loading, settings, onChange }: AdminSectionProps) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">数据源</h2>
      {loading ? (
        <div className="text-sm text-muted-foreground">加载中…</div>
      ) : (
        <div className="space-y-3">
          <Input
            label="TickFlow API Key"
            type="password"
            value={settings.tickflow_api_key || ''}
            onChange={(v) => onChange('tickflow_api_key', v)}
            placeholder="tf-..."
          />
          <Input
            label="Tushare Token"
            type="password"
            value={settings.tushare_token || ''}
            onChange={(v) => onChange('tushare_token', v)}
            placeholder="token..."
          />
        </div>
      )}
    </section>
  )
}

// ── AdminNotifySection ──────────────────────────────────────
function AdminNotifySection({ loading, settings, onChange }: AdminSectionProps) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">通知 (预留)</h2>
      {loading ? (
        <div className="text-sm text-muted-foreground">加载中…</div>
      ) : (
        <div className="space-y-3">
          <Input
            label="飞书 Webhook"
            type="password"
            value={settings.feishu_webhook || ''}
            onChange={(v) => onChange('feishu_webhook', v)}
          />
          <Input
            label="企业微信 Webhook"
            type="password"
            value={settings.wecom_webhook || ''}
            onChange={(v) => onChange('wecom_webhook', v)}
          />
          <Input
            label="钉钉 Webhook"
            type="password"
            value={settings.dingtalk_webhook || ''}
            onChange={(v) => onChange('dingtalk_webhook', v)}
          />
        </div>
      )}
    </section>
  )
}

// ── MemberNotice ────────────────────────────────────────────
function MemberNotice() {
  return (
    <section className="mb-8">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
        系统资源（大模型、数据源、通知渠道）已由管理员集中配置，您无需额外设置即可直接使用。
      </div>
    </section>
  )
}

export function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const [role, setRole] = useState<UserRole | null>(null)
  const [roleLoading, setRoleLoading] = useState(true)
  const [systemSettings, setSystemSettings] = useState<Record<string, string>>({})
  const [systemLoading, setSystemLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [toastKind, setToastKind] = useState<'success' | 'error'>('success')
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('account')

  useEffect(() => { if (!user) return; loadRole() }, [user])
  useEffect(() => () => clearTimeout(toastTimerRef.current), [])
  useEffect(() => { if (role === 'admin') loadSystemSettings() }, [role])

  async function loadRole() {
    setRoleLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = {}
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      const res = await fetch('/api/settings/role', { headers })
      setRole(res.ok ? ((await res.json()).role || 'member') : 'member')
    } catch { setRole('member') }
    setRoleLoading(false)
  }

  async function loadSystemSettings() {
    setSystemLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = {}
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      const res = await fetch('/api/settings/admin', { headers })
      if (res.ok) setSystemSettings(await res.json() as Record<string, string>)
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
      const res = await fetch('/api/settings/admin', { method: 'PUT', headers, body: JSON.stringify(systemSettings) })
      if (!res.ok) throw new Error(((await res.json()).error) || 'Failed')
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

  const { t } = usePreferences()

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-2xl">
        {toast && (
          <div className={`mb-4 rounded-lg px-4 py-2 text-sm ${toastKind === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-200'}`}>
            {toast}
          </div>
        )}

        <SettingsTabBar activeTab={settingsTab} onTabChange={setSettingsTab} t={t} />

        {settingsTab === 'account' && (
          <>
            <AccountSection user={user} role={role} />

            {role === 'admin' && (
              <>
                <AdminLLMSection loading={systemLoading} settings={systemSettings} onChange={updateSystemSetting} />
                <AdminDataSection loading={systemLoading} settings={systemSettings} onChange={updateSystemSetting} />
                <AdminNotifySection loading={systemLoading} settings={systemSettings} onChange={updateSystemSetting} />
                <button
                  onClick={handleAdminSave}
                  disabled={saving || systemLoading}
                  className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? '保存中…' : '保存系统配置'}
                </button>
              </>
            )}

            {role === 'member' && <MemberNotice />}
          </>
        )}

        {settingsTab === 'memory' && <MemorySection userId={user?.id} t={t} />}
      </div>
    </div>
  )
}

function SettingsTabBar({ activeTab, onTabChange, t }: { activeTab: SettingsTab; onTabChange: (v: SettingsTab) => void; t: (key: TranslationKey) => string }) {
  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'account', label: t('settings.account') },
    { key: 'memory', label: t('settings.memory') },
  ]
  return (
    <div className="mb-6 flex gap-1 rounded-lg border border-border p-1 w-fit">
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => onTabChange(key)}
          className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${activeTab === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function MemorySection({ userId, t }: { userId: string | undefined; t: (key: TranslationKey) => string }) {
  const [items, setItems] = useState<Array<{ key: string; value: string }>>([])
  const [loading, setLoading] = useState(true)
  const [searchKey, setSearchKey] = useState('')

  useEffect(() => {
    if (!userId) return
    loadMemory()
  }, [userId])

  async function loadMemory() {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      const res = await fetch('/api/data/memory?action=list', { headers })
      if (res.ok) {
        const json = await res.json() as Record<string, unknown>
        const entries = Array.isArray(json.items) ? json.items as Array<{ key: string; value: string }> : []
        setItems(entries)
      }
    } catch { /* keep defaults */ }
    setLoading(false)
  }

  async function deleteItem(key: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      await fetch(`/api/data/memory?key=${encodeURIComponent(key)}`, { method: 'DELETE', headers })
      setItems((prev) => prev.filter((i) => i.key !== key))
    } catch { /* ignore */ }
  }

  async function clearAll() {
    if (!confirm(t('settings.memoryClearConfirm'))) return
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`
      await fetch('/api/data/memory?action=clear', { method: 'DELETE', headers })
      setItems([])
    } catch { /* ignore */ }
  }

  const filtered = searchKey
    ? items.filter((i) => i.key.toLowerCase().includes(searchKey.toLowerCase()) || i.value.toLowerCase().includes(searchKey.toLowerCase()))
    : items

  if (loading) return <div className="text-sm text-muted-foreground">{t('common.loading')}</div>

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">{t('settings.memory')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{t('settings.memoryDesc')}</p>
      <div className="mb-4 flex items-center gap-3">
        <input
          type="text"
          value={searchKey}
          onChange={(e) => setSearchKey(e.target.value)}
          placeholder={t('settings.memorySearch')}
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          onClick={clearAll}
          className="rounded-lg border border-red-200 px-3 py-2 text-xs text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:text-red-200 dark:hover:bg-red-500/10"
        >
          {t('settings.memoryClear')}
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.memoryEmpty')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-3 py-2 text-left font-medium">{t('settings.memoryKey')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('settings.memoryValue')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('settings.memoryAction')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.key} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="px-3 py-2 font-mono text-xs">{item.key}</td>
                  <td className="px-3 py-2 text-xs max-w-[300px] truncate">{item.value}</td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => deleteItem(item.key)} className="text-xs text-red-500 hover:text-red-700">{t('action.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
