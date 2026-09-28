import type { UsageProtocol } from '../../shared/usage'
import { createHash } from 'node:crypto'

// Wire objects vary by protocol. Validate semantic fields at each boundary.
export type Wire = Record<string, any>
export const obj = (value: unknown): Wire =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Wire) : {}
export const list = (value: unknown): Wire[] => (Array.isArray(value) ? value.map(obj) : [])
export const str = (value: unknown): string => (typeof value === 'string' ? value : '')
export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message)
  }
}
export function routeProtocol(route: string): UsageProtocol {
  return route === '/v1/responses'
    ? 'responses'
    : route === '/v1/chat/completions'
      ? 'chat-completions'
      : 'messages'
}
export interface ToolIdentity {
  name: string
  namespace?: string
  custom: boolean
}
export interface BridgeContext {
  model: string
  tools: Map<string, ToolIdentity>
}
type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; detail?: string }
  | { type: 'file'; data?: string; url?: string; name?: string; mime?: string }
interface Message {
  role: string
  content: Part[]
  calls?: Wire[]
  callId?: string
  reasoning?: string
  error?: boolean
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProtocolError(`${label}不能为空`)
  return value
}
// Flatten namespace tool names to at most 64 bytes with a deterministic SHA-256 suffix.
function flattenNamespaceToolName(namespace: string, name: string): string {
  const full = `${namespace}__${name}`
  if (Buffer.byteLength(full) <= 64) return full
  const suffix = `__${createHash('sha256').update(full).digest('hex').slice(0, 8)}`
  let prefix = ''
  for (const char of full) {
    if (Buffer.byteLength(prefix + char) > 64 - suffix.length) break
    prefix += char
  }
  return prefix + suffix
}
function argumentsObject(value: unknown): Wire {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : (value ?? {})
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new ProtocolError('工具调用 arguments 必须是有效的 JSON 对象')
  }
}
function parts(value: unknown): Part[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
  if (value == null) return []
  if (!Array.isArray(value)) throw new ProtocolError('消息 content 必须是字符串或内容数组')
  return value.flatMap((raw): Part[] => {
    const p = obj(raw)
    if (['text', 'input_text', 'output_text'].includes(p.type))
      return [{ type: 'text', text: str(p.text) }]
    if (p.type === 'refusal') return [{ type: 'text', text: str(p.refusal) }]
    if (p.type === 'image_url' || p.type === 'input_image') {
      const image = obj(p.image_url)
      return [
        {
          type: 'image',
          url: required(typeof p.image_url === 'string' ? p.image_url : image.url, '图片 URL'),
          detail: p.detail ?? image.detail
        }
      ]
    }
    if (p.type === 'image') {
      const source = obj(p.source)
      const url =
        source.type === 'base64'
          ? `data:${required(source.media_type, '图片 MIME')};base64,${required(source.data, '图片数据')}`
          : required(source.url, '图片 URL')
      return [{ type: 'image', url }]
    }
    if (p.type === 'input_file' || p.type === 'file') {
      const file = p.type === 'file' ? obj(p.file) : p
      if (file.file_id)
        throw new ProtocolError('跨协议不能引用上游私有 file_id，请提供文件内容或 URL')
      return [{ type: 'file', data: file.file_data, url: file.file_url, name: file.filename }]
    }
    if (p.type === 'document') {
      const source = obj(p.source)
      if (source.type === 'text') return [{ type: 'text', text: str(source.data) }]
      return [
        {
          type: 'file',
          data:
            source.type === 'base64'
              ? `data:${source.media_type};base64,${source.data}`
              : undefined,
          url: source.url,
          mime: source.media_type,
          name: p.title
        }
      ]
    }
    throw new ProtocolError(`跨协议暂不支持内容类型 ${str(p.type) || 'unknown'}`)
  })
}
const textOf = (content: Part[]): string =>
  content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
