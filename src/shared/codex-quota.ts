import type { AccountQuota, QuotaWindow } from './contracts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// 按窗口实际时长归类，不假定 primary 一定是 5 小时（部分套餐只有周或月窗口）。
export function parseCodexQuota(value: unknown, now = Date.now()): AccountQuota | null {
  const limits = record(record(value).rate_limit)
  const result: AccountQuota = {
    unit: 'percent',
    fiveHour: null,
    weekly: null,
    total: null,
    totalUnlimited: false
  }
  for (const raw of [limits.primary_window, limits.secondary_window]) {
    const data = record(raw)
    const used = data.used_percent
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) continue
    const key =
      data.limit_window_seconds === 18000
        ? 'fiveHour'
        : data.limit_window_seconds === 604800
          ? 'weekly'
          : data.limit_window_seconds === 2592000
            ? 'monthly'
            : null
    if (!key) continue
    const reset =
      typeof data.reset_at === 'number' && data.reset_at > 0
        ? data.reset_at * 1000
        : typeof data.reset_after_seconds === 'number' && data.reset_after_seconds >= 0
          ? now + data.reset_after_seconds * 1000
          : NaN
    const date = new Date(reset)
    const window: QuotaWindow = {
      limit: 100,
      used,
      remaining: Math.max(0, 100 - used),
      resetAt: Number.isFinite(date.getTime()) ? date.toISOString() : null
    }
    result[key] = window
  }
  return result.fiveHour || result.weekly || result.monthly ? result : null
}
