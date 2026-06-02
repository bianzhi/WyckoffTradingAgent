/**
 * 相对时间工具 — 将日期字符串格式化为相对时间显示。
 * 例如 "5分钟前"、"2小时前"、"3天前"
 */
export type TimeLocale = 'zh-CN' | 'en-US'

const MINUTE = 60
const HOUR = 3600
const DAY = 86400
const WEEK = 604800
const MONTH = 2592000

const ZH_UNITS = {
  justNow: '刚刚',
  minute: '分钟前',
  hour: '小时前',
  day: '天前',
  week: '周前',
  month: '个月前',
  yesterday: '昨天',
}

const EN_UNITS = {
  justNow: 'just now',
  minute: 'm ago',
  hour: 'h ago',
  day: 'd ago',
  week: 'w ago',
  month: 'mo ago',
  yesterday: 'yesterday',
}

export function relativeTime(dateStr: string | undefined | null, locale: TimeLocale = 'zh-CN'): string | null {
  if (!dateStr) return null
  const u = locale === 'en-US' ? EN_UNITS : ZH_UNITS
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  const now = Date.now()
  const delta = Math.floor((now - d.getTime()) / 1000)

  if (delta < 60) return u.justNow
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}${u.minute}`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}${u.hour}`

  // Check if yesterday
  const yesterday = new Date(now - DAY)
  if (d.toDateString() === yesterday.toDateString()) return u.yesterday

  if (delta < WEEK) return `${Math.floor(delta / DAY)}${u.day}`
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}${u.week}`

  return `${Math.floor(delta / MONTH)}${u.month}`
}

/**
 * 格式化日期为 YYYY-MM-DD 或根据 locale 显示月/日格式
 */
export function formatDate(dateStr: string | undefined | null, locale: TimeLocale = 'zh-CN'): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  if (locale === 'en-US') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