function contentFor(content: Part[], protocol: UsageProtocol, role = 'user'): unknown {
  if (protocol === 'chat-completions' && content.some((p) => p.type === 'file'))
    throw new ProtocolError('目标 Chat Completions 模型不支持文件块，请先提取文件文本')
  if (protocol !== 'responses' && content.every((p) => p.type === 'text')) return textOf(content)
  return content.map((p) => {
    if (p.type === 'text')
      return {
        type:
          protocol === 'responses' ? (role === 'assistant' ? 'output_text' : 'input_text') : 'text',
        text: p.text
      }
    if (p.type === 'file') {
      if (protocol === 'responses')
        return { type: 'input_file', file_data: p.data, file_url: p.url, filename: p.name }
      const data = p.data?.match(/^data:([^;]+);base64,([\s\S]+)$/)
      if (!data && !p.url) throw new ProtocolError('文件块缺少有效数据或 URL')
      return {
        type: 'document',
        source: data
          ? { type: 'base64', media_type: data[1], data: data[2] }
          : { type: 'url', url: p.url }
      }
    }
    if (protocol === 'chat-completions')
      return {
        type: 'image_url',
        image_url: { url: p.url, ...(p.detail ? { detail: p.detail } : {}) }
      }
    if (protocol === 'responses')
      return { type: 'input_image', image_url: p.url, ...(p.detail ? { detail: p.detail } : {}) }
    const data = p.url.match(/^data:([^;]+);base64,([\s\S]+)$/)
    return {
      type: 'image',
      source: data
        ? { type: 'base64', media_type: data[1], data: data[2] }
        : { type: 'url', url: p.url }
    }
  })
}

function messagesFrom(body: Wire, protocol: UsageProtocol): Message[] {
  const out: Message[] = []
  if (protocol === 'responses') {
    if (body.previous_response_id || body.conversation)
      throw new ProtocolError(
        '跨协议请求请提供完整 input 历史，不能引用上游 previous_response_id 或 conversation'
      )
    if (body.instructions) out.push({ role: 'system', content: parts(body.instructions) })
    const input =
      typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
    if (!Array.isArray(input)) throw new ProtocolError('Responses input 必须是字符串或数组')
    let turnReasoning = ''
    for (const item of list(input)) {
      if (item.type === 'reasoning') {
        const summary = list(item.summary)
          .map((part) => str(part.text))
          .filter(Boolean)
          .join('\n')
        const content =
          typeof item.content === 'string'
            ? item.content
            : list(item.content)
                .map((part) => str(part.text))
                .filter(Boolean)
                .join('\n')
        turnReasoning = summary || content || turnReasoning
        continue // Opaque encrypted_content cannot be replayed; retain the actual reasoning text.
      }
      if (item.type === 'item_reference')
        throw new ProtocolError('跨协议请求需要完整历史，不能使用 item_reference')
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        out.push({
          role: 'assistant',
          content: [],
          reasoning: turnReasoning,
          calls: [
            {
              id: required(item.call_id, 'call_id'),
              name: item.namespace
                ? flattenNamespaceToolName(
                    required(item.namespace, 'namespace'),
                    required(item.name, '工具名称')
                  )
                : required(item.name, '工具名称'),
              arguments:
                item.type === 'custom_tool_call'
                  ? JSON.stringify({ input: str(item.input) })
                  : str(item.arguments) || '{}'
            }
          ]
        })
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        out.push({
          role: 'tool',
          callId: required(item.call_id, 'call_id'),
          content: parts(item.output)
        })
      } else if (item.role) {
        if (item.role !== 'assistant') turnReasoning = ''
        out.push({
          role: item.role,
          content: parts(item.content),
          ...(item.role === 'assistant' && turnReasoning ? { reasoning: turnReasoning } : {})
        })
      } else throw new ProtocolError(`跨协议暂不支持 Responses input 类型 ${str(item.type)}`)
    }
    return out
  }
  if (!Array.isArray(body.messages)) throw new ProtocolError('messages 必须是数组')
  if (protocol === 'messages' && body.system)
    out.push({ role: 'system', content: parts(body.system) })
  for (const m of list(body.messages)) {
    if (protocol === 'chat-completions') {
      if (m.function_call || m.role === 'function')
        throw new ProtocolError('请使用 tools/tool_calls，跨协议不支持旧版 functions/function_call')
      out.push({
        role: required(m.role, 'role'),
        content: parts(m.content),
        reasoning: str(m.reasoning_content ?? m.reasoning),
        ...(m.role === 'tool' ? { callId: required(m.tool_call_id, 'tool_call_id') } : {}),
        calls: list(m.tool_calls).map((c) => ({
          id: required(c.id, '工具调用 ID'),
          name: required(obj(c.function).name, '工具名称'),
          arguments: str(obj(c.function).arguments) || '{}'
        }))
      })
    } else {
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: parts(m.content) })
        continue
      }
      if (!Array.isArray(m.content)) throw new ProtocolError('Messages content 必须是字符串或数组')
      const message: Message = { role: m.role, content: [], calls: [], reasoning: '' }
      for (const p of list(m.content)) {
        if (p.type === 'tool_use')
          message.calls!.push({
            id: required(p.id, '工具调用 ID'),
            name: required(p.name, '工具名称'),
            arguments: JSON.stringify(argumentsObject(p.input))
          })
        else if (p.type === 'tool_result')
          out.push({
            role: 'tool',
            callId: required(p.tool_use_id, 'tool_use_id'),
            content: parts(p.content),
            error: p.is_error === true
          })
        else if (p.type === 'thinking') message.reasoning += str(p.thinking)
        else if (p.type !== 'redacted_thinking') message.content.push(...parts([p]))
      }
      if (message.content.length || message.calls?.length || message.reasoning) out.push(message)
    }
  }
  return out
}

