import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ResponseIdsObserver, validRequestId } from './response-ids'
import { FirstTokenObserver } from './first-token'
import type { RequestRecord } from '../../shared/contracts'
import { randomUUID } from 'node:crypto'
import {
  upstreamUrl,
  type AccountModelTest,
  type AccountModelTestResult
} from '../../shared/contracts'
import { MODEL_PROTOCOLS } from '../../shared/model-protocols'
import type { Credential } from './gateway-store'
import { codexHeaders, codexRequest } from './codex-auth'
import { obj, str, list, type Wire } from './protocol-request'

export type ModelTestTelemetry = Pick<
  RequestRecord,
  | 'status'
  | 'usage'
  | 'interruption'
  | 'firstTokenMs'
  | 'upstreamRequestId'
  | 'streamDurationMs'
  | 'durationMs'
>

/** A real, account-pinned inference request; never enters the scheduler or retries elsewhere. */
export async function testAccountModel(
  input: AccountModelTest,
  credential: Credential,
  request: typeof fetch,
  onComplete?: (telemetry: ModelTestTelemetry) => void
): Promise<AccountModelTestResult> {
  const started = performance.now()
  const telemetry: ModelTestTelemetry = {
    status: 502,
    usage: null,
    interruption: null,
    firstTokenMs: null,
    upstreamRequestId: null,
    streamDurationMs: null,
    durationMs: 0
  }
  let streamStarted: number | null = null
  const prompt = 'Reply with OK only.'
  const body: Wire =
    input.protocol === 'responses'
      ? { model: input.model, input: prompt, max_output_tokens: 1024, stream: true }
      : {
          model: input.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024,
          stream: true
        }
  if (input.protocol === 'chat-completions') body.stream_options = { include_usage: true }
  const headers = new Headers({
    'content-type': 'application/json',
    authorization: `Bearer ${credential.accessToken}`,
    accept: 'text/event-stream',
    'accept-encoding': 'identity'
  })
  if (input.protocol === 'messages') headers.set('anthropic-version', '2023-06-01')
  if (input.provider === 'opencode-go') {
    headers.set('x-opencode-session', randomUUID())
    headers.set('user-agent', 'Navo')
    if (input.protocol === 'messages') headers.set('x-api-key', credential.accessToken)
  }
  if (input.provider === 'codex') {
    for (const [key, value] of Object.entries(codexHeaders(credential))) headers.set(key, value)
    headers.set('session_id', randomUUID())
  }
  const redact = (message: string): string =>
    message.split(credential.accessToken).join('[已隐藏]').slice(0, 1000)
  try {
    const response = await request(
      upstreamUrl(
        input.region,
        input.provider,
        MODEL_PROTOCOLS.find((p) => p.value === input.protocol)!.route
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(input.provider === 'codex' ? codexRequest(body) : body),
        signal: AbortSignal.timeout(60000),
        redirect: 'error'
      }
    )
    telemetry.status = response.status
    for (const header of ['x-request-id', 'request-id', 'x-amzn-requestid']) {
      const id = response.headers.get(header)
      if (validRequestId(id)) {
        telemetry.upstreamRequestId = id
        break
      }
    }
    if (!response.body) throw new Error(`HTTP ${response.status}：上游未返回响应内容`)
    const receivedAt = performance.now()
    // Some upstreams send SSE with a missing or incorrect Content-Type. Inspect a
    // bounded prefix before constructing observers so usage and timing use the same format.
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    const iterator = source[Symbol.asyncIterator]()
    const prefix: Buffer[] = []
    let prefixSize = 0
    let streaming = /text\/event-stream/i.test(response.headers.get('content-type') ?? '')
    try {
      while (prefixSize < 4096) {
        const chunk = await iterator.next()
        if (chunk.done) break
        const bytes = Buffer.from(chunk.value)
        prefix.push(bytes)
        prefixSize += bytes.length
        const start = Buffer.concat(prefix).toString('utf8').trimStart()
        if (/^(?:data|event|id|retry):|^:/.test(start)) {
          streaming = true
          break
        }
        if (/^[{[]/.test(start)) {
          streaming = false
          break
        }
        if (start && !['data:', 'event:', 'id:', 'retry:'].some((field) => field.startsWith(start)))
          break
      }
    } catch (error) {
      source.destroy()
      throw error
    }
    if (streaming) streamStarted = receivedAt
    async function* chunks(): AsyncGenerator<Buffer> {
      try {
        yield* prefix
        for await (const chunk of iterator) yield Buffer.from(chunk)
      } finally {
        source.destroy()
      }
    }
    const ids = new ResponseIdsObserver(
      streaming,
      (id) => {
        telemetry.upstreamRequestId ??= id
      },
      input.protocol,
      (usage) => {
        telemetry.usage = {
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          cost: null,
          ...telemetry.usage,
          ...usage
        }
      },
      (state) => {
        if (state === 'error') telemetry.interruption = 'upstream_error'
      }
    )
    const firstToken = new FirstTokenObserver(() => {
      if (streaming) telemetry.firstTokenMs ??= Math.round(performance.now() - started)
    })
    let raw = ''
    let size = 0
    const decoder = new TextDecoder()
    await pipeline(chunks(), ids, firstToken, async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) {
        size += chunk.length
        if (size > 1024 * 1024) throw new Error('测试响应超过 1 MB')
        raw += decoder.decode(chunk, { stream: true })
      }
      raw += decoder.decode()
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}：${raw || response.statusText}`)
    let text = ''
    let complete = false
    const responseText = (node: Wire): string =>
      list(node.output)
        .flatMap((item) => list(item.content))
        .map((part) => str(part.text))
        .join('')
    const consume = (event: Wire): void => {
      if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type))
        throw new Error(
          str(obj(event.error ?? obj(event.response).error).message) ||
            str(event.message) ||
            '上游返回失败或不完整响应'
        )
      if (event.type === 'content_block_delta') text += str(obj(event.delta).text)
      if (event.type === 'response.output_text.delta') text += str(event.delta)
      if (event.type === 'message_stop') complete = true
      if (event.type === 'response.completed') {
        complete = true
        text ||= responseText(obj(event.response))
      }
      for (const choice of list(event.choices)) {
        text += str(obj(choice.delta).content) || str(obj(choice.message).content)
        if (choice.finish_reason) complete = true
      }
    }
    if (streaming) {
      for (const block of raw.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
          .trim()
        if (!data) continue
        if (data === '[DONE]') {
          complete = true
          continue
        }
        consume(obj(JSON.parse(data)))
      }
    } else {
      const node = obj(JSON.parse(raw))
      consume(node)
      text ||=
        responseText(node) ||
        list(node.content)
          .map((part) => str(part.text))
          .join('')
      complete ||= node.status === 'completed' || !!node.stop_reason
    }
    if (!complete) {
      telemetry.interruption ??= 'upstream_disconnect'
      throw new Error('上游响应未正常完成，请重试')
    }
    if (!text.trim()) throw new Error('上游未返回文本回复')
    return {
      model: input.model,
      protocol: input.protocol,
      durationMs: Math.round(performance.now() - started),
      text: redact(text)
    }
  } catch (error) {
    if (telemetry.status < 400) telemetry.status = 502
    telemetry.interruption ??= 'upstream_error'
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      telemetry.status = 504
      telemetry.interruption = 'timeout'
      throw new Error('测试超时（60 秒），请重试')
    }
    throw new Error(redact(error instanceof Error ? error.message : String(error)))
  } finally {
    telemetry.durationMs = Math.round(performance.now() - started)
    if (streamStarted !== null)
      telemetry.streamDurationMs = Math.round(performance.now() - streamStarted)
    onComplete?.(telemetry)
  }
}
