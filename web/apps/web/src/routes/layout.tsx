import { Outlet, Link, useLocation, useNavigate } from 'react-router'
import { useEffect } from 'react'
import { MessageSquare, Briefcase, TrendingUp, Settings, LogOut, BarChart3, Moon, FileDown, BookOpen, Sun, Languages, Swords, Map, History, Filter, TrendingDown, type LucideIcon } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { MarketBar } from '@/components/market-bar'
import { usePreferences, type TranslationKey } from '@/lib/preferences'
import { trackRouteActivity } from '@/lib/activity'

const navItems = [
  { to: '/chat', icon: MessageSquare, labelKey: 'nav.chat' },
  { to: '/analysis', icon: BarChart3, labelKey: 'nav.analysis' },
  { to: '/battle', icon: Swords, labelKey: 'nav.battle' },
  { to: '/portfolio', icon: Briefcase, labelKey: 'nav.portfolio' },
  { to: '/history', icon: History, labelKey: 'nav.history' },
  { to: '/tracking', icon: TrendingUp, labelKey: 'nav.tracking' },
  { to: '/funnel', icon: Filter, labelKey: 'nav.funnel' },
  { to: '/backtest', icon: TrendingDown, labelKey: 'nav.backtest' },
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
  const user = useAuthStore((s) => s.user)
  const { t } = usePreferences()
  const handleLogout = useLogoutHandler()
  useRouteActivity(user?.id, location)

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 flex-col border-r border-border bg-sidebar">
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
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <MarketBar />
        <main className="flex-1 overflow-auto bg-background">
          <Outlet />
        </main>
      </div>
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
