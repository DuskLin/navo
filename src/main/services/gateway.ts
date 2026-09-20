import { testAccountModel } from './account-model-test'
import { MODEL_PROTOCOLS } from '../../shared/model-protocols'
import { CodexAuth, codexHeaders, codexRequest } from './codex-auth'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { LiveFlowTracker } from './live-flow'
import { harnessById } from '../../shared/live-flow'
import { lanAddresses, isPrivateIPv4 } from './lan-addresses'
import { pipeline } from 'node:stream/promises'
import {
  upstreamUrl,
  type AccountCapabilities,
  type AccountModelTestResult,
  type GatewaySnapshot,
  type RequestRecord,
  type Region
} from '../../shared/contracts'
import {
  GatewayStore,
  capabilityFields,
  object,
  string,
  validateAccount,
  validateProvider,
  validateGateway
} from './gateway-store'
import { ModelPriceCatalog } from './model-price-catalog'
import { registryModels } from './model-registry'
import { KimiCapabilities } from './kimi-capabilities'
import { Scheduler } from './scheduler'
import { FirstTokenObserver } from './first-token'
import { RequestHistory } from './request-history'
import { ResponseIdsObserver, validRequestId } from './response-ids'
import type { TokenUsage, UsageProtocol } from '../../shared/usage'
import { QUOTA_REFRESH_MS } from '../../shared/kimi-quota'
import { estimateQuotaCost, quotaCacheHitRate } from '../../shared/quota-cost'
import { requestSessionId } from '../../shared/request-session'
import { openCodeSession } from '../../shared/opencode-go'
import { modelUpstreamRoute } from '../../shared/model-protocols'
import {
  convertRequest,
  estimateInputTokens,
  ProtocolError,
  routeProtocol,
  type Wire
} from './protocol-request'
import { convertResponse } from './protocol-response'

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
  }
}
const routes = new Set([
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/models',
  '/api.json'
])
const retryable = (status: number): boolean =>
  [401, 403, 408, 429].includes(status) || status >= 500
function matchesKey(value: string, key: string): boolean {
  const a = Buffer.from(value),
    b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}