/** Normalize tool history before sending to strict Chat upstreams. */
function normalizeToolHistory(messages: Message[]): Message[] {
  const merged: Message[] = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (message.role === 'assistant' && previous?.role === 'assistant') {
      previous.content.push(...message.content)
      previous.calls!.push(...(message.calls ?? []))
      previous.reasoning ||= message.reasoning
    } else
      merged.push({ ...message, content: [...message.content], calls: [...(message.calls ?? [])] })
  }
  const replies = new Map(
    messages.filter((m) => m.role === 'tool' && m.callId).map((m) => [m.callId!, m])
  )
  const used = new Set<string>()
  const out: Message[] = []
  for (const message of merged) {
    if (message.role === 'tool') continue // Paired replies are relocated below; orphan replies are omitted.
    if (!message.calls?.length) {
      out.push(message)
      continue
    }
    const calls = message.calls.filter((call) => {
      if (!replies.has(call.id) || used.has(call.id)) return false
      used.add(call.id)
      return true
    })
    if (!calls.length) {
      if (message.content.length) out.push({ ...message, calls: [] })
      continue // Do not invent a successful result for an interrupted/dangling tool call.
    }
    out.push({ ...message, calls }, ...calls.map((call) => replies.get(call.id)!))
  }
  return out
}

function normalizeChatInstructions(messages: Wire[]): Wire[] {
  const out: Wire[] = []
  let leading = true
  for (const message of messages) {
    if (message.role !== 'system') leading = false
    if (message.role === 'system' && leading && out.length) {
      const previous = out[0]
      if (typeof previous.content === 'string' && typeof message.content === 'string')
        previous.content = [previous.content, message.content].filter(Boolean).join('\n\n')
      else
        previous.content = [previous.content, message.content].flatMap((content) =>
          typeof content === 'string' ? [{ type: 'text', text: content }] : content
        )
    } else out.push(message.role === 'system' && !leading ? { ...message, role: 'user' } : message)
  }
  return out
}

function messagesTo(messages: Message[], protocol: UsageProtocol): Wire {
  if (protocol === 'chat-completions') {
    const out: Wire[] = []
    let pendingMedia: Part[] = []
    const flushMedia = () => {
      if (pendingMedia.length)
        out.push({ role: 'user', content: contentFor(pendingMedia, protocol) })
      pendingMedia = []
    }
    for (const m of normalizeToolHistory(messages)) {
      if (m.role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: m.callId,
          content: (m.error ? 'Tool error: ' : '') + textOf(m.content)
        })
        const media = m.content.filter((p) => p.type !== 'text')
        if (media.length)
          pendingMedia.push({ type: 'text', text: `Tool output media (${m.callId})` }, ...media)
      } else {
        flushMedia()
        out.push({
          role: m.role === 'developer' ? 'system' : m.role,
          content: contentFor(m.content, protocol, m.role),
          ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
          ...(m.calls?.length
            ? {
                tool_calls: m.calls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.arguments }
                }))
              }
            : {})
        })
      }
    }
    flushMedia()
    return { messages: normalizeChatInstructions(out) }
  }
  if (protocol === 'responses') {
    const input: Wire[] = []
    for (const m of messages) {
      if (m.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: m.callId,
          output: (m.error ? 'Tool error: ' : '') + textOf(m.content)
        })
        const media = m.content.filter((p) => p.type !== 'text')
        if (media.length)
          input.push({ type: 'message', role: 'user', content: contentFor(media, protocol) })
      } else {
        const content: Part[] =
          m.role === 'assistant' && m.reasoning
            ? [{ type: 'text', text: `<thinking>${m.reasoning}</thinking>` }, ...m.content]
            : m.content
        if (content.length)
          input.push({
            type: 'message',
            role: m.role,
            content: contentFor(content, protocol, m.role)
          })
        for (const c of m.calls ?? [])
          input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })
      }
    }
    return { input, store: false }
  }
  const system: string[] = []
  const out: Wire[] = []
  const append = (role: string, blocks: Wire[]) => {
    if (!blocks.length) return
    const previous = out.at(-1)
    if (previous?.role === role) previous.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const m of normalizeToolHistory(messages)) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(textOf(m.content))
      continue
    }
    if (m.role === 'tool') {
      append('user', [
        {
          type: 'tool_result',
          tool_use_id: m.callId,
          content: contentFor(m.content, protocol),
          ...(m.error ? { is_error: true } : {})
        }
      ])
      continue
    }
    const content = contentFor(m.content, protocol, m.role)
    const blocks =
      typeof content === 'string'
        ? content
          ? [{ type: 'text', text: content }]
          : []
        : (content as Wire[])
    // Do not invent Anthropic signatures when replaying another provider's reasoning.
    for (const c of m.calls ?? [])
      blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: argumentsObject(c.arguments) })
    append(m.role === 'assistant' ? 'assistant' : 'user', blocks)
  }
  return { messages: out, ...(system.length ? { system: system.join('\n\n') } : {}) }
}

