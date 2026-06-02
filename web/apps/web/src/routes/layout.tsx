import { Outlet, Link, useLocation, useNavigate } from 'react-router'
import { useEffect, useState, useCallback } from 'react'
import { MessageSquare, Briefcase, TrendingUp, Settings, LogOut, BarChart3, Moon, FileDown, BookOpen, Sun, Languages, Swords, Map, History, Filter, TrendingDown, Activity, Menu, X, type LucideIcon } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { MarketBar } from '@/components/market-bar'
import { usePreferences, type TranslationKey } from '@/lib/preferences'
import { trackRouteActivity } from '@/lib/activity'
import { PageTransition } from '@/components/ux/page-transition'
import { KbdShortcuts } from '@/components/ux/kbd-shortcuts'

const navItems = [
  { to: '/chat', icon: MessageSquare, labelKey: 'nav.chat' },
  { to: '/analysis', icon: BarChart3, labelKey: 'nav.analysis' },
  { to: '/battle', icon: Swords, labelKey: 'nav.battle' },
  { to: '/portfolio', icon: Briefcase, labelKey: 'nav.portfolio' },
  { to: '/history', icon: History, labelKey: 'nav.history' },
  { to: '/tracking', icon: TrendingUp, labelKey: 'nav.tracking' },
  { to: '/funnel', icon: Filter, labelKey: 'nav.funnel' },
  { to: '/backtest', icon: TrendingDown, labelKey: 'nav.backtest' },
  { to: '/signal', icon: Activity, labelKey: 'nav.signal' },
  { to: '/tail-buy', icon: Moon, labelKey: 'nav.tailBuy' },
  { to: '/export', icon: FileDown, labelKey: 'nav.export' },
  { to: '/guide', icon: BookOpen, labelKey: 'nav.guide' },
  { to: '/guide#capability-boundary', icon: Map, labelKey: 'nav.capabilities' },
  { to: '/settings', icon: Settings, labelKey: 'nav.settings' },
] satisfies { to: string; icon: LucideIcon; labelKey: TranslationKey }[]

function PreferenceControls() {
  const { locale, setLocale, theme, toggleTheme, t } = usePreferences()
  const nextLocale = locale === 'zh-CN' ? 'en-US' : 'zh-CN'
  const ThemeIcon = theme === 'dark' ? Sun : Moon

  return (
    <div className="mb-3 flex gap-2 px-3">
      <button
        type="button"
        onClick={toggleTheme}
        title={theme === 'dark' ? t('prefs.light') : t('prefs.dark')}
        aria-label={t('prefs.theme')}
        className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ThemeIcon size={14} />
        {theme === 'dark' ? t('prefs.light') : t('prefs.dark')}
      </button>
      <button
        type="button"
        onClick={() => setLocale(nextLocale)}
        title={locale === 'zh-CN' ? t('prefs.switchToEnglish') : t('prefs.switchToChinese')}
        aria-label={t('prefs.language')}
        className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Languages size={14} />
        {locale === 'zh-CN' ? 'EN' : '中文'}
      </button>
    </div>
  )
}

function SidebarFooter({ email, onLogout }: { email: string; onLogout: () => void }) {
  const { t } = usePreferences()

  return (
    <div className="border-t border-border p-3">
      <PreferenceControls />
      <div className="mb-2 truncate px-3 text-[11px] text-muted-foreground">{email}</div>
      <button
        onClick={onLogout}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <LogOut size={15} />
        {t('action.logout')}
      </button>
    </div>
  )
}

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const { locale, setLocale, toggleTheme, t } = usePreferences()
  const handleLogout = useLogoutHandler()
  useRouteActivity(user?.id, location)

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [kbdOpen, setKbdOpen] = useState(false)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])

  // Close sidebar on route change (mobile)
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't trigger in input fields
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const mod = e.metaKey || e.ctrlKey

      if (e.key === '?') { e.preventDefault(); setKbdOpen(v => !v); return }
      if (e.key === 'Escape') { setSidebarOpen(false); setKbdOpen(false); return }
      if (mod && e.key === 't') { e.preventDefault(); toggleTheme(); return }
      if (mod && e.key === 'l') { e.preventDefault(); setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN'); return }
      if (mod && e.key === 'ArrowUp') { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); return }
      // Number keys for quick nav
      if (!mod) {
        const navMap: Record<string, string> = { '1': '/chat', '2': '/analysis', '3': '/portfolio', '4': '/tracking', '5': '/funnel' }
        const dest = navMap[e.key]
        if (dest) { e.preventDefault(); navigate(dest) }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, locale, setLocale, toggleTheme])

  // ── Sidebar content (shared by desktop + mobile) ──────────────────
  const sidebarContent = (
    <>
      <div className="px-5 py-5">
        <h2 className="bg-gradient-to-r from-primary to-cyan-500 bg-clip-text text-xl font-bold tracking-tight text-transparent">
          Wyckoff
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('app.subtitle')}</p>
      </div>
      <nav className="flex-1 space-y-0.5 px-3">
        {navItems.map(({ to, icon: Icon, labelKey }) => (
          <Link
            key={to}
            to={to}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all ${
              _navActive(location.pathname, location.hash, to)
                ? 'bg-primary/10 font-medium text-primary shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Icon size={18} />
            {t(labelKey)}
          </Link>
        ))}
      </nav>
      <SidebarFooter email={user?.email || 'dev@preview'} onLogout={handleLogout} />
    </>
  )

  return (
    <div className="flex h-screen">
      {/* Desktop sidebar: hidden below lg, visible above */}
      <aside className="hidden lg:flex w-56 flex-col border-r border-border bg-sidebar">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* Mobile sidebar panel */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-border bg-sidebar transition-transform duration-300 lg:hidden ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Close button */}
        <button
          onClick={closeSidebar}
          className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
        >
          <X size={18} />
        </button>
        {sidebarContent}
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header bar */}
        <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2.5 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
          >
            <Menu size={20} />
          </button>
          <h2 className="bg-gradient-to-r from-primary to-cyan-500 bg-clip-text text-lg font-bold text-transparent">
            Wyckoff
          </h2>
        </div>
        <MarketBar />
        <main className="flex-1 overflow-auto bg-background">
            <PageTransition key={location.pathname}>
              <Outlet />
            </PageTransition>
          </main>
        </div>
        <KbdShortcuts open={kbdOpen} onClose={() => setKbdOpen(false)} />
      </div>
  )
}

function _navActive(pathname: string, hash: string, to: string) {
  const [targetPath, targetHash = ''] = to.split('#')
  if (targetHash) {
    return pathname === targetPath && hash === `#${targetHash}`
  }
  return pathname === targetPath && !hash
}

function useLogoutHandler() {
  const navigate = useNavigate()
  return async () => {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }
}

function useRouteActivity(userId: string | undefined, location: ReturnType<typeof useLocation>) {
  const route = `${location.pathname}${location.search}${location.hash}`
  useEffect(() => {
    if (userId) trackRouteActivity(userId, route)
  }, [route, userId])
}
