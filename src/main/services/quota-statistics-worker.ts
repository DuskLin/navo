import { parentPort, workerData } from 'node:worker_threads'
import { RequestHistory } from './request-history'
import { createRequestCostCalculator, type RequestPricing } from '../../shared/request-cost'
import { estimateQuotaCost, quotaCacheHitRate } from '../../shared/quota-cost'
import type { QuotaStatisticsTask } from './quota-statistics'

const history = new RequestHistory(workerData.file, true)
let pricing: RequestPricing
let calculate: ReturnType<typeof createRequestCostCalculator>
parentPort!.on(
  'message',
  ({
    id,
    tasks,
    pricing: next,
    now
  }: {
    id: number
    tasks: QuotaStatisticsTask[]
    pricing?: RequestPricing
    now: number
  }) => {
    try {
      if (next) {
        pricing = next
        calculate = createRequestCostCalculator(next)
      }
      const results = history.readSnapshot(() =>
        tasks.map((task) => {
          const duration = task.window === 'weekly' ? 7 * 86400000 : 5 * 3600000
          const reset = Date.parse(task.quota?.resetAt ?? '')
          const records =
            Number.isFinite(reset) && reset > now
              ? history.quotaUsage(
                  task.accountId,
                  Math.max(reset - duration, task.baseline?.start ?? -Infinity),
                  task.checkedAt
                )
              : []
          const estimate = estimateQuotaCost(
            task.quota,
            duration,
            task.checkedAt,
            records,
            pricing,
            now,
            calculate,
            task.baseline
          )
          estimate.cacheHitRate = quotaCacheHitRate(
            task.quota,
            duration,
            task.checkedAt,
            records,
            now,
            task.baseline
          )
          return { ...task, estimate }
        })
      )
      parentPort!.postMessage({ id, results })
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: error instanceof Error ? error.message : '额度统计失败'
      })
    }
  }
)