function toolsFrom(body: Wire, protocol: UsageProtocol, context: BridgeContext): Wire[] {
  if (body.functions) throw new ProtocolError('跨协议请使用 tools 替代旧版 functions')
  const out: Wire[] = []
  const add = (tool: Wire, namespace?: string) => {
    if (tool.type === 'namespace' && protocol === 'responses') {
      for (const child of list(tool.tools)) add(child, required(tool.name, 'namespace'))
      return
    }
    const fn = protocol === 'chat-completions' ? obj(tool.function) : tool
    const custom = protocol === 'responses' && tool.type === 'custom'
    if (
      protocol === 'messages'
        ? !!tool.type && tool.type !== 'custom'
        : !['function', 'custom'].includes(tool.type)
    )
      throw new ProtocolError(`跨协议不支持上游托管工具 ${str(tool.type)}，请使用客户端函数工具`)
    const name = required(fn.name, '工具名称')
    const mapped = namespace ? flattenNamespaceToolName(namespace, name) : name
    if (context.tools.has(mapped)) throw new ProtocolError('工具名称冲突')
    context.tools.set(mapped, { name, namespace, custom })
    out.push({
      name: mapped,
      description: custom
        ? `${str(fn.description)}\nPass the exact free-form tool input in the input string.`
        : fn.description,
      parameters: custom
        ? {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false
          }
        : (fn.parameters ?? fn.input_schema ?? { type: 'object', properties: {} }),
      ...(fn.strict !== undefined ? { strict: fn.strict } : {})
    })
  }
  for (const tool of list(body.tools)) add(tool)
  return out
}

