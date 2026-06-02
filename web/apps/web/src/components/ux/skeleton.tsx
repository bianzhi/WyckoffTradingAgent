/**
 * 骨架屏组件 — 替代 spinner 的加载占位符。
 * 支持多种预设形态：行、卡片、表格、图表占位。
 */

function pulse() {
  return 'animate-pulse rounded bg-muted/60'
}

export function SkeletonLine({ w = 'full', h = 'h-4' }: { w?: string; h?: string }) {
  const widthClass = w === 'full' ? '' : `w-[${w}]`
  return <div className={`${pulse()} ${h} ${widthClass}`} style={w !== 'full' ? { width: w } : undefined} />
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-xl border border-border p-4 space-y-3">
      <SkeletonLine w="60%" h="h-5" />
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} w={i === lines - 1 ? '40%' : '100%'} />
      ))}
    </div>
  )
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="grid gap-0 bg-muted/30 px-4 py-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonLine key={i} w={`${50 + Math.random() * 30}%`} h="h-3" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid gap-0 border-t border-border/50 px-4 py-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonLine key={c} w={c === 0 ? '30%' : `${60 + Math.random() * 30}%`} h="h-3" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonChart({ height = 320 }: { height?: number }) {
  return (
    <div className={`${pulse()} rounded-lg border border-border flex items-center justify-center`} style={{ height }}>
      <span className="text-xs text-muted-foreground/40">⏳</span>
    </div>
  )
}
