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

function SidebarNav({ pathname, hash, email, onLogout }: {
  pathname: string; hash: string; email: string; onLogout: () => void
}) {
  const { t } = usePreferences()
  return (
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
              _navActive(pathname, hash, to)
                ? 'bg-primary/10 font-medium text-primary shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Icon size={18} />
            {t(labelKey)}
          </Link>
        ))}
      </nav>
      <SidebarFooter email={email} onLogout={onLogout} />
    </>
  )
}

function useGlobalShortcuts(opts: {
  setKbdOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  setSidebarOpen: (v: boolean) => void
  locale: string; setLocale: (l: string) => void; toggleTheme: () => void
  navigate: ReturnType<typeof useNavigate>
}) {
  const { setKbdOpen, setSidebarOpen, locale, setLocale, toggleTheme, navigate } = opts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const mod = e.metaKey || e.ctrlKey
      if (e.key === '?') { e.preventDefault(); setKbdOpen(v => !v); return }
      if (e.key === 'Escape') { setSidebarOpen(false); setKbdOpen(false); return }
      if (mod && e.key === 't') { e.preventDefault(); toggleTheme(); return }
      if (mod && e.key === 'l') { e.preventDefault(); setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN'); return }
      if (mod && e.key === 'ArrowUp') { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); return }
      if (!mod) {
        const navMap: Record<string, string> = { '1': '/chat', '2': '/analysis', '3': '/portfolio', '4': '/tracking', '5': '/funnel' }
        const dest = navMap[e.key]
        if (dest) { e.preventDefault(); navigate(dest) }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, locale, setLocale, toggleTheme, setKbdOpen, setSidebarOpen])
}

function MobileSidebar({ open, onClose, email, onLogout, pathname, hash }: {
  open: boolean; onClose: () => void
  email: string; onLogout: () => void; pathname: string; hash: string
}) {
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-border bg-sidebar transition-transform duration-300 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
        >
          <X size={18} />
        </button>
        <SidebarNav pathname={pathname} hash={hash} email={email} onLogout={onLogout} />
      </aside>
    </>
  )
}

function MainContent({ pathname, onOpenSidebar }: { pathname: string; onOpenSidebar: () => void }) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2.5 lg:hidden">
        <button
          onClick={onOpenSidebar}
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
        <PageTransition key={pathname}>
          <Outlet />
        </PageTransition>
      </main>
    </div>
  )
}

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const { locale, setLocale, toggleTheme } = usePreferences()
  const handleLogout = useLogoutHandler()
  useRouteActivity(user?.id, location)

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [kbdOpen, setKbdOpen] = useState(false)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])

  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  useGlobalShortcuts({ setKbdOpen, setSidebarOpen, locale, setLocale, toggleTheme, navigate })

  const email = user?.email || 'dev@preview'
  const { hash, pathname } = location

  return (
    <div className="flex h-screen">
      <aside className="hidden lg:flex w-56 flex-col border-r border-border bg-sidebar">
        <SidebarNav pathname={pathname} hash={hash} email={email} onLogout={handleLogout} />
      </aside>

      <div className="lg:hidden">
        <MobileSidebar
          open={sidebarOpen}
          onClose={closeSidebar}
          email={email}
          onLogout={handleLogout}
          pathname={pathname}
          hash={hash}
        />
      </div>

      <MainContent pathname={pathname} onOpenSidebar={() => setSidebarOpen(true)} />
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
