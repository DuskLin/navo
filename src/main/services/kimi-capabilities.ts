import { createHash } from 'node:crypto'
import {
  DEFAULT_ACCOUNT_CONCURRENCY,
  accountBaseUrl,
  type Provider,
  type AccountCapabilities,
  type Region
} from '../../shared/contracts'
import { commandCodeDate, parseCommandCodeQuota } from '../../shared/commandcode'
import { MODEL_PROTOCOLS } from '../../shared/model-protocols'
import { object, string } from './gateway-store'
import { parseKimiQuota } from '../../shared/kimi-quota'
import { parseDeepSeekBalance } from '../../shared/deepseek-balance'
import { MiniMaxQuotaError, parseMiniMaxQuota } from '../../shared/minimax'
import { parseOpenCodeGoQuota } from '../../shared/opencode-go'

export class CapabilityError extends Error {
  constructor(
    public readonly status: number,
    endpoint: string
  ) {
    super(
      status === 401 || status === 403
        ? 'API Key 无效或账号无权访问，请检查密钥与区域'
        : `读取上游${endpoint}失败 (${status})，请稍后重试`
    )
  }
}

// 只识别明确命名的并发字段，绝不能把 usage.limit、RPM、TPM 或上下文长度当作并发。
export function reportedConcurrency(data: unknown, headers: Headers): number | null {
  const root =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}
  const limits =
    root.limits && !Array.isArray(root.limits) && typeof root.limits === 'object'
      ? (root.limits as Record<string, unknown>)
      : {}
  const concurrency =
    root.concurrency && typeof root.concurrency === 'object'
      ? (root.concurrency as Record<string, unknown>)
      : {}
  const values = [
    root.parallel && typeof root.parallel === 'object'
      ? (root.parallel as Record<string, unknown>).limit
      : undefined,
    root.max_concurrency,
    root.maxConcurrency,
    limits.max_concurrency,
    concurrency.limit,
    headers.get('x-ratelimit-limit-concurrency'),
    headers.get('x-ratelimit-limit-concurrent-requests')
  ]
  const valid = values.flatMap((value) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return []
    const number = Number(value)
    return Number.isInteger(number) && number >= 0 && number <= 100000 ? [number] : []
  })
  return valid.length ? Math.min(...valid) : null
}

export class KimiCapabilities {
  private cache = new Map<string, AccountCapabilities>()
  private pending = new Map<string, Promise<AccountCapabilities>>()
  constructor(private readonly request: typeof fetch = fetch) {}

  async get(
    region: Region,
    key: string,
    force = false,
    provider: Provider = 'kimi',
    signal?: AbortSignal,
    headers?: Record<string, string>,
    baseUrl?: string
  ): Promise<AccountCapabilities> {
    // A cancellable background refresh must not cancel a shared foreground probe.
    if (signal || headers) {
      signal?.throwIfAborted()
      const result = await this.fetch(region, key, provider, signal, headers, baseUrl)
      signal?.throwIfAborted()
      return structuredClone(result)
    }
    const fingerprint = createHash('sha256')
      .update(`${provider}\0${region}\0${baseUrl ?? ''}\0${key}`)
      .digest('hex')
    const cached = this.cache.get(fingerprint)
    if (!force && cached && Date.now() - cached.checkedAt < 60000) return structuredClone(cached)
    let work = this.pending.get(fingerprint)
    if (!work) {
      work = this.fetch(region, key, provider, undefined, undefined, baseUrl)
      this.pending.set(fingerprint, work)
    }
    try {
      const result = await work
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(fingerprint, result)
      return structuredClone(result)
    } finally {
      if (this.pending.get(fingerprint) === work) this.pending.delete(fingerprint)
    }
  }

