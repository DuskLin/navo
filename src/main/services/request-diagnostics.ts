import type { RequestRecord } from '../../shared/contracts'
import type { RequestFailureLog } from '../../shared/request-failure'

const privateField = (key: string): boolean => {
  const name = key.replace(/[-_]/g, '').toLowerCase()
  return (
    /token$/.test(name) ||
    /secret|password|credential|authorization|cookie|apikey|accesskey|session|email|phone|address|deviceid|fingerprint/.test(
      name
    ) ||
    /^(user|userid|username|safetyidentifier|promptcachekey|token|accesstoken|refreshtoken|idtoken|clienttoken|xauthtoken|forwarded|xforwardedfor|xrealip|filename|filepath)$/.test(
      name
    )
  )
}
const redactValue = (value: string): string =>
  value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (text) => {
      try {
        const url = new URL(text)
        url.username = ''
        url.password = ''
        for (const key of [...url.searchParams.keys()])
          if (privateField(key)) url.searchParams.set(key, '[REDACTED]')
        return url.toString()
      } catch {
        return text
      }
    })
    .replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, '[REDACTED credential]')
    .replace(/\b(?:sk-|sess-)[\w.-]+/g, '[REDACTED credential]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[REDACTED email]')
    .replace(/(?:[A-Z]:\\|\/(?:Users|home)\/)[^\s"']+/gi, '[REDACTED path]')

const contentFields = new Set(
  'text instructions system prompt arguments output result image_url input_image image audio input_audio video file file_data'.split(
    ' '
  )
)
const hidden = (value: unknown): unknown =>
  typeof value === 'string'
    ? `[REDACTED string: ${value.length} chars]`
    : value === null
      ? null
      : `[REDACTED ${Array.isArray(value) ? `array: ${value.length} items` : typeof value}]`

/** Keep diagnostic parameters, schema and message structure; replace conversation values. */
export function requestShape(
  value: unknown,
  key = '',
  depth = 0,
  budget = { nodes: 20000 },
  schema = false
): unknown {
  if (--budget.nodes < 0 || depth > 40) return '[TRUNCATED: structure limit]'
  if ((!schema && privateField(key)) || contentFields.has(key)) return hidden(value)
  if (value == null) return null
  if (typeof value === 'string')
    return ['input', 'content'].includes(key)
      ? hidden(value)
      : key === 'model'
        ? value
        : redactValue(value)
  if (typeof value === 'number' || typeof value === 'boolean')
    return ['input', 'content'].includes(key) ? hidden(value) : value
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      if (budget.nodes <= 0) {
        result.push(`[TRUNCATED: ${value.length - i} more items]`)
        break
      }
      result.push(requestShape(value[i], key, depth + 1, budget, schema))
    }
    return result
  }
  if (typeof value !== 'object') return hidden(value)
  const entries = Object.entries(value)
  const result: Record<string, unknown> = Object.create(null)
  for (const [field, item] of entries) {
    if (budget.nodes <= 0) {
      result['[TRUNCATED]'] = 'structure limit'
      break
    }
    const inSchema = schema || ['parameters', 'json_schema', 'schema'].includes(field)
    result[field] = requestShape(item, field, depth + 1, budget, inSchema)
  }
  return result
}

export function diagnosticHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].map(([key, value]) => [
      key,
      privateField(key) ? hidden(value) : redactValue(value)
    ])
  ) as Record<string, string>
}

export function diagnosticEndpoint(value: string): string {
  const url = new URL(value)
  return url.origin + url.pathname
}