function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(
    JSON.stringify({
      type: 'error',
      error: {
        type:
          status === 401
            ? 'authentication_error'
            : status === 400
              ? 'invalid_request_error'
              : 'api_error',
        message
      }
    })
  )
}
async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const limit = 8 * 1024 * 1024
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, '请求体超过 8 MB')
  const chunks: Buffer[] = []
  let bytes = 0
  // 不销毁读流，使超限时仍能返回结构化错误。
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > limit) throw new HttpError(413, '请求体超过 8 MB')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
export class Gateway {
  readonly pricing: ModelPriceCatalog
  readonly scheduler = new Scheduler()
  readonly liveFlows: LiveFlowTracker
  private readonly capabilities: KimiCapabilities
  private server?: Server
  private controllers = new Set<AbortController>()
  private activityListeners = new Set<(count: number) => void>()
  onActiveRequestsChange(listener: (count: number) => void): () => void {
    this.activityListeners.add(listener)
    listener(this.controllers.size)
    return () => {
      this.activityListeners.delete(listener)
    }
  }
  private notifyActivity(): void {
    for (const listener of this.activityListeners) listener(this.controllers.size)
  }
  private activeRequests = new Set<Promise<void>>()
  private transitions: Promise<unknown> = Promise.resolve()
  readonly codex: CodexAuth
  private error = ''
  private requests: RequestRecord[] = []
  readonly history: RequestHistory
  private refreshTimer?: ReturnType<typeof setInterval>
  private refreshWork?: Promise<void>
  private refreshController?: AbortController
  constructor(
    readonly store: GatewayStore,
    private readonly request: typeof fetch = fetch,
    metadataRequest: typeof fetch = request,
    catalogRequest: typeof fetch = fetch
  ) {
    this.liveFlows = new LiveFlowTracker(
      Date.now,
      () => (this.store.get().settings.flowIdleMinutes ?? 5) * 60000
    )
    this.pricing = new ModelPriceCatalog(store.priceCachePath, catalogRequest)
    this.codex = new CodexAuth(store, metadataRequest)
    this.capabilities = new KimiCapabilities(metadataRequest)
    this.history = new RequestHistory(store.historyPath)
    this.requests = this.history.page().records
  }
  snapshot(): GatewaySnapshot {
    const data = this.store.get()
    const snapshot: GatewaySnapshot = {
      activeRequestCount: this.controllers.size,
      liveFlows: this.liveFlows.snapshot(),
      settings: data.settings,
      modelPrices: data.modelPrices,
      quotaCardOrder: data.quotaCardOrder,
      modelPriceCatalog: this.pricing.snapshot(),
      groups: data.groups.map(({ key: _key, ...group }) => group),
      accounts: data.accounts.map(({ credential, ...account }) => ({
        ...account,
        hasCredential: !!credential.accessToken,
        runtime: { ...this.scheduler.state(account.id) }
      })),
      running: this.server?.listening ?? false,
      baseUrl: `http://127.0.0.1:${data.settings.port}`,
      lanBaseUrls: data.settings.lanSharing
        ? lanAddresses().map((address) => `http://${address}:${data.settings.port}`)
        : [],
      error: this.error,
      requests: [...this.requests]
    }
    for (const account of snapshot.accounts) {
      const caps = account.capabilities
      if (!caps?.quota) continue
      account.quotaEstimates = {}
      for (const [key, duration] of [
        ['fiveHour', 5 * 3600000],
        ['weekly', 7 * 86400000]
      ] as const) {
        const window = caps.quota[key]
        const reset = Date.parse(window?.resetAt ?? '')
        const records =
          Number.isFinite(reset) && reset > Date.now()
            ? this.history.quotaUsage(account.id, reset - duration, caps.checkedAt)
            : []
        account.quotaEstimates[key] = estimateQuotaCost(
          window,
          duration,
          caps.checkedAt,
          records,
          snapshot
        )
        account.quotaEstimates[key].averages = this.history.quotaAverages(
          account.id,
          key,
          window?.resetAt,
          caps.checkedAt,
          account.quotaEstimates[key]
        )
        account.quotaEstimates[key].cacheHitRate = quotaCacheHitRate(
          window,
          duration,
          caps.checkedAt,
          records
        )
      }
    }
    return snapshot
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.transitions.then(action)
    this.transitions = pending.catch(() => {})
    return pending
  }
  setRunning(value: unknown): Promise<GatewaySnapshot> {
    if (typeof value !== 'boolean') return Promise.reject(new Error('网关开关无效'))
    return this.exclusive(async () => {
      if (value) await this.start()
      else {
        if (this.controllers.size) throw new Error('网关使用中，请在请求结束后重试')
        await this.stop()
      }
      return this.snapshot()
    })
  }
  shutdown(): Promise<void> {
    return this.exclusive(async () => {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
      this.refreshController?.abort(new Error('应用正在退出'))
      await this.stop()
      await this.refreshWork
    })
  }
  /** Account monitoring belongs to the application lifecycle, not the HTTP listener. */
  startAccountRefresh(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => void this.refreshStaleAccounts(), QUOTA_REFRESH_MS)
    this.refreshTimer.unref()
    void this.refreshStaleAccounts()
  }
  private async start(): Promise<void> {
    if (this.server?.listening) return
    // 首次启动也保存生成的分组密钥，保证下次启动连接配置仍然有效。
    await this.store.mutate(() => {})
    const server = createServer((req, res) => {
      const pending = this.handle(req, res)
      this.activeRequests.add(pending)
      void pending.finally(() => this.activeRequests.delete(pending))
    })
    server.maxConnections = 256
    server.headersTimeout = 15000
    server.requestTimeout = 30000
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        const settings = this.store.get().settings
        server.listen(settings.port, settings.lanSharing ? '0.0.0.0' : '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      this.server = server
      this.error = ''
      void this.refreshStaleAccounts()
      server.on('error', () => {
        this.error = '本地网关发生监听错误，请停止后重新启动'
      })
    } catch (error) {
      this.error =
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? '端口已被占用，请在网关设置中更换端口'
          : '本地网关启动失败，请检查端口与系统权限'
      throw new Error(this.error)
    }
  }
  private async stop(): Promise<void> {
    const server = this.server
    for (const controller of this.controllers) controller.abort(new Error('网关已停止'))
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    this.server = undefined
    await Promise.allSettled([...this.activeRequests])
    this.error = ''
  }
  async saveSettings(value: unknown): Promise<GatewaySnapshot> {
    const settings = validateGateway(value)
    return this.exclusive(async () => {
      if (this.server?.listening && settings.port !== this.store.get().settings.port)
        throw new Error('请先停止网关再更换端口')
      if (
        this.server?.listening &&
        !!settings.lanSharing !== !!this.store.get().settings.lanSharing
      )
        throw new Error('请先停止网关再切换局域网共享')
      await this.store.mutate((data) => {
        data.settings = settings
      })
      return this.snapshot()
    })
  }
  async importCodexAccount(): Promise<GatewaySnapshot> {
    const id = await this.codex.importLocal()
    this.scheduler.reset(id)
    return this.snapshot()
  }
  async saveAccount(value: unknown): Promise<GatewaySnapshot> {
    const input = validateAccount(value, this.store.get().groups)
    const old = this.store.get().accounts.find((a) => a.id === input.id)
    if (input.id && !old) throw new Error('账号不存在')
    if (old && old.provider !== input.provider && !input.secret)
      throw new Error('切换供应商请填写新的 API Key')
    if (input.provider === 'codex') {
      if (!old || old.provider !== 'codex') throw new Error('请先导入本地 Codex 认证')
      await this.store.saveAccount(input, old.capabilities ?? undefined)
      return this.snapshot()
    }
    const key = input.secret || old?.credential.accessToken
    if (!key) throw new Error('请填写 API Key')
    const needsRefresh =
      !old?.capabilities ||
      old.capabilities.quota === undefined ||
      old.region !== input.region ||
      old.provider !== input.provider ||
      old.credential.accessToken !== key
    const capabilities = needsRefresh
      ? await this.capabilities.get(input.region, key, false, input.provider)
      : old.capabilities!
    const id = await this.store.saveAccount(input, capabilities, key)
    if (input.secret || !input.id) this.scheduler.reset(id)
    this.scheduler.prune(this.store.get().accounts)
    return this.snapshot()
  }
  async inspectAccount(value: unknown): Promise<AccountCapabilities> {
    const input = object(value)
    if (!['mainland-cn', 'global'].includes(input.region as string)) throw new Error('账号区域无效')
    const old = input.id
      ? this.store.get().accounts.find((a) => a.id === string(input.id, '账号 ID'))
      : undefined
    if (input.id && !old) throw new Error('账号不存在')
    const provider = validateProvider(input.provider ?? old?.provider)
    if (old && provider !== old.provider && !input.secret)
      throw new Error('切换供应商请填写新的 API Key')
    if (provider === 'codex') {
      if (!old || old.provider !== 'codex') throw new Error('请先导入本地 Codex 认证')
      return this.codex.models(await this.codex.credential(old.id))
    }
    const key = input.secret ? string(input.secret, 'API Key', 16384) : old?.credential.accessToken
    if (!key || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('请填写有效的 API Key')
    return this.capabilities.get(input.region as Region, key, false, provider)
  }
  private recordRequest(record: RequestRecord): void {
    try {
      this.history.append(record)
    } catch {
      this.error = '请求记录保存失败，请检查磁盘空间与文件权限'
    }
    this.requests.unshift(record)
    this.requests = this.requests.slice(0, 10)
  }
  async testAccountModel(value: unknown): Promise<AccountModelTestResult> {
    const input = object(value)
    const model = string(input.model, '模型 ID', 200)
    if (/[\s\x00-\x1f\x7f]/.test(model)) throw new Error('模型 ID 无效')
    const protocol = MODEL_PROTOCOLS.find((p) => p.value === input.protocol)?.value
    if (!protocol) throw new Error('测试协议无效')
    if (!['mainland-cn', 'global'].includes(input.region as string)) throw new Error('账号区域无效')
    const old = input.id
      ? this.store.get().accounts.find((a) => a.id === string(input.id, '账号 ID'))
      : undefined
    if (input.id && !old) throw new Error('账号不存在')
    const provider = validateProvider(input.provider ?? old?.provider)
    if (old && provider !== old.provider && !input.secret)
      throw new Error('切换供应商请填写新的 API Key')
    if (provider === 'codex' && (!old || old.provider !== 'codex'))
      throw new Error('请先导入本地 Codex 认证')
    if (provider === 'codex' && protocol !== 'responses')
      throw new Error('Codex 仅支持 Responses 测试')
    const credential =
      provider === 'codex'
        ? await this.codex.credential(old!.id)
        : {
            accessToken: input.secret
              ? string(input.secret, 'API Key', 16384)
              : (old?.credential.accessToken ?? '')
          }
    if (!credential.accessToken || /[\s\x00-\x1f\x7f]/.test(credential.accessToken))
      throw new Error('请填写有效的 API Key')
    const started = Date.now()
    const sameAccount =
      old &&
      old.provider === provider &&
      old.region === input.region &&
      (provider === 'codex' || old.credential.accessToken === credential.accessToken)
    const draftName = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : ''
    return testAccountModel(
      { model, protocol, provider, region: input.region as Region },
      credential,
      this.request,
      (telemetry) =>
        this.recordRequest({
          id: randomUUID(),
          time: started,
          group: '模型测试',
          account: sameAccount ? old.name : `${draftName || old?.name || '新账号'}（未保存配置）`,
          accountId: sameAccount ? old.id : undefined,
          provider,
          protocol,
          model,
          attempts: 1,
          ...telemetry
        })
    )
  }
  async refreshAccount(value: unknown, signal?: AbortSignal): Promise<GatewaySnapshot> {
    const id = string(value, '账号 ID')
    const old = this.store.get().accounts.find((a) => a.id === id)
    if (!old?.credential.accessToken) throw new Error('请先填写 API Key')
    const credential =
      old.provider === 'codex' ? await this.codex.credential(old.id) : old.credential
    const capabilities =
      old.provider === 'codex'
        ? await this.codex.models(credential, signal)
        : await this.capabilities.get(
            old.region,
            old.credential.accessToken,
            true,
            old.provider,
            signal
          )
    signal?.throwIfAborted()
    await this.store.mutate((data) => {
      signal?.throwIfAborted()
      const account = data.accounts.find((a) => a.id === id)
      if (
        !account ||
        account.region !== old.region ||
        account.provider !== old.provider ||
        account.credential.accessToken !== credential.accessToken
      )
        throw new Error('账号已变更，请重新同步')
      // 用量接口失败时保留上次真实额度及其时间，不能把旧额度标成刚获取。
      const refreshed =
        (!capabilities.quota && account.capabilities?.quota) ||
        (!capabilities.balance && account.capabilities?.balance)
          ? {
              ...capabilities,
              quota: account.capabilities?.quota,
              balance: account.capabilities?.balance,
              checkedAt: account.capabilities!.checkedAt
            }
          : capabilities
      Object.assign(
        account,
        capabilityFields(
          account.region,
          refreshed,
          account.concurrencyOverride,
          account.provider,
          account.excludedModels,
          account.manualModels
        )
      )
    })
    return this.snapshot()
  }
  refreshStaleAccounts(): Promise<void> {
    if (!this.refreshWork) {
      this.refreshController = new AbortController()
      this.refreshWork = this.refreshBatch(this.refreshController.signal).finally(() => {
        this.refreshWork = undefined
        this.refreshController = undefined
      })
    }
    return this.refreshWork
  }
  private async refreshBatch(signal: AbortSignal): Promise<void> {
    for (const account of this.store.get().accounts) {
      if (signal.aborted) return
      // 停用只影响请求调度，额度仍需同步以便判断何时恢复使用。
      if (
        !account.credential.accessToken ||
        (account.capabilities &&
          account.capabilities.quota !== undefined &&
          Date.now() - account.capabilities.checkedAt < QUOTA_REFRESH_MS)
      )
        continue
      try {
        await this.refreshAccount(account.id, signal)
      } catch (error) {
        if (signal.aborted) return
        this.scheduler.state(account.id).lastError =
          error instanceof Error ? error.message : '上游信息同步失败'
      }
    }
  }
  async rotateKey(value: unknown): Promise<GatewaySnapshot> {
    const id = string(value, '分组 ID')
    return this.exclusive(async () => {
      if (!this.store.get().settings.lanSharing) throw new Error('请先开启局域网共享')
      await this.store.mutate((data) => {
        const group = data.groups.find((item) => item.id === id)
        if (!group) throw new Error('分组不存在')
        group.key = randomBytes(32).toString('hex')
      })
      return this.snapshot()
    })
  }
  connection(value: unknown): string {
    const input = object(value)
    const id = string(input.groupId, '分组 ID')
    const data = this.store.get()
    const group = data.groups.find((g) => g.id === id)
    if (!group) throw new Error('分组不存在')
    let address = '127.0.0.1'
    if (input.lanAddress !== undefined) {
      if (!data.settings.lanSharing || !lanAddresses().includes(input.lanAddress as string))
        throw new Error('局域网地址已不可用，请刷新后重试')
      address = input.lanAddress as string
    }
    const url = `http://${address}:${data.settings.port}`
    switch (input.format) {
      case 'url':
        return `${url}/v1`
      case 'registry':
        return `${url}/api.json`
      case 'key':
        return group.key
      case 'kimi':
        return `default_model = "navo"\n\n[providers.navo]\ntype = "kimi"\nbase_url = "${url}/v1"\napi_key = "${group.key}"\n\n[models.navo]\nprovider = "navo"\nmodel = "kimi-for-coding"\nmax_context_size = 262144\n`
      case 'anthropic':
        return `export ANTHROPIC_BASE_URL='${url}'\nexport ANTHROPIC_AUTH_TOKEN='${group.key}'\nexport ANTHROPIC_MODEL='kimi-for-coding'`
      default:
        throw new Error('连接格式无效')
    }
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let flowId: string | undefined
    const started = Date.now()
    const startedTick = performance.now()
    let firstTokenMs: number | null = null
    let upstreamRequestId: string | null = null
    let reasoningEffort: string | null = null
    let usage: TokenUsage | null = null
    let streamStartedAt: number | null = null
    let streamDurationMs: number | null = null
    let protocol: UsageProtocol | undefined
    let sessionId: string | undefined
    let accountId: string | undefined
    let provider: RequestRecord['provider']
    const controller = new AbortController()
    const settings = this.store.get().settings
    let disconnected = false
    let timedOut = false
    let upstreamStreamFailed = false
    let interruption: RequestRecord['interruption'] = null
    let attempts = 0
    let groupName = '',
      accountName = '',
      model = ''
    let finalStatus = 500
    let isRegistry = false
    let authorized = false
    const disconnect = (): void => {
      if (!res.writableFinished && !controller.signal.aborted && !upstreamStreamFailed) {
        disconnected = true
        interruption = 'client_disconnect'
        controller.abort(new Error('客户端断开'))
      }
    }
    req.once('aborted', disconnect)
    res.once('close', disconnect)
    const timer = setTimeout(() => {
      if (res.writableFinished) return
      timedOut = true
      interruption ??= 'timeout'
      controller.abort(new Error('请求超时'))
      if (!req.complete) req.destroy()
    }, settings.timeoutSeconds * 1000)
    this.controllers.add(controller)
    this.notifyActivity()
    try {
      if (req.headers.origin) throw new HttpError(403, '本地网关不接受网页跨域请求')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const harnessPath = url.pathname.match(/^\/harness\/([^/]+)(\/.*)$/)
      if (harnessPath && !harnessById(harnessPath[1])) throw new HttpError(404, 'Harness 不支持')
      const pathname = harnessPath ? harnessPath[2] : url.pathname
      const match = pathname.match(/^\/groups\/([^/]+)(\/v1\/.*)$/)
      const route = match ? match[2] : pathname
      if (!routes.has(route)) throw new HttpError(404, '接口不存在')
      isRegistry = route === '/api.json'
      const isModels = route === '/v1/models' || isRegistry
      protocol =
        route === '/v1/responses'
          ? 'responses'
          : route === '/v1/chat/completions'
            ? 'chat-completions'
            : route === '/v1/messages'
              ? 'messages'
              : undefined
      if (req.method !== (isModels ? 'GET' : 'POST')) throw new HttpError(405, '请求方法不支持')
      const auth = req.headers.authorization
      const key = auth?.startsWith('Bearer ')
        ? auth.slice(7)
        : typeof req.headers['x-api-key'] === 'string'
          ? req.headers['x-api-key']
          : ''
      const data = this.store.get()
      // 使用实际连接两端地址，不能通过 Host 或转发头伪造本机连接。
      const loopback = (address: string | undefined) =>
        address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
      const local = loopback(req.socket.localAddress) && loopback(req.socket.remoteAddress)
      const group =
        local && (!match || match[1] === 'default')
          ? data.groups.find((g) => g.id === 'default')
          : data.groups.find((g) => matchesKey(key, g.key) && (!match || g.id === match[1]))
      if (!group) throw new HttpError(401, '分组密钥无效或与接入地址不匹配')
      groupName = '统一账号池'
      if (!group.enabled) throw new HttpError(403, '该分组已停用')
      authorized = true
      if (isModels) {
        if (isRegistry) await this.pricing.refresh()
        const accounts = data.accounts.filter(
          (account) => account.enabled && account.credential.accessToken && account.capabilities
        )
        const models = [...new Set(accounts.flatMap((account) => account.models))]
        finalStatus = 200
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        })
        res.end(
          JSON.stringify(
            isRegistry
              ? {
                  navo: {
                    id: 'navo',
                    name: 'Navo',
                    type: 'openai',
                    api: `http://${settings.lanSharing && isPrivateIPv4(req.socket.localAddress ?? '') ? req.socket.localAddress : '127.0.0.1'}:${settings.port}${harnessPath ? `/harness/${harnessPath[1]}` : ''}/v1`,
                    models: registryModels(
                      accounts,
                      this.pricing.snapshot().entries,
                      data.modelPrices
                    )
                  }
                }
              : { object: 'list', data: models.map((id) => ({ id, object: 'model' })) }
          )
        )
        return
      }
      const body = isModels ? undefined : await bodyOf(req)
      let session =
        typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : ''
      let goSession = ''
      let payload: Wire = {}
      if (body) {
        try {
          payload = object(JSON.parse(body.toString('utf8')))
          model = string(payload.model, '模型', 200)
        } catch {
          throw new HttpError(400, '请求须为 JSON 对象，并包含有效的 model')
        }
        // 只记录明确的强度枚举；不改写请求，也不保存任意客户端文本。
        const effort =
          (route === '/v1/responses'
            ? (payload.reasoning as { effort?: unknown } | null)?.effort
            : route === '/v1/chat/completions'
              ? payload.reasoning_effort
              : (payload.output_config as { effort?: unknown } | null)?.effort) ??
          (payload.thinking as { effort?: unknown } | null)?.effort
        if (
          typeof effort === 'string' &&
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto', 'ultra'].includes(
            effort
          )
        )
          reasoningEffort = effort
        if (!session && typeof payload.prompt_cache_key === 'string')
          session = payload.prompt_cache_key
        goSession = openCodeSession(req.headers, payload)
      }
      const historySession = requestSessionId(req.headers, payload)
      if (historySession)
        sessionId = createHash('sha256')
          .update(JSON.stringify([group.id, historySession]))
          .digest('hex')
      if (session.length > 512) throw new HttpError(400, '会话标识超过 512 个字符')
      if (!session) session = goSession
      // 无会话字段时仅为本次请求生成，重试复用；不将所有客户端绑定到同一会话。
      goSession ||= randomUUID()
      if (protocol)
        flowId = this.liveFlows.start(
          req.headers,
          historySession ?? session,
          model,
          harnessPath?.[1]
        )
      const excluded = new Set<string>()
      while (attempts < settings.maxAttempts && !controller.signal.aborted) {
        // 每次尝试读取最新配置，禁用、删除和分组变更立即影响后续调度。
        const latest = this.store.get()
        // 旧分组地址和密钥仅作为兼容入口；所有入口调度同一个账号池。
        const liveGroup = {
          ...group,
          id: 'default',
          enabled: true,
          stickySeconds: latest.settings.stickySeconds ?? 300
        }
        const pool = latest.accounts.map((account) => ({
          ...account,
          memberships: [{ groupId: 'default', priority: 0, weight: 1 }]
        }))
        const lease = this.scheduler.acquire(pool, liveGroup, model, session, excluded)
        if (!lease) break
        const { account } = lease
        excluded.add(account.id)
        accountName = account.name
        accountId = account.id
        provider = account.provider ?? 'kimi'
        attempts++
        if (flowId) this.liveFlows.update(flowId, { state: 'waiting' })
        const attemptStarted = Date.now()
        const attemptStartedTick = performance.now()
        try {
          const credential =
            account.provider === 'codex'
              ? await this.codex.credential(account.id)
              : account.credential
          const token = credential.accessToken
          if (controller.signal.aborted) break
          if (
            (account.provider === 'opencode-go' || account.provider === 'codex') &&
            route === '/v1/messages/count_tokens'
          ) {
            finalStatus = 200
            res.writeHead(200, {
              'content-type': 'application/json',
              'x-token-count-estimated': 'true'
            })
            res.end(JSON.stringify({ input_tokens: estimateInputTokens(payload) }))
            return
          }
          const targetRoute = modelUpstreamRoute(account, model, route)
          const converted =
            targetRoute !== route || (account.provider === 'codex' && payload.stream !== true)
              ? convertRequest(payload, routeProtocol(route), routeProtocol(targetRoute))
              : undefined
          const requestBody =
            account.provider === 'codex'
              ? Buffer.from(JSON.stringify(codexRequest(converted?.body ?? payload)))
              : converted
                ? Buffer.from(JSON.stringify(converted.body))
                : body
          const headers = new Headers({
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'accept-encoding': 'identity'
          })
          for (const name of ['accept', 'user-agent', 'anthropic-version', 'anthropic-beta']) {
            const value = req.headers[name]
            if (typeof value === 'string') headers.set(name, value)
          }
          if (targetRoute.startsWith('/v1/messages') && !headers.has('anthropic-version'))
            headers.set('anthropic-version', '2023-06-01')
          if (account.provider === 'opencode-go') {
            headers.set('x-opencode-session', goSession)
            if (!headers.has('user-agent')) headers.set('user-agent', 'Navo')
            if (targetRoute === '/v1/messages') headers.set('x-api-key', token)
            else {
              headers.delete('anthropic-version')
              headers.delete('anthropic-beta')
            }
          }
          if (account.provider === 'codex') {
            for (const [name, value] of Object.entries(codexHeaders(credential)))
              headers.set(name, value)
            headers.delete('anthropic-version')
            headers.delete('anthropic-beta')
            headers.set('session_id', goSession)
          }
          if (flowId && requestBody) this.liveFlows.upload(flowId, requestBody.length)
          const upstream = await this.request(
            `${upstreamUrl(account.region, account.provider, targetRoute)}${url.search}`,
            {
              method: req.method,
              headers,
              body: requestBody ? new Uint8Array(requestBody) : undefined,
              signal: controller.signal,
              redirect: 'manual'
            }
          )
          upstreamRequestId = null
          for (const name of [
            'x-msh-request-id',
            'x-request-id',
            'request-id',
            'requestid',
            'x-kimi-request-id'
          ]) {
            const value = upstream.headers.get(name)
            if (validRequestId(value)) {
              upstreamRequestId = value
              console.info(`[gateway] upstream ${name}=${value}`)
              break
            }
          }
          if (retryable(upstream.status)) {
            this.scheduler.failure(
              account.id,
              upstream.status,
              settings.cooldownSeconds,
              upstream.headers.get('retry-after')
            )
            await upstream.body?.cancel()
            continue
          }
          if (upstream.status >= 300 && upstream.status < 400) {
            await upstream.body?.cancel()
            this.scheduler.failure(account.id, 502, settings.cooldownSeconds)
            continue
          }
          finalStatus = upstream.status
          const outgoing: Record<string, string> = {
            'cache-control': 'no-store',
            'x-accel-buffering': 'no'
          }
          for (const name of [
            'content-type',
            'request-id',
            'x-request-id',
            'x-msh-request-id',
            'requestid',
            'x-kimi-request-id',
            'x-trace-id',
            'retry-after'
          ]) {
            const value = upstream.headers.get(name)
            if (value) outgoing[name] = value
          }
          if (converted)
            outgoing['content-type'] =
              upstream.ok && payload.stream === true
                ? 'text/event-stream; charset=utf-8'
                : 'application/json'
          const bufferedConversion = !!converted && !(upstream.ok && payload.stream === true)
          if (!bufferedConversion) {
            res.writeHead(upstream.status, outgoing)
            res.flushHeaders()
          }
          // 同协议透传；跨协议在背压管线中转换。开始输出后不再重试。
          if (upstream.body) {
            const source = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
            // pipeline 会销毁下游；先标记上游故障，避免将它误判为用户主动取消。
            source.once('error', () => {
              if (!controller.signal.aborted) {
                upstreamStreamFailed = true
                interruption ??= 'upstream_disconnect'
              }
            })
            const streaming = !!upstream.headers.get('content-type')?.includes('text/event-stream')
            let streamComplete = false
            let streamInspectable = true
            if (upstream.ok && streaming) streamStartedAt = attemptStartedTick
            const flows = this.liveFlows
            const activity = new Transform({
              transform(chunk, _encoding, callback) {
                if (flowId && upstream.ok) flows.activity(flowId, chunk.length)
                callback(null, chunk)
              }
            })
            const ids = new ResponseIdsObserver(
              streaming,
              (id) => {
                if (!upstreamRequestId) {
                  upstreamRequestId = id
                  console.info(`[gateway] upstream requestId=${id}`)
                }
              },
              converted ? routeProtocol(targetRoute) : protocol,
              (reported) => {
                usage = {
                  input: null,
                  output: null,
                  cacheRead: null,
                  cacheWrite: null,
                  cost: null,
                  ...usage,
                  ...reported
                }
                if (flowId && upstream.ok) this.liveFlows.update(flowId, { usage })
              },
              (state) => {
                if (!upstream.ok) return
                if (state === 'complete') streamComplete = true
                else if (state === 'unknown') streamInspectable = false
                else interruption ??= 'upstream_error'
              }
            )
            if (converted) {
              const convert = async function* (chunks: AsyncIterable<Buffer>) {
                try {
                  yield* convertResponse(chunks, {
                    source: routeProtocol(targetRoute),
                    target: routeProtocol(route),
                    context: converted.context,
                    inputStream: streaming,
                    outputStream: upstream.ok && payload.stream === true,
                    ok: upstream.ok
                  })
                } catch (error) {
                  if (!controller.signal.aborted) {
                    upstreamStreamFailed = true
                    interruption ??= 'upstream_error'
                  }
                  throw error
                }
              }
              if (upstream.ok && payload.stream === true) {
                const observer = new FirstTokenObserver(() => {
                  firstTokenMs ??= Math.round(performance.now() - startedTick)
                })
                await pipeline(source, activity, ids, convert, observer, res, {
                  signal: controller.signal
                })
              } else {
                // Do not commit HTTP 200 before a buffered conversion has actually succeeded.
                const result = await pipeline(
                  source,
                  activity,
                  ids,
                  convert,
                  async (chunks: AsyncIterable<Buffer>) => {
                    const buffers: Buffer[] = []
                    let size = 0
                    for await (const chunk of chunks) {
                      size += chunk.length
                      if (size > 16 * 1024 * 1024)
                        throw new ProtocolError('协议转换响应超过 16 MB', 502)
                      buffers.push(chunk)
                    }
                    return Buffer.concat(buffers)
                  },
                  { signal: controller.signal }
                )
                res.writeHead(upstream.status, outgoing)
                res.end(result)
              }
            } else if (upstream.ok && streaming) {
              const observer = new FirstTokenObserver(() => {
                firstTokenMs ??= Math.round(performance.now() - startedTick)
              })
              await pipeline(source, activity, ids, observer, res, { signal: controller.signal })
            } else await pipeline(source, activity, ids, res, { signal: controller.signal })
            if (upstream.ok && streaming && streamInspectable && !streamComplete)
              interruption ??= 'upstream_disconnect'
          } else {
            if (bufferedConversion) throw new ProtocolError('上游返回空响应', 502)
            res.end()
          }
          if (interruption) {
            finalStatus = 502
            this.scheduler.failure(account.id, 0, settings.cooldownSeconds)
          } else if (upstream.ok) this.scheduler.success(account.id, Date.now() - attemptStarted)
          else this.scheduler.failure(account.id, upstream.status, settings.cooldownSeconds)
          return
        } catch (error) {
          if (error instanceof ProtocolError && error.status === 400) throw error
          if (!disconnected && (!controller.signal.aborted || timedOut))
            this.scheduler.failure(account.id, 0, settings.cooldownSeconds)
          if (error instanceof ProtocolError && !res.headersSent && !controller.signal.aborted)
            throw error
          if (res.headersSent) {
            if (!controller.signal.aborted) {
              upstreamStreamFailed = true
              interruption ??=
                error instanceof ProtocolError ? 'upstream_error' : 'upstream_disconnect'
            }
            finalStatus = timedOut ? 504 : 502
            res.destroy()
            return
          }
        } finally {
          if (streamStartedAt !== null) {
            streamDurationMs = Math.max(0, Math.round(performance.now() - streamStartedAt))
            streamStartedAt = null
          }
          lease.release()
        }
      }
      if (controller.signal.aborted)
        throw new HttpError(timedOut ? 504 : 503, timedOut ? '上游请求超时' : '网关已停止')
      res.setHeader('retry-after', String(settings.cooldownSeconds))
      throw new HttpError(503, '无可用账号：请检查凭据、模型、并发上限、额度或冷却状态')
    } catch (error) {
      finalStatus = timedOut
        ? 504
        : error instanceof HttpError || error instanceof ProtocolError
          ? error.status
          : 500
      jsonError(
        res,
        finalStatus,
        timedOut
          ? '上游请求超时'
          : error instanceof HttpError || error instanceof ProtocolError
            ? error.message
            : '本地网关处理失败'
      )
    } finally {
      if (controller.signal.aborted && !interruption) interruption = 'gateway_shutdown'
      if (flowId)
        this.liveFlows.finish(
          flowId,
          !interruption && !disconnected && finalStatus >= 200 && finalStatus < 300,
          usage
        )
      clearTimeout(timer)
      this.controllers.delete(controller)
      this.notifyActivity()
      req.off('aborted', disconnect)
      res.off('close', disconnect)
      if (!req.complete) req.resume()
      // Rejected network traffic must not grow the permanent business history.
      if (authorized && !isRegistry) {
        const record: RequestRecord = {
          id: randomUUID(),
          time: started,
          group: groupName,
          account: accountName,
          accountId,
          sessionId,
          provider,
          protocol,
          usage,
          interruption,
          streamDurationMs,
          model,
          status: disconnected ? 499 : finalStatus,
          attempts,
          firstTokenMs,
          upstreamRequestId,
          reasoningEffort,
          durationMs: Date.now() - started
        }
        this.recordRequest(record)
      }
    }
  }
}
