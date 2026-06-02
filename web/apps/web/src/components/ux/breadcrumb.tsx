import { ChevronRight } from 'lucide-react'

export interface BreadcrumbItem {
  label: string
  href?: string
}

/**
 * Simple breadcrumb bar — shows a trail of links + current page.
 */
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={item.label} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight size={14} className="text-muted-foreground/40" />}
            {isLast || !item.href ? (
              <span className="text-muted-foreground">{item.label}</span>
            ) : (
              <a href={item.href} className="text-primary hover:underline">{item.label}</a>
            )}
          </span>
        )
      })}
    </nav>
  )
}
