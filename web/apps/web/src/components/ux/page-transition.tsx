import { useEffect, useState, type ReactNode } from 'react'

/**
 * Wraps children with a CSS page-enter animation on mount.
 * Usage: <PageTransition><Outlet /></PageTransition>
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // Trigger enter animation on next frame after mount
    const frame = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className={mounted ? 'page-enter page-enter-active' : 'page-enter'}>
      {children}
    </div>
  )
}
