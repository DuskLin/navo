import type { AccountQuota, QuotaWindow } from './contracts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function amount(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null
}
export function commandCodeDate(value: unknown): string | null {
  // Unstarted windows use 0; never render that sentinel as January 1970.
  const numeric =
    typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))
      ? Number(value)
      : NaN
  const time = Number.isFinite(numeric)
    ? numeric > 0
      ? numeric * (numeric < 1e12 ? 1000 : 1)
      : NaN
    : typeof value === 'string'
      ? Date.parse(value)
      : NaN
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function window(value: unknown): QuotaWindow | null {
  const data = record(value)
  const limit = amount(data.cap)
  const used = amount(data.used)
  const remaining =
    data.exceeded === true ? 0 : limit !== null && used !== null ? Math.max(0, limit - used) : null
  return limit === null && used === null && remaining === null
    ? null
    : {
        limit,
        used,
        remaining,
        resetAt: commandCodeDate(data.resetAt)
      }
}

// Official CLI 1.58.1: credits are remaining balances; window resetAt can be an epoch timestamp or zero for an unstarted window.
// Summary spend can include purchased credits, so it must not become monthly plan usage.
export function parseCommandCodeQuota(
  credits: unknown,
  subscription?: unknown,
  summary?: unknown
): AccountQuota | null {
  const root = record(credits)
  const balances = record(root.credits)
  const limits = record(root.windowLimits)
  const monthly = amount(balances.monthlyCredits)
  const purchased = amount(balances.purchasedCredits)
  const free = amount(balances.freeCredits)
  const extraCredits = purchased !== null && free !== null ? purchased + free : null
  const total = monthly !== null && extraCredits !== null ? monthly + extraCredits : null
  const quota: AccountQuota = {
    unit: 'USD',
    ...(extraCredits !== null ? { extraCredits } : {}),
    fiveHour: limits.limited === false ? null : window(limits.fiveHour),
    weekly: limits.limited === false ? null : window(limits.weekly),
    monthly:
      monthly === null
        ? null
        : {
            limit: null,
            used: null,
            remaining: monthly,
            resetAt: commandCodeDate(record(record(subscription).data).currentPeriodEnd)
          },
    total:
      total === null
        ? null
        : { limit: null, remaining: total, used: amount(record(summary).totalCost), resetAt: null },
    totalUnlimited: false
  }
  return quota.fiveHour || quota.weekly || quota.monthly || quota.total ? quota : null
}
