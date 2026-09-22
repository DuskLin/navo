import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { UsageQuery, UsageStats } from '../../shared/usage'
import type { RequestPricing } from '../../shared/request-cost'

/** Keep synchronous SQLite scans off the gateway's event loop. */
export class UsageService {
  private worker?: Worker
  private closed = false
  private sequence = 0
  private workerPricingVersion?: number
  private pending = new Map<
    number,
    {
      resolve: (result: UsageStats) => void
      reject: (error: Error) => void
    }
  >()
  private inFlight = new Map<string, Promise<UsageStats>>()

  constructor(private readonly file: string) {}

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(join(__dirname, 'request-history-worker.js'), {
      workerData: { file: this.file }
    })
    this.worker = worker
    this.workerPricingVersion = undefined
    const fail = (error: Error) => {
      if (this.worker !== worker) return
      this.worker = undefined
      for (const job of this.pending.values()) job.reject(error)
      this.pending.clear()
      void worker.terminate()
    }
    worker.on(
      'message',
      ({ id, result, error }: { id: number; result: UsageStats; error?: string }) => {
        const job = this.pending.get(id)
        if (!job) return
        this.pending.delete(id)
        if (error) job.reject(new Error(error))
        else job.resolve(result)
        if (!this.pending.size) worker.unref()
      }
    )
    worker.on('error', () => fail(new Error('统计服务异常，请重试')))
    worker.on('exit', () => fail(new Error('统计服务已退出，请重试')))
    worker.unref()
    return worker
  }

  usage(query: UsageQuery, pricing?: RequestPricing, pricingVersion?: number): Promise<UsageStats> {
    if (this.closed) return Promise.reject(new Error('统计服务已关闭'))
    const key = JSON.stringify([query, pricingVersion === undefined ? pricing : { pricingVersion }])
    const existing = this.inFlight.get(key)
    if (existing) return existing
    if (this.pending.size >= 16) return Promise.reject(new Error('统计查询繁忙，请稍后重试'))
    const id = ++this.sequence
    const work = new Promise<UsageStats>((resolve, reject) => {
      const worker = this.start()
      this.pending.set(id, { resolve, reject })
      worker.ref()
      try {
        worker.postMessage({
          id,
          query,
          pricingVersion,
          ...(pricingVersion !== undefined && this.workerPricingVersion === pricingVersion
            ? {}
            : { pricing })
        })
        if (pricingVersion !== undefined) this.workerPricingVersion = pricingVersion
      } catch (error) {
        this.pending.delete(id)
        if (!this.pending.size) worker.unref()
        reject(error)
      }
    }).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, work)
    return work
  }

  async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    this.worker = undefined
    for (const job of this.pending.values()) job.reject(new Error('统计服务已关闭'))
    this.pending.clear()
    if (worker) await worker.terminate()
  }
}
