import { X, Keyboard } from 'lucide-react'
import { usePreferences, type TranslationKey } from '@/lib/preferences'

interface ShortcutGroup {
  labelKey?: TranslationKey
  label?: string
  entries: { label: string; keys: string }[]
}

export function KbdShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { locale } = usePreferences()
  const isZh = locale === 'zh-CN'

  const groups: ShortcutGroup[] = [
    {
      label: isZh ? '全局' : 'Global',
      entries: [
        { label: isZh ? '显示/隐藏快捷键' : 'Show shortcuts', keys: '?' },
        { label: isZh ? '切换主题' : 'Toggle theme', keys: 'Ctrl + T' },
        { label: isZh ? '切换语言' : 'Toggle language', keys: 'Ctrl + L' },
        { label: isZh ? '返回顶部' : 'Scroll to top', keys: 'Ctrl + ↑' },
        { label: isZh ? '关闭弹窗' : 'Close dialog', keys: 'Esc' },
      ],
    },
    {
      label: isZh ? '导航' : 'Navigation',
      entries: [
        { label: isZh ? '对话' : 'Chat', keys: '1' },
        { label: isZh ? '单股分析' : 'Analysis', keys: '2' },
        { label: isZh ? '持仓诊断' : 'Portfolio', keys: '3' },
        { label: isZh ? '形态复盘' : 'Tracking', keys: '4' },
        { label: isZh ? '漏斗选股' : 'Funnel', keys: '5' },
      ],
    },
  ]

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
                <div key={e.keys} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{e.label}</span>
                  <kbd className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
                    {e.keys}
                  </kbd>
                </div>
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
