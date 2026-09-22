import type { QuotaWindow, RequestRecord } from './contracts'
import { createRequestCostCalculator, type RequestPricing } from './request-cost'

export interface QuotaCycleQuery {
  accountId: string
  window: 'fiveHour' | 'weekly'
}
export interface QuotaCycleExclusion extends QuotaCycleQuery {
  resetAt: string
  excluded: boolean
}
export interface QuotaCostCycle {
  resetAt: string
  checkedAt: number
  excluded: boolean
  amounts: { currency: 'USD' | 'CNY'; total: number }[]
}

export interface QuotaCostEstimate {
  reason?: string
  cacheHitRate?: number | null
  averages?: { currency: 'USD' | 'CNY'; total: number; cycles: number }[]
  amounts: { currency: 'USD' | 'CNY'; used: number; total: number; remaining: number }[]
}

/** Token-weighted cache hits for the same observed quota cycle, independent of monetary pricing. */
export function quotaCacheHitRate(
  window: QuotaWindow | null | undefined,
  durationMs: number,
  checkedAt: number,
  records: RequestRecord[],
  now = Date.now()
): number | null {
  const reset = Date.parse(window?.resetAt ?? '')
  const start = reset - durationMs
  if (
    !Number.isFinite(reset) ||
    reset <= now ||
    !Number.isFinite(checkedAt) ||
    checkedAt < start ||
    checkedAt >= reset
  )
    return null
  let hits = 0
  let inputs = 0
  for (const record of records) {
    if (record.time < start || record.time + record.durationMs > checkedAt) continue
    const usage = record.usage
    // Missing cache-read counts are unknown, not cache misses. Cache writes are a separate input category.
    if (usage?.input == null || usage.cacheRead == null) continue
    const counts = [usage.input, usage.cacheRead, usage.cacheWrite ?? 0]
    if (counts.some((value) => !Number.isFinite(value) || value < 0)) continue
    hits += usage.cacheRead
    inputs += counts.reduce((sum, value) => sum + value, 0)
  }
  return inputs > 0 ? hits / inputs : null
}

/** Match the fixed quota cycle and the observation time, never today's usage or a rounded UI percent. */
export function estimateQuotaCost(
  window: QuotaWindow | null | undefined,
  durationMs: number,
  checkedAt: number,
  records: RequestRecord[],
  pricing: RequestPricing,
  now = Date.now(),
  calculate = createRequestCostCalculator(pricing)
): QuotaCostEstimate {
  const unavailable = (reason: string): QuotaCostEstimate => ({ amounts: [], reason })
  if (!window) return unavailable('暂无额度数据')
  const reset = Date.parse(window.resetAt ?? '')
  if (!Number.isFinite(reset)) return unavailable('缺少周期时间')
  if (reset <= now) return unavailable('等待额度刷新')
  const start = reset - durationMs
  if (!Number.isFinite(checkedAt) || checkedAt < start || checkedAt >= reset)
    return unavailable('等待额度刷新')
  const { limit, remaining } = window
  if (
    limit == null ||
    remaining == null ||
    !Number.isFinite(limit) ||
    !Number.isFinite(remaining) ||
    limit <= 0 ||
    remaining < 0 ||
    remaining > limit
  )
    return unavailable('额度比例无效')
  const usedRatio = 1 - remaining / limit
  if (usedRatio === 0) return unavailable('待产生用量')
  const amounts = new Map<'USD' | 'CNY', number>()
  for (const record of records) {
    // Exclude requests crossing either observation boundary: their cost cannot be aligned reliably.
    if (record.time < start || record.time + record.durationMs > checkedAt) continue
    for (const amount of calculate(record).amounts)
      amounts.set(amount.currency, (amounts.get(amount.currency) ?? 0) + amount.value)
  }
  if (![...amounts.values()].some((value) => value > 0))
    return unavailable('缺少周期用量或模型价格')
  return {
    amounts: [...amounts]
      .filter(([, value]) => value > 0)
      .map(([currency, used]) => ({
        currency,
        used,
        total: used / usedRatio,
        remaining: (used / usedRatio) * (remaining / limit)
      }))
  }
}
