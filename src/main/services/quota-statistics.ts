import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { AccountView, QuotaWindow } from '../../shared/contracts'
import type { RequestPricing } from '../../shared/request-cost'
import type { QuotaCostEstimate, QuotaUsageBaseline } from '../../shared/quota-cost'
import type { RequestHistory } from './request-history'

export interface QuotaStatisticsTask {
  key: string
  fingerprint: string
  accountId: string
  historyRevision: string
  window: 'fiveHour' | 'weekly'
  quota: QuotaWindow | null | undefined
  checkedAt: number
  baseline?: QuotaUsageBaseline
}
type Result = QuotaStatisticsTask & { estimate: QuotaCostEstimate }
type Job = {
  tasks: QuotaStatisticsTask[]
  pricing: RequestPricing
  pricingVersion: number
  version: string
  now: number
}

/** 持久化额度观测，后台缓存估算；始终最多一个运行任务和一个最新待处理任务。 */
export class QuotaStatistics {
  private worker?: Worker
  private workerPricingVersion = -1
  private active?: { id: number; job: Job }
  private pending?: Job
  private sequence = 0
  private cache = new Map<string, Result>()
  private wanted = new Map<string, string>()
  private closed = false
  private retryAt = 0
  private timer?: ReturnType<typeof setTimeout>
  private waiters = new Set<() => void>()

  constructor(
    private readonly file: string,
    private readonly history: RequestHistory,
    private readonly version: () => string
  ) {}

  apply(
    accounts: AccountView[],
    pricing: RequestPricing,
    pricingVersion: number,
    now = Date.now()
  ): void {
    if (this.closed) return
    const tasks: QuotaStatisticsTask[] = []
    this.wanted.clear()
    for (const account of accounts) {
      const caps = account.capabilities
      if (!caps?.quota) continue
      account.quotaEstimates = {}
      for (const window of ['fiveHour', 'weekly'] as const) {
        const quota = caps.quota[window]
        const reset = Date.parse(quota?.resetAt ?? '')
        const baseline = this.history.observeQuota(account.id, window, quota, caps.checkedAt)
        const key = JSON.stringify([account.id, window])
        const fingerprint = JSON.stringify([
          pricingVersion,
          this.history.quotaRevision(account.id),
          caps.checkedAt,
          quota,
          baseline,
          reset <= now
        ])
        const task = {
          key,
          fingerprint,
          accountId: account.id,
          historyRevision: this.history.quotaRevision(account.id),
          window,
          quota,
          checkedAt: caps.checkedAt,
          baseline
        }
        this.wanted.set(key, fingerprint)
        const cached = this.cache.get(key)
        if (cached?.fingerprint === fingerprint)
          account.quotaEstimates[window] = structuredClone(cached.estimate)
        else {
          // 同一有效周期保留整组上次结果，避免每次重算都先把数字清空。
          // 只改变返回的展示状态，不把旧结果当作新版本缓存或重复写入周期历史。
          account.quotaEstimates[window] =
            cached &&
            Number.isFinite(reset) &&
            reset > now &&
            cached.baseline?.start === baseline?.start &&
            Date.parse(cached.quota?.resetAt ?? '') === reset
              ? { ...structuredClone(cached.estimate), refreshing: true }
              : {
                  amounts: [],
                  reason: now < this.retryAt ? '额度估算暂不可用，稍后重试' : '额度估算更新中',
                  cacheHitRate: null
                }
          tasks.push(structuredClone(task))
        }
      }
    }
    for (const key of this.cache.keys()) if (!this.wanted.has(key)) this.cache.delete(key)
    this.pending = tasks.length
      ? { tasks, pricing, pricingVersion, version: this.version(), now }
      : undefined
    this.pump()
  }

  private pump(): void {
    if (this.closed || this.active || !this.pending || Date.now() < this.retryAt) {
      this.settle()
      return
    }
    const job = this.pending
    this.pending = undefined
    if (job.version !== this.version()) {
      this.settle()
      return
    }
    job.tasks = job.tasks.filter(
      (task) => this.cache.get(task.key)?.fingerprint !== task.fingerprint
    )
    if (!job.tasks.length) {
      this.settle()
      return
    }
    let worker: Worker
    try {
      worker =
        this.worker ??
        new Worker(join(__dirname, 'quota-statistics-worker.js'), {
          workerData: { file: this.file }
        })
      if (!this.worker) {
        this.worker = worker
        this.workerPricingVersion = -1
        worker.on(
          'message',
          ({ id, results, error }: { id: number; results?: Result[]; error?: string }) => {
            if (this.worker !== worker || this.active?.id !== id) return
            const current = this.active.job
            clearTimeout(this.timer)
            this.active = undefined
            worker.unref()
            if (error) this.retryAt = Date.now() + 5000
            else if (current.version === this.version()) {
              try {
                for (const result of results ?? []) {
                  if (this.wanted.get(result.key) !== result.fingerprint) continue
                  if (result.historyRevision !== this.history.quotaRevision(result.accountId))
                    continue
                  const reset = Date.parse(result.quota?.resetAt ?? '')
                  if (reset <= Date.now() && reset > current.now) continue
                  result.estimate.averages = this.history.quotaAverages(
                    result.accountId,
                    result.window,
                    result.quota?.resetAt,
                    result.checkedAt,
                    result.estimate
                  )
                  this.cache.set(result.key, result)
                }
              } catch {
                this.retryAt = Date.now() + 5000
              }
            }
            this.pump()
          }
        )
        worker.on('error', () => this.fail(worker))
        worker.on('exit', () => this.fail(worker))
      }
      const id = ++this.sequence
      this.active = { id, job }
      worker.ref()
      worker.postMessage({
        id,
        tasks: job.tasks,
        now: job.now,
        ...(this.workerPricingVersion === job.pricingVersion ? {} : { pricing: job.pricing })
      })
      this.workerPricingVersion = job.pricingVersion
      this.timer = setTimeout(() => this.fail(worker), 30000)
      this.timer.unref()
    } catch {
      if (this.worker) this.fail(this.worker)
      else this.retryAt = Date.now() + 5000
      this.settle()
    }
  }

  private fail(worker: Worker): void {
    if (this.worker !== worker) return
    clearTimeout(this.timer)
    this.worker = undefined
    this.active = undefined
    this.retryAt = Date.now() + 5000
    void worker.terminate()
    this.settle()
  }

  whenIdle(): Promise<void> {
    if (!this.active && (!this.pending || Date.now() < this.retryAt)) return Promise.resolve()
    return new Promise((resolve) => this.waiters.add(resolve))
  }
  private settle(): void {
    if (this.active || (this.pending && Date.now() >= this.retryAt)) return
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    this.pending = undefined
    this.active = undefined
    this.cache.clear()
    const worker = this.worker
    this.worker = undefined
    this.settle()
    if (worker) await worker.terminate()
  }
}
