import { parentPort, workerData } from 'node:worker_threads'
import { RequestHistory } from './request-history'
import type { UsageQuery, UsageStats } from '../../shared/usage'
import { createRequestCostCalculator, type RequestPricing } from '../../shared/request-cost'

const history = new RequestHistory(workerData.file, true)
const cache = new Map<
  string,
  { version: number; at: number; expires: number; result: UsageStats }
>()
let currentPricing: RequestPricing | undefined
let currentPricingVersion: number | undefined
let currentCalculator: ReturnType<typeof createRequestCostCalculator> | undefined
parentPort!.on(
  'message',
  ({
    id,
    query,
    pricing,
    pricingVersion
  }: {
    id: number
    query: UsageQuery
    pricing?: RequestPricing
    pricingVersion?: number
  }) => {
    try {
      if (pricingVersion !== undefined) {
        if (pricing) {
          currentPricing = pricing
          currentPricingVersion = pricingVersion
          currentCalculator = createRequestCostCalculator(pricing)
        }
        if (currentPricingVersion !== pricingVersion) throw new Error('统计价格版本不一致，请重试')
        pricing = currentPricing
      }
      const key = JSON.stringify([
        query,
        pricingVersion === undefined ? pricing : { pricingVersion }
      ])
      const version = history.dataVersion
      const cached = cache.get(key)
      if (
        cached &&
        cached.version === version &&
        Date.now() >= cached.at &&
        Date.now() < cached.expires
      ) {
        parentPort!.postMessage({ id, result: cached.result })
        return
      }
      const at = Date.now()
      const result = history.usageSnapshot(
        query,
        pricing,
        pricingVersion === undefined ? undefined : currentCalculator
      )
      if (cache.size >= 8) cache.delete(cache.keys().next().value!)
      cache.set(key, { version, at, expires: history.usageCacheExpiry(query, at), result })
      parentPort!.postMessage({ id, result })
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: error instanceof Error ? error.message : '统计读取失败'
      })
    }
  }
)
