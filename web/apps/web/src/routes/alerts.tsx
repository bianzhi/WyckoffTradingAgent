import { useEffect, useState, useCallback } from 'react'
import { Bell, Plus, Trash2, Play, Pause, AlertTriangle, CheckCircle, X, RefreshCw, Loader2 } from 'lucide-react'
import { usePreferences } from '@/lib/preferences'

// ── Types ──────────────────────────────────────────────────

interface AlertCondition {
  type: string; symbol: string; threshold: number
  multiplier: number; index_code: string; regime_value: string
}
interface AlertRule {
  id: string; name: string; enabled: boolean
  conditions: AlertCondition[]
  notify: { webhook_url: string; title: string }; cooldown_minutes: number
}
type AlertResult = { id: string; name: string; triggered: boolean; detail: string }

const COND_TYPES = [
  { value: 'price_above', labelZh: '价格突破上轨', labelEn: 'Price Above' },
  { value: 'price_below', labelZh: '价格跌破下轨', labelEn: 'Price Below' },
  { value: 'pct_change', labelZh: '涨跌幅异动', labelEn: '% Change' },
  { value: 'volume_spike', labelZh: '放量异动', labelEn: 'Volume Spike' },
  { value: 'index_pct', labelZh: '指数波动', labelEn: 'Index % Change' },
  { value: 'regime', labelZh: '市场水温', labelEn: 'Market Regime' },
]
const REGIME_VALUES = ['BULL', 'NEUTRAL', 'BEAR', 'CRASH']
const INDEX_CODES = [
  { value: '000001', label: '上证指数' }, { value: '399001', label: '深证成指' },
  { value: '399006', label: '创业板指' }, { value: '000300', label: '沪深300' },
]
const DEFAULT_COND: AlertCondition = { type: 'price_above', symbol: '', threshold: 0, multiplier: 1.5, index_code: '', regime_value: 'BULL' }

// ── API ────────────────────────────────────────────────────

let _api: any = null
function getApi() {
  if (!_api) import('@/lib/data-skill').then(m => { _api = m.dataSkill })
  return _api || (async () => (await import('@/lib/data-skill')).dataSkill)()
}

// ── Page Logic Hook ────────────────────────────────────────

