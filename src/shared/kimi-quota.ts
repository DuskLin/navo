import type { AccountQuota, QuotaWindow } from './contracts'

export const QUOTA_REFRESH_MS = 30_000
export const QUOTA_MAX_AGE_MS = 120_000

// 过期或已越过重置时间的数据不参与评分，也不能把旧的 0 额度永久锁死。
export function remainingRatio(
  window: QuotaWindow | null | undefined,
  checkedAt: number,
  now: number
): number | null {
  if (!window || now - checkedAt > QUOTA_MAX_AGE_MS) return null
  if (window.resetAt && Date.parse(window.resetAt) <= now) return null
  if (window.remaining === null || !Number.isFinite(window.remaining)) return null
  if (window.remaining === 0) return 0
  if (window.limit === null || !Number.isFinite(window.limit) || window.limit <= 0) return null
  return Math.max(0, Math.min(1, window.remaining / window.limit))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function number(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
export function quotaWindow(value: unknown): QuotaWindow | null {
  const data = record(value)
  const limit = number(data.limit ?? data.limit_amount)
  let used = number(data.used ?? data.used_amount)
  let remaining = number(data.remaining)
  if (limit === null && used === null && remaining === null) return null
  if (used === null && limit !== null && remaining !== null) used = Math.max(0, limit - remaining)
  if (remaining === null && limit !== null && used !== null) remaining = Math.max(0, limit - used)
  const reset = data.resetAt ?? data.resetTime ?? data.reset_time ?? data.reset_at
  const time = typeof reset === 'string' ? Date.parse(reset) : NaN
  return {
    limit,
    used,
    remaining,
    resetAt: Number.isFinite(time) ? new Date(time).toISOString() : null
  }
}
export function parseKimiQuota(value: unknown): AccountQuota | null {
  const data = record(value)
  const limits = Array.isArray(data.limits) ? data.limits : []
  const five = limits.map(record).find((item) => {
    const window = record(item.window)
    const duration = number(window.duration)
    const unit = String(window.timeUnit ?? window.time_unit ?? '').toUpperCase()
    return (
      (duration === 300 && unit.includes('MINUTE')) ||
      (duration === 5 && unit.includes('HOUR')) ||
      (duration === 18000 && unit.includes('SECOND'))
    )
  })
  const total = data.totalQuota ?? data.total_quota
  const result: AccountQuota = {
    fiveHour: quotaWindow(five?.detail ?? five),
    weekly: quotaWindow(data.usage),
    total: quotaWindow(total),
    totalUnlimited:
      !!total &&
      typeof total === 'object' &&
      !Array.isArray(total) &&
      Object.keys(total).length === 0
  }
  return result.fiveHour || result.weekly || result.total || result.totalUnlimited ? result : null
}
export function storedQuota(value: unknown): AccountQuota | null {
  if (!value) return null
  const data = record(value)
  return {
    fiveHour: quotaWindow(data.fiveHour),
    weekly: quotaWindow(data.weekly),
    ...(data.monthly !== undefined ? { monthly: quotaWindow(data.monthly) } : {}),
    ...(data.unit === 'percent' || data.unit === 'USD' ? { unit: data.unit } : {}),
    ...(number(data.extraCredits) !== null ? { extraCredits: number(data.extraCredits)! } : {}),
    total: quotaWindow(data.total),
    totalUnlimited: data.totalUnlimited === true
  }
}

export function hasCommandCodeExtraCredits(
  provider: string | undefined,
  quota: AccountQuota | null | undefined,
  checkedAt: number,
  now: number
): boolean {
  return (
    provider === 'commandcode-goat' &&
    now - checkedAt <= QUOTA_MAX_AGE_MS &&
    (quota?.extraCredits ?? 0) > 0
  )
}
