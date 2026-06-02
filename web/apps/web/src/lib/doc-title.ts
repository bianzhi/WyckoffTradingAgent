import { useEffect } from 'react'

/**
 * Set the document <title> for the current page.
 * Restores a default title on unmount.
 */
export function useDocTitle(title: string): void {
  useEffect(() => {
    const prev = document.title
    document.title = title
    return () => { document.title = prev }
  }, [title])
}