/** Convert request semantics between supported client and upstream protocols. */
export function convertRequest(
  body: Wire,
  source: UsageProtocol,
  target: UsageProtocol
): { body: Wire; context: BridgeContext } {
  const context: BridgeContext = { model: required(body.model, 'model'), tools: new Map() }
  if (source === target) return { body, context }
  if (body.n !== undefined && body.n !== 1) throw new ProtocolError('跨协议仅支持 n=1')
  if (body.background) throw new ProtocolError('跨协议不支持后台任务，请使用同步或流式请求')
  const messages = messagesFrom(body, source)
  if (!messages.length) throw new ProtocolError('请求中没有可转换的消息')
  const converted: Wire = {
    model: context.model,
    ...messagesTo(messages, target),
    stream: body.stream === true
  }
  for (const key of ['temperature', 'top_p'])
    if (body[key] !== undefined) converted[key] = body[key]
  if (target !== 'messages' && /^gpt-5/i.test(context.model)) {
    delete converted.temperature
    delete converted.top_p
  }
  const max = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens
  if (max !== undefined && (!Number.isSafeInteger(max) || max <= 0))
    throw new ProtocolError('输出 token 上限必须是正整数')
  if (target === 'messages') converted.max_tokens = max ?? 8192
  else if (max !== undefined)
    converted[target === 'responses' ? 'max_output_tokens' : 'max_tokens'] = max
  const stop = body.stop_sequences ?? body.stop
  if (stop !== undefined && target !== 'responses')
    converted[target === 'messages' ? 'stop_sequences' : 'stop'] =
      typeof stop === 'string' ? [stop] : stop
  const effort =
    obj(body.reasoning).effort ?? body.reasoning_effort ?? obj(body.output_config).effort
  if (effort) {
    if (target === 'responses')
      converted.reasoning = { effort: effort === 'max' ? 'xhigh' : effort }
    else if (target === 'chat-completions')
      converted.reasoning_effort = effort === 'max' ? 'xhigh' : effort
    else {
      converted.output_config = { effort: effort === 'xhigh' ? 'max' : effort }
      if (!['none', 'minimal', 'low'].includes(effort) && converted.max_tokens > 1024)
        converted.thinking = {
          type: 'enabled',
          budget_tokens: Math.min(
            converted.max_tokens - 1,
            effort === 'medium' ? 4096 : effort === 'high' ? 10240 : 32768
          )
        }
    }
  } else if (source === 'messages' && obj(body.thinking).type === 'enabled') {
    if (target === 'responses') converted.reasoning = { effort: 'high' }
    else converted.reasoning_effort = 'high'
  }
  const tools = toolsFrom(body, source, context)
  if (tools.length)
    converted.tools = tools.map((fn) =>
      target === 'messages'
        ? { name: fn.name, description: fn.description, input_schema: fn.parameters }
        : target === 'chat-completions'
          ? { type: 'function', function: fn }
          : { type: 'function', ...fn }
    )
  const choice = body.tool_choice
  if (choice !== undefined && tools.length) {
    const c = obj(choice)
    const mode = typeof choice === 'string' ? choice : c.type
    const name = c.name ?? obj(c.function).name
    const mapped = c.namespace
      ? flattenNamespaceToolName(required(c.namespace, 'namespace'), required(name, '工具名称'))
      : name
    if (name) {
      if (!context.tools.has(mapped)) throw new ProtocolError('tool_choice 引用未声明的工具')
      converted.tool_choice =
        target === 'messages'
          ? { type: 'tool', name: mapped }
          : target === 'responses'
            ? { type: 'function', name: mapped }
            : { type: 'function', function: { name: mapped } }
    } else if (['auto', 'none', 'any', 'required'].includes(mode)) {
      converted.tool_choice =
        target === 'messages'
          ? { type: mode === 'required' ? 'any' : mode }
          : mode === 'any'
            ? 'required'
            : mode
    } else throw new ProtocolError('跨协议不支持此 tool_choice')
  }
  const parallel =
    body.parallel_tool_calls ??
    (obj(choice).disable_parallel_tool_use !== undefined
      ? !obj(choice).disable_parallel_tool_use
      : undefined)
  if (parallel !== undefined && tools.length) {
    if (target === 'messages')
      converted.tool_choice = {
        ...(converted.tool_choice ?? { type: 'auto' }),
        disable_parallel_tool_use: !parallel
      }
    else converted.parallel_tool_calls = parallel
  }
  const format =
    source === 'responses'
      ? obj(body.text).format
      : (body.response_format ?? obj(body.output_config).format)
  if (format && obj(format).type !== 'text') {
    const f = obj(format)
    const normalized =
      f.type === 'json_schema' && f.json_schema ? { type: 'json_schema', ...obj(f.json_schema) } : f
    if (target === 'responses')
      converted.text = {
        format:
          normalized.type === 'json_schema'
            ? { ...normalized, name: normalized.name ?? 'output' }
            : normalized
      }
    else if (target === 'chat-completions')
      converted.response_format =
        normalized.type === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: {
                name: normalized.name ?? 'output',
                schema: normalized.schema,
                ...(normalized.strict !== undefined ? { strict: normalized.strict } : {})
              }
            }
          : normalized
    else {
      if (normalized.type !== 'json_schema')
        throw new ProtocolError('目标 Messages 接口的结构化输出需要 json_schema')
      converted.output_config = {
        ...converted.output_config,
        format: { type: 'json_schema', schema: normalized.schema }
      }
    }
  }
  if (target === 'chat-completions' && converted.stream)
    converted.stream_options = { include_usage: true }
  if (target === 'responses' && body.prompt_cache_key)
    converted.prompt_cache_key = body.prompt_cache_key
  return { body: converted, context }
}

export function estimateInputTokens(body: Wire): number {
  // OpenCode has no cross-model count_tokens endpoint. Explicitly approximate locally.
  const text = JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })
  let ascii = 0,
    other = 0
  for (const char of text) char.codePointAt(0)! < 128 ? ascii++ : other++
  return Math.max(1, Math.ceil(ascii / 4) + other)
}