function useAlertPageLogic() {
  const { locale } = usePreferences()
  const isZh = locale === 'zh-CN'
  const [rules, setRules] = useState<AlertRule[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [evalResults, setEvalResults] = useState<AlertResult[] | null>(null)
  const [evalRunning, setEvalRunning] = useState(false)
  const [error, setError] = useState('')

  const loadRules = useCallback(async () => {
    setLoading(true)
    try { const api = await getApi(); const r = await api.fetchAlerts(); if (r.error) setError(r.error); else setRules((r.rules || []) as AlertRule[]) }
    catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { loadRules() }, [loadRules])

  const handleDelete = async (id: string) => {
    if (!confirm(isZh ? `删除规则 ${id}?` : `Delete rule ${id}?`)) return
    const api = await getApi(); const r = await api.deleteAlert(id); if (!r.ok) setError(r.message); else loadRules()
  }
  const handleToggle = async (rule: AlertRule) => {
    const api = await getApi(); const r = await api.saveAlert({ ...rule, enabled: !rule.enabled }); r.ok ? loadRules() : setError(r.message)
  }
  const handleRun = async () => {
    setEvalRunning(true); setEvalResults(null)
    try { const api = await getApi(); const r = await api.runAlerts(false); if (r.error) { setError(String(r.error)); return }; setEvalResults((r.results || []) as AlertResult[]) }
    catch (e: any) { setError(e.message) }
    finally { setEvalRunning(false) }
  }
  const onSaveSuccess = () => { setShowForm(false); setEditing(null); loadRules() }

  return { rules, loading, showForm, editing, evalResults, evalRunning, error, isZh,
    setShowForm, setEditing, setEvalResults, setError,
    handleDelete, handleToggle, handleRun, onSaveSuccess }
}

// ── Page ───────────────────────────────────────────────────

export function AlertsPage() {
  const ctx = useAlertPageLogic()
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <AlertsHeader isZh={ctx.isZh} evalRunning={ctx.evalRunning} onRun={ctx.handleRun} onNew={() => { ctx.setEditing(null); ctx.setShowForm(true) }} />
      {ctx.error && <ErrorBanner error={ctx.error} onClose={() => ctx.setError('')} />}
      {ctx.evalResults && <EvalPanel results={ctx.evalResults} isZh={ctx.isZh} onClose={() => ctx.setEvalResults(null)} />}
      {ctx.showForm && <RuleForm rule={ctx.editing} isZh={ctx.isZh} onCancel={() => { ctx.setShowForm(false); ctx.setEditing(null) }} onSuccess={ctx.onSaveSuccess} setError={ctx.setError} />}
      {ctx.loading ? <LoadingMsg isZh={ctx.isZh} /> : ctx.rules.length === 0 ? <EmptyState isZh={ctx.isZh} />
        : <RuleList rules={ctx.rules} isZh={ctx.isZh} onEdit={r => { ctx.setEditing(r); ctx.setShowForm(true) }} onToggle={ctx.handleToggle} onDelete={ctx.handleDelete} />}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────

function AlertsHeader({ isZh, evalRunning, onRun, onNew }: { isZh: boolean; evalRunning: boolean; onRun: () => void; onNew: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-lg font-bold flex items-center gap-2"><Bell size={20} className="text-amber-500" />{isZh ? '条件预警' : 'Alert Rules'}</h1>
      <div className="flex gap-2">
        <button onClick={onRun} disabled={evalRunning} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          {evalRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}{isZh ? '运行评估' : 'Run Eval'}
        </button>
        <button onClick={onNew} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">
          <Plus size={14} />{isZh ? '新建规则' : 'New Rule'}
        </button>
      </div>
    </div>
  )
}

function ErrorBanner({ error, onClose }: { error: string; onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      <AlertTriangle size={14} />{error}<button onClick={onClose} className="ml-auto"><X size={14} /></button>
    </div>
  )
}
function LoadingMsg({ isZh }: { isZh: boolean }) {
  return <div className="text-center py-12 text-sm text-muted-foreground"><Loader2 size={20} className="animate-spin mx-auto mb-2" />{isZh ? '加载中…' : 'Loading…'}</div>
}
function EmptyState({ isZh }: { isZh: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-12 text-center space-y-2">
      <Bell size={32} className="mx-auto text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{isZh ? '还没有预警规则' : 'No alert rules yet'}</p>
      <p className="text-xs text-muted-foreground">{isZh ? '创建规则后，引擎将定时检查并推送通知。' : 'Create rules to get notified on market conditions.'}</p>
    </div>
  )
}
function EvalPanel({ results, isZh, onClose }: { results: AlertResult[]; isZh: boolean; onClose: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-center justify-between"><span className="text-sm font-semibold">{isZh ? '评估结果' : 'Eval Results'}</span><button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={16} /></button></div>
      <div className="space-y-1.5">{results.map(r => (
        <div key={r.id} className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${r.triggered ? 'bg-amber-50 text-amber-900' : 'bg-muted text-muted-foreground'}`}>{r.triggered ? <AlertTriangle size={14} className="text-amber-500 shrink-0" /> : <CheckCircle size={14} className="text-green-500 shrink-0" />}<span className="font-medium">{r.name}</span><span className="ml-auto">{r.detail}</span></div>
      ))}</div>
    </div>
  )
}

function RuleList({ rules, isZh, onEdit, onToggle, onDelete }: { rules: AlertRule[]; isZh: boolean; onEdit: (r: AlertRule) => void; onToggle: (r: AlertRule) => void; onDelete: (id: string) => void }) {
  return <div className="space-y-2">{rules.map(r => <RuleCard key={r.id} rule={r} isZh={isZh} onEdit={onEdit} onToggle={onToggle} onDelete={onDelete} />)}</div>
}

function RuleCard({ rule, isZh, onEdit, onToggle, onDelete }: { rule: AlertRule; isZh: boolean; onEdit: (r: AlertRule) => void; onToggle: (r: AlertRule) => void; onDelete: (id: string) => void }) {
  return (
    <div className={`rounded-lg border bg-card p-4 transition-opacity ${!rule.enabled ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{rule.name}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${rule.enabled ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'}`}>{rule.enabled ? (isZh ? '启用' : 'On') : (isZh ? '停用' : 'Off')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onToggle(rule)} className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground" title={rule.enabled ? (isZh ? '停用' : 'Disable') : (isZh ? '启用' : 'Enable')}>{rule.enabled ? <Pause size={14} /> : <Play size={14} />}</button>
          <button onClick={() => onEdit(rule)} className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground" title={isZh ? '编辑' : 'Edit'}><RefreshCw size={14} /></button>
          <button onClick={() => onDelete(rule.id)} className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600" title={isZh ? '删除' : 'Delete'}><Trash2 size={14} /></button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">{rule.conditions.map((c, i) => <CondBadge key={i} cond={c} />)}</div>
      {rule.cooldown_minutes > 0 && <p className="text-[10px] text-muted-foreground mt-2">{isZh ? `冷却 ${rule.cooldown_minutes} 分钟` : `Cooldown: ${rule.cooldown_minutes} min`}</p>}
    </div>
  )
}

function condLabel(c: AlertCondition): string {
  switch (c.type) {
    case 'price_above': return `${c.symbol} > ${c.threshold}`
    case 'price_below': return `${c.symbol} < ${c.threshold}`
    case 'pct_change': return `${c.symbol} 涨跌 ±${c.threshold}%`
    case 'volume_spike': return `${c.symbol} 量比 > ${c.multiplier}x`
    case 'index_pct': return `${c.index_code || '指数'} 波动 > ${c.threshold}%`
    case 'regime': return `水温 = ${c.regime_value}`
    default: return c.type
  }
}
function CondBadge({ cond }: { cond: AlertCondition }) {
  return <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{condLabel(cond)}</span>
}

// ── Rule Form ──────────────────────────────────────────────

const INPUT_CLS = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs'
const LBL_CLS = 'text-[11px] text-muted-foreground mb-0.5 block'

interface FormMetaProps { rule: AlertRule | null; isZh: boolean; id: string; name: string; cooldown: number; webhook: string; enabled: boolean; setId: (v: string) => void; setName: (v: string) => void; setCooldown: (v: number) => void; setWebhook: (v: string) => void; setEnabled: (v: boolean) => void }

function RuleFormMeta({ rule, isZh, id, name, cooldown, webhook, enabled, setId, setName, setCooldown, setWebhook, setEnabled }: FormMetaProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div><span className={LBL_CLS}>ID</span><input value={id} onChange={e => setId(e.target.value)} placeholder="alert-moutai-1800" className={INPUT_CLS} disabled={!!rule} /></div>
      <div><span className={LBL_CLS}>{isZh ? '名称' : 'Name'}</span><input value={name} onChange={e => setName(e.target.value)} placeholder={isZh ? '茅台突破1800' : 'Moutai > 1800'} className={INPUT_CLS} /></div>
      <div><span className={LBL_CLS}>{isZh ? '冷却 (分钟)' : 'Cooldown (min)'}</span><input type="number" value={cooldown} onChange={e => setCooldown(Number(e.target.value))} min={0} className={INPUT_CLS} /></div>
      <div><span className={LBL_CLS}>{isZh ? '飞书 Webhook' : 'Feishu Webhook'}</span><input value={webhook} onChange={e => setWebhook(e.target.value)} placeholder="${FEISHU_WEBHOOK}" className={INPUT_CLS} /></div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground col-span-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />{isZh ? '启用此规则' : 'Enable this rule'}</label>
    </div>
  )
}

function CondListHeader({ isZh, onAdd }: { isZh: boolean; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-muted-foreground">{isZh ? '条件列表' : 'Conditions'}</span>
      <button onClick={onAdd} className="text-xs text-primary hover:underline"><Plus size={12} className="inline mr-0.5" />{isZh ? '添加条件' : 'Add'}</button>
    </div>
  )
}

function RuleForm({ rule, isZh, onCancel, onSuccess, setError }: { rule: AlertRule | null; isZh: boolean; onCancel: () => void; onSuccess: () => void; setError: (e: string) => void }) {
  const [name, setName] = useState(rule?.name || '')
  const [id, setId] = useState(rule?.id || '')
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [cooldown, setCooldown] = useState(rule?.cooldown_minutes ?? 30)
  const [conditions, setConditions] = useState<AlertCondition[]>(rule?.conditions || [DEFAULT_COND])
  const [webhook, setWebhook] = useState(rule?.notify?.webhook_url || '')
  const [saving, setSaving] = useState(false)

  const addCond = () => setConditions([...conditions, { ...DEFAULT_COND }])
  const rmCond = (i: number) => setConditions(conditions.filter((_, ix) => ix !== i))
  const updCond = (i: number, f: string, v: string | number) => {
    const next = [...conditions]; next[i] = { ...next[i], [f]: v } as AlertCondition; setConditions(next)
  }

  const handleSave = async () => {
    if (!id.trim() || !name.trim()) { setError(isZh ? '请填写规则 ID 和名称' : 'ID and name required'); return }
    if (!conditions.length) { setError(isZh ? '至少需要一个条件' : 'At least one condition required'); return }
    setSaving(true)
    try {
      const api = await getApi()
      const res = await api.saveAlert({ id: id.trim(), name: name.trim(), enabled, conditions: conditions.map(c => JSON.parse(JSON.stringify(c))), notify: { webhook_url: webhook.trim(), title: '' }, cooldown_minutes: cooldown })
      res.ok ? onSuccess() : setError(res.message)
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  return (
    <div className="rounded-xl border border-border bg-card/50 p-4 space-y-4">
      <h3 className="text-sm font-semibold">{rule ? (isZh ? '编辑规则' : 'Edit Rule') : (isZh ? '新建规则' : 'New Rule')}</h3>
      <RuleFormMeta rule={rule} isZh={isZh} id={id} name={name} cooldown={cooldown} webhook={webhook} enabled={enabled} setId={setId} setName={setName} setCooldown={setCooldown} setWebhook={setWebhook} setEnabled={setEnabled} />
      <div className="space-y-3">
        <CondListHeader isZh={isZh} onAdd={addCond} />
        {conditions.map((cond, i) => <CondRow key={i} cond={cond} isZh={isZh} onChange={(f, v) => updCond(i, f, v)} onRemove={() => rmCond(i)} showRemove={conditions.length > 1} />)}
      </div>
      <div className="flex gap-2 pt-2">
        <button onClick={handleSave} disabled={saving} className="rounded-md bg-primary px-5 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">{saving ? (isZh ? '保存中…' : 'Saving…') : (isZh ? '保存' : 'Save')}</button>
        <button onClick={onCancel} className="rounded-md border border-border px-4 py-2 text-xs hover:bg-accent">{isZh ? '取消' : 'Cancel'}</button>
      </div>
    </div>
  )
}

// ── Condition Row ──────────────────────────────────────────

const SYMBOL_TYPES = ['price_above', 'price_below', 'pct_change', 'volume_spike']
const THRESHOLD_TYPES = ['price_above', 'price_below', 'pct_change', 'index_pct']

function CondFieldPicker({ cond, isZh, onChange }: { cond: AlertCondition; isZh: boolean; onChange: (f: string, v: string | number) => void }) {
  return (
    <>
      <div className="grow min-w-[140px]"><select value={cond.type} onChange={e => onChange('type', e.target.value)} className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs">{COND_TYPES.map(ct => <option key={ct.value} value={ct.value}>{isZh ? ct.labelZh : ct.labelEn}</option>)}</select></div>
      {SYMBOL_TYPES.includes(cond.type) && <div className="grow min-w-[100px]"><input value={cond.symbol} onChange={e => onChange('symbol', e.target.value)} placeholder={isZh ? '股票代码' : 'Symbol'} className={INPUT_CLS} /></div>}
      {THRESHOLD_TYPES.includes(cond.type) && <div className="grow min-w-[80px]"><input type="number" step="any" value={cond.threshold || ''} onChange={e => onChange('threshold', parseFloat(e.target.value) || 0)} placeholder={cond.type === 'pct_change' || cond.type === 'index_pct' ? '5.0' : '1800.00'} className={INPUT_CLS} /></div>}
      {cond.type === 'volume_spike' && <div className="grow min-w-[80px]"><input type="number" step="any" value={cond.multiplier || ''} onChange={e => onChange('multiplier', parseFloat(e.target.value) || 0)} placeholder="2.0" className={INPUT_CLS} /></div>}
      {cond.type === 'index_pct' && <div className="grow min-w-[120px]"><select value={cond.index_code} onChange={e => onChange('index_code', e.target.value)} className={INPUT_CLS}><option value="">{isZh ? '选择指数' : 'Select Index'}</option>{INDEX_CODES.map(ic => <option key={ic.value} value={ic.value}>{ic.label}</option>)}</select></div>}
      {cond.type === 'regime' && <div className="grow min-w-[100px]"><select value={cond.regime_value} onChange={e => onChange('regime_value', e.target.value)} className={INPUT_CLS}>{REGIME_VALUES.map(rv => <option key={rv} value={rv}>{rv}</option>)}</select></div>}
    </>
  )
}

function CondRow({ cond, isZh, onChange, onRemove, showRemove }: { cond: AlertCondition; isZh: boolean; onChange: (f: string, v: string | number) => void; onRemove: () => void; showRemove: boolean }) {
  return (
    <div className="flex items-start gap-2 flex-wrap rounded-md border border-border bg-background/50 p-3">
      <CondFieldPicker cond={cond} isZh={isZh} onChange={onChange} />
      {showRemove && <button onClick={onRemove} className="p-1.5 text-muted-foreground hover:text-red-500 shrink-0" title={isZh ? '删除' : 'Delete'}><X size={14} /></button>}
    </div>
  )
}