export class RequestDiagnostics {
  readonly log: RequestFailureLog = {
    captureVersion: 3,
    request: '[body unavailable]',
    errors: [],
    attempts: []
  }
  attempt(context: Record<string, unknown>): void {
    this.log.attempts!.push(context)
  }
  response(response: Response): void {
    const context = this.log.attempts!.at(-1)
    if (context)
      context.response = { status: response.status, headers: diagnosticHeaders(response.headers) }
  }
  request(value: unknown, forwarded = false): void {
    if (forwarded) {
      this.log.forwardedRequest = requestShape(value)
      const context = this.log.attempts!.at(-1)
      if (context) context.request = this.log.forwardedRequest
    } else this.log.request = requestShape(value)
  }
  error(value: unknown, attempt: number, status?: number): void {
    const root = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
    const source =
      root?.error ?? (root?.response as Record<string, unknown> | undefined)?.error ?? value
    // Error objects are diagnostic evidence: preserve all fields and values without redaction.
    // Native Error properties are non-enumerable, so project them explicitly for persistence.
    let detail: unknown =
      source instanceof Error
        ? Object.fromEntries(
            Object.getOwnPropertyNames(source).map((key) => [
              key,
              (source as unknown as Record<string, unknown>)[key]
            ])
          )
        : source
    try {
      detail = JSON.parse(
        JSON.stringify(detail ?? null, (_key, item) =>
          item instanceof Error
            ? { ...item, name: item.name, message: item.message, stack: item.stack }
            : item
        )
      )
    } catch {
      detail = { message: String(source), note: 'Error object could not be serialized' }
    }
    this.log.errors.push({ attempt, status, detail })
    this.log.errors = this.log.errors.slice(-64)
  }
  errorBody(raw: string, attempt: number, status: number, truncated = false): void {
    if (truncated) {
      this.error(
        { raw, truncated: true, note: 'Error body exceeded capture size/time limit' },
        attempt,
        status
      )
      return
    }
    try {
      this.error(JSON.parse(raw), attempt, status)
    } catch {
      this.error({ message: raw || '[empty error body]' }, attempt, status)
    }
  }
  /** Consume only rejected responses, with bounded bytes and time; never delay retries indefinitely. */
  async rejected(response: Response, attempt: number): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) {
      this.error({}, attempt, response.status)
      return
    }
    const chunks: Uint8Array[] = []
    let size = 0
    let truncated = false
    const timer = setTimeout(() => {
      truncated = true
      void reader.cancel().catch(() => {})
    }, 1000)
    try {
      while (size <= 262144) {
        const { value, done } = await reader.read()
        if (done) break
        const remaining = 262144 - size
        size += value.length
        chunks.push(value.subarray(0, remaining))
        if (size > 262144) {
          truncated = true
          break
        }
      }
      this.errorBody(Buffer.concat(chunks).toString('utf8'), attempt, response.status, truncated)
    } catch {
      this.error({ message: '[error body read failed]' }, attempt, response.status)
    } finally {
      clearTimeout(timer)
      void reader.cancel().catch(() => {})
    }
  }
}

export function requestIssueReport(
  record: RequestRecord,
  log: RequestFailureLog | undefined,
  version: string
): { url: string; clipboardBody?: string } {
  const summary = {
    version,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron,
    time: new Date(record.time).toISOString(),
    status: record.status,
    provider: record.provider,
    account: record.account,
    accountId: record.accountId,
    group: record.group,
    model: record.model,
    upstreamModel: record.upstreamModel,
    protocol: record.protocol,
    inboundRoute: record.inboundRoute,
    upstreamRoute: record.upstreamRoute,
    upstreamRequestId: record.upstreamRequestId,
    harness: record.harness,
    reasoningEffort: record.reasoningEffort,
    attempts: record.attempts,
    durationMs: record.durationMs,
    firstTokenMs: record.firstTokenMs,
    streamDurationMs: record.streamDurationMs,
    interruption: record.interruption,
    usage: record.usage
  }
  const title = `[请求失败] ${record.status} / ${record.provider ?? 'gateway'}`
  const jsonBlock = (value: unknown): string => {
    const json = JSON.stringify(value, null, 2)
    const fence = '`'.repeat(
      Math.max(3, ...[...json.matchAll(/`+/g)].map((match) => match[0].length + 1))
    )
    return `${fence}json\n${json}\n${fence}`
  }
  const summaryBody = `## 问题描述\n请补充复现步骤。\n\n## 请求摘要\n${jsonBlock(summary)}`
  const diagnostic = log
    ? {
        ...log,
        ...(log.captureVersion === 3
          ? {}
          : { note: '旧版日志可能已脱敏或省略部分诊断，原文无法恢复。' })
      }
    : { note: '详细错误日志不存在（旧记录或已超出最近 300 条），仅附请求摘要。' }
  const body = `${summaryBody}\n\n## 原始错误与请求诊断\n${jsonBlock(diagnostic)}\n\n账号、分组、模型 ID、Request ID 和 error 对象原样保留；对话内容、凭据和会话标识脱敏，保留请求参数与结构。`
  const make = (text: string) =>
    `https://github.com/DuskLin/navo/issues/new?${new URLSearchParams({ title, body: text })}`
  if (make(body).length <= 7500) return { url: make(body) }
  const pasteNote =
    '完整报告已复制到剪贴板，请全选此正文并粘贴后提交（包含原始错误与每次转发的请求结构）。'
  const preview = make(`${summaryBody}\n\n## 完整诊断\n${pasteNote}`)
  return {
    url: preview.length <= 7500 ? preview : make(pasteNote),
    clipboardBody: body
  }
}

export function requestIssueUrl(
  record: RequestRecord,
  log: RequestFailureLog | undefined,
  version: string
): string {
  return requestIssueReport(record, log, version).url
}