  private async read(
    url: string,
    key: string,
    signal: AbortSignal,
    label: string,
    headers?: Record<string, string>
  ) {
    let response: Response
    try {
      response = await this.request(url, {
        headers: {
          authorization: `Bearer ${key}`,
          accept: 'application/json',
          ...headers
        },
        signal,
        redirect: 'error'
      })
    } catch {
      throw new Error(`读取上游${label}超时或网络不可用，请重试`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new CapabilityError(response.status, label)
    }
    // 元数据也限定大小，错误响应不回显，避免把上游内容或凭据带入 IPC 错误。
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`上游${label}返回空响应`)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1024 * 1024) {
          await reader.cancel()
          throw new Error('响应过大')
        }
        chunks.push(value)
      }
      return {
        data: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
        headers: response.headers
      }
    } catch {
      throw new Error(`上游${label}响应格式无效或传输中断`)
    } finally {
      reader.releaseLock()
    }
  }

  private async fetch(
    region: Region,
    key: string,
    provider: Provider,
    parentSignal?: AbortSignal,
    headers?: Record<string, string>,
    baseUrl?: string
  ): Promise<AccountCapabilities> {
    const base = accountBaseUrl(region, provider, baseUrl)
    const timeout = AbortSignal.timeout(15000)
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout
    const models: string[] = []
    const modelProtocols: NonNullable<AccountCapabilities['modelProtocols']> = Object.create(null)
    const concurrency: number[] = []
    const cursors = new Set<string>()
    let next = `${base}/models`
    // 模型目录可能分页；只使用 last_id 构造同一官方地址的下一页。
    for (let page = 0; page < 20; page++) {
      const result = await this.read(next, key, signal, '模型列表', headers)
      if (!Array.isArray(result.data.data)) throw new Error('上游模型列表格式无效')
      for (const item of result.data.data) {
        const node = object(item)
        const id = string(node.id, '上游模型 ID', 200)
        models.push(id)
        if (provider === 'commandcode-goat' && Array.isArray(node.supported_endpoints)) {
          const protocols = MODEL_PROTOCOLS.filter((p) =>
            (node.supported_endpoints as unknown[]).some(
              (endpoint) => endpoint === p.route || endpoint === p.route.slice(3)
            )
          ).map((p) => p.value)
          if (protocols.length) modelProtocols[id] = protocols
        }
      }
      const limit = reportedConcurrency(result.data, result.headers)
      if (limit !== null) concurrency.push(limit)
      if (!result.data.has_more) break
      const cursor = string(result.data.last_id, '模型分页游标', 200)
      if (cursors.has(cursor) || page === 19) throw new Error('上游模型列表分页异常')
      cursors.add(cursor)
      next = `${base}/models?after=${encodeURIComponent(cursor)}`
    }
    if (models.length > 2000) throw new Error('上游模型列表过大')
    let warning =
      provider === 'commandcode-goat'
        ? '模型目录为公开列表，具体模型的套餐权限请通过模型测试确认'
        : ''
    let quota = null
    let balance = null
    // 无论模型接口是否报告并发，都查询用量，以同步真实额度及 parallel.limit。
    try {
      if (provider === 'commandcode-goat') {
        const alpha = 'https://api.commandcode.ai/alpha'
        const authHeaders = { 'user-agent': 'cli', ...headers }
        const whoami = await this.read(`${alpha}/whoami`, key, signal, '账号信息', authHeaders)
        const org = object(whoami.data.org ?? {})
        const params = new URLSearchParams()
        if (typeof org.id === 'string' && org.id) params.set('orgId', org.id)
        const endpoint = (path: string) => `${alpha}/${path}${params.size ? `?${params}` : ''}`
        const optional = async (path: string, label: string) => {
          try {
            return (await this.read(endpoint(path), key, signal, label, authHeaders)).data
          } catch (error) {
            if (error instanceof CapabilityError && (error.status === 401 || error.status === 403))
              throw error
            warning += `；${label}暂不可用`
            return undefined
          }
        }
        const results = await Promise.allSettled([
          this.read(endpoint('billing/credits'), key, signal, '额度', authHeaders),
          optional('billing/subscriptions', '订阅账期')
        ])
        for (const result of results) {
          if (
            result.status === 'rejected' &&
            result.reason instanceof CapabilityError &&
            (result.reason.status === 401 || result.reason.status === 403)
          )
            throw result.reason
        }
        const [creditResult, subscriptionResult] = results
        if (creditResult.status === 'rejected') throw creditResult.reason
        if (subscriptionResult.status === 'rejected') throw subscriptionResult.reason
        const credits = creditResult.value
        const subscription = subscriptionResult.value
        const start = commandCodeDate(object(subscription?.data ?? {}).currentPeriodStart)
        // Without a known billing period, do not mix lifetime spend into this cycle.
        let summary: Record<string, unknown> | undefined
        if (start) {
          params.set('since', start)
          summary = await optional('usage/summary', '账期用量')
        }
        quota = parseCommandCodeQuota(credits.data, subscription, summary)
        if (!quota) warning += '；上游未返回有效额度数据'
        const limit = reportedConcurrency(credits.data, credits.headers)
        if (limit !== null) concurrency.push(limit)
      }
      if (provider !== 'custom' && provider !== 'commandcode-goat') {
        const usage = await this.read(
          provider === 'deepseek'
            ? 'https://api.deepseek.com/user/balance'
            : provider === 'minimax'
              ? `${base}/api/openplatform/coding_plan/remains`
              : `${base}/${provider === 'opencode-go' ? 'usage' : 'usages'}`,
          key,
          signal,
          provider === 'deepseek' ? '余额' : '额度与并发信息',
          headers
        )
        const limit = reportedConcurrency(usage.data, usage.headers)
        if (limit !== null) concurrency.push(limit)
        if (provider === 'deepseek') balance = parseDeepSeekBalance(usage.data)
        else {
          quota =
            provider === 'minimax'
              ? parseMiniMaxQuota(usage.data)
              : provider === 'opencode-go'
                ? parseOpenCodeGoQuota(usage.data)
                : parseKimiQuota(usage.data)
          if (!quota) warning = '上游未返回额度数据'
        }
      }
    } catch (error) {
      // 套餐接口的业务错误及鉴权失败必须阻止保存无效密钥。
      if (error instanceof MiniMaxQuotaError) throw error
      if (
        (provider === 'opencode-go' || provider === 'minimax' || provider === 'commandcode-goat') &&
        error instanceof CapabilityError &&
        (error.status === 401 || error.status === 403)
      )
        throw error
      warning = error instanceof Error ? error.message : '上游额度与并发信息读取失败'
    }
    const maxConcurrency = concurrency.length ? Math.min(...concurrency) : null
    parentSignal?.throwIfAborted()
    if (maxConcurrency === null)
      warning = `${warning ? warning + '；' : ''}未获取到并发上限，使用默认 ${DEFAULT_ACCOUNT_CONCURRENCY} 个并发调度`
    return {
      models: [...new Set(models)],
      ...(provider === 'commandcode-goat' ? { modelProtocols } : {}),
      maxConcurrency,
      checkedAt: Date.now(),
      warning,
      quota,
      ...(provider === 'deepseek' ? { balance } : {})
    }
  }
}
