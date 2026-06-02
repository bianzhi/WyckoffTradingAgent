import { ArrowUp } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * Scroll-to-top button — appears when user scrolls past a threshold.
 * Usage: <ScrollToTop /> at the bottom of any scrollable page container.
 */
export function ScrollToTop({ threshold = 300 }: { threshold?: number }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    function check() {
      setVisible(window.scrollY > threshold)
    }
    window.addEventListener('scroll', check, { passive: true })
    check()
    return () => window.removeEventListener('scroll', check)
  }, [threshold])

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Scroll to top"
      className={`fixed bottom-6 right-6 z-50 rounded-full border border-border bg-card p-2.5 shadow-md transition-all duration-200 hover:bg-muted ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0 pointer-events-none'
      }`}
    >
      <ArrowUp size={18} className="text-muted-foreground" />
    </button>
  )
}
