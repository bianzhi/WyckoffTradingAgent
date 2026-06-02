import { X, Keyboard } from 'lucide-react'
import { usePreferences, type TranslationKey } from '@/lib/preferences'

interface ShortcutGroup {
  labelKey?: TranslationKey
  label?: string
  entries: { label: string; keys: string }[]
}

const ShortcutGroups: Record<string, ShortcutGroup[]> = {
  'zh-CN': [
    {
      label: '全局',
      entries: [
        { label: '显示/隐藏快捷键', keys: '?' },
        { label: '切换主题', keys: 'Ctrl + T' },
        { label: '切换语言', keys: 'Ctrl + L' },
        { label: '返回顶部', keys: 'Ctrl + ↑' },
        { label: '关闭弹窗', keys: 'Esc' },
      ],
    },
    {
      label: '导航',
      entries: [
        { label: '对话', keys: '1' },
        { label: '单股分析', keys: '2' },
        { label: '持仓诊断', keys: '3' },
        { label: '形态复盘', keys: '4' },
        { label: '漏斗选股', keys: '5' },
      ],
    },
  ],
  en: [
    {
      label: 'Global',
      entries: [
        { label: 'Show shortcuts', keys: '?' },
        { label: 'Toggle theme', keys: 'Ctrl + T' },
        { label: 'Toggle language', keys: 'Ctrl + L' },
        { label: 'Scroll to top', keys: 'Ctrl + ↑' },
        { label: 'Close dialog', keys: 'Esc' },
      ],
    },
    {
      label: 'Navigation',
      entries: [
        { label: 'Chat', keys: '1' },
        { label: 'Analysis', keys: '2' },
        { label: 'Portfolio', keys: '3' },
        { label: 'Tracking', keys: '4' },
        { label: 'Funnel', keys: '5' },
      ],
    },
  ],
}

function ShortcutEntry({ entry }: { entry: { label: string; keys: string } }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{entry.label}</span>
      <kbd className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
        {entry.keys}
      </kbd>
    </div>
  )
}

export function KbdShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isZh = usePreferences().locale === 'zh-CN'
  const groups = ShortcutGroups[isZh ? 'zh-CN' : 'en'] ?? []

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-4 max-h-[80vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Keyboard size={18} className="text-muted-foreground" />
            <h2 className="text-lg font-semibold">
              {isZh ? '键盘快捷键' : 'Keyboard Shortcuts'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <X size={16} />
          </button>
        </div>

        {groups.map((g) => (
          <section key={g.label} className="mb-4 last:mb-0">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {g.label}
            </h3>
            <div className="space-y-1.5">
              {g.entries.map((e) => (
                <ShortcutEntry key={e.keys} entry={e} />
              ))}
            </div>
          </section>
        ))}

        <p className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground">
          {isZh ? '按 ? 任意位置打开此面板，按 Esc 关闭' : 'Press ? anywhere to open this panel, Esc to close'}
        </p>
      </div>
    </div>
  )
}
