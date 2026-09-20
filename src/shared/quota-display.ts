import type { AccountBalance, AccountQuota, QuotaWindow } from './contracts'

export function hasQuotaWindow(window: QuotaWindow | null | undefined): boolean {
  return (
    !!window &&
    [window.limit, window.used, window.remaining].some(
      (value) => typeof value === 'number' && Number.isFinite(value)
    )
  )
}

/** Missing metadata is not a quota; zero remaining is still meaningful data. */
export function hasQuotaDisplay(
  value: { quota?: AccountQuota | null; balance?: AccountBalance | null } | null | undefined
): boolean {
  return (
    [value?.quota?.fiveHour, value?.quota?.weekly, value?.quota?.monthly].some(hasQuotaWindow) ||
    !!value?.balance?.balances.length
  )
}
