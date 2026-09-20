import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { generationFailure } from '../../shared/upstream-status'
import { parseUsage, type TokenUsage, type UsageProtocol } from '../../shared/usage'
import { obj, list, str, ProtocolError, type Wire, type BridgeContext } from './protocol-request'

interface Block {
  key: string
  kind: 'text' | 'thinking' | 'tool' | 'refusal'
  id: string
  callId: string
  name: string
  value: string
  signature: string
  closed: boolean
  truncated: boolean
}
const uid = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`
const badResponse = () => new ProtocolError('上游协议响应无效或缺少完整结束事件', 502)

class ResponseBridge {
  readonly id: string
  readonly created = Math.floor(Date.now() / 1000)
  readonly blocks: Block[] = []
  readonly usage: Partial<TokenUsage> = {}
  private output: Buffer[] = []
  private sequence = 0
  private started = false
  finished = false
  failed = false
  private size = 0
  private reason = 'stop'
  private sourceTypes = new Map<number, string>()
  private itemKeys = new Map<string, string>()
  private pendingTools = new Map<string, { callId: string; arguments: string }>()
  private model: string
  private requestId?: string
  constructor(
    private readonly target: UsageProtocol,
    private readonly context: BridgeContext,
    private readonly streaming: boolean
  ) {
    this.model = context.model
    this.id = uid(target === 'messages' ? 'msg' : target === 'responses' ? 'resp' : 'chatcmpl')
  }
  drain(): Buffer[] {
    return this.output.splice(0)
  }
  private event(type: string, data: Wire): void {
    if (!this.streaming) return
    const value =
      this.target === 'responses'
        ? { type, sequence_number: this.sequence++, ...data }
        : { type, ...data }
    this.output.push(Buffer.from(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`))
  }
  private chat(delta: Wire, finish: string | null = null, usage = false): void {
    if (!this.streaming) return
    this.output.push(
      Buffer.from(
        `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage: this.usageFor('chat-completions') } : {}) })}\n\n`
      )
    )
  }
  private usageFor(protocol: UsageProtocol): Wire | undefined {
    const u = this.usage
    if (!Object.keys(u).length) return undefined
    const input =
      u.input == null
        ? undefined
        : u.input + (protocol === 'messages' ? 0 : (u.cacheRead ?? 0) + (u.cacheWrite ?? 0))
    return protocol === 'messages'
      ? {
          ...(input !== undefined ? { input_tokens: input } : {}),
          ...(u.output != null ? { output_tokens: u.output } : {}),
          ...(u.cacheRead != null ? { cache_read_input_tokens: u.cacheRead } : {}),
          ...(u.cacheWrite != null ? { cache_creation_input_tokens: u.cacheWrite } : {}),
          ...(u.cost != null ? { cost_usd: u.cost } : {})
        }
      : {
          ...(input !== undefined
            ? { [protocol === 'responses' ? 'input_tokens' : 'prompt_tokens']: input }
            : {}),
          ...(u.output != null
            ? { [protocol === 'responses' ? 'output_tokens' : 'completion_tokens']: u.output }
            : {}),
          ...(input !== undefined && u.output != null ? { total_tokens: input + u.output } : {}),
          ...(u.cacheRead != null
            ? {
                [protocol === 'responses' ? 'input_tokens_details' : 'prompt_tokens_details']: {
                  cached_tokens: u.cacheRead
                }
              }
            : {}),
          ...(u.cacheWrite != null ? { cache_creation_input_tokens: u.cacheWrite } : {}),
          ...(u.cost != null ? { cost_usd: u.cost } : {})
        }
  }
  private start(): void {
    if (this.started) return
    this.started = true
    if (this.target === 'chat-completions') this.chat({ role: 'assistant', content: '' })
    else if (this.target === 'messages')
      this.event('message_start', {
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, ...this.usageFor('messages') }
        }
      })
    else {
      const response = this.response('in_progress', [])
      this.event('response.created', { response })
      this.event('response.in_progress', { response })
    }
  }
  private custom(b: Block): boolean {
    return this.target === 'responses' && this.context.tools.get(b.name)?.custom === true
  }
  private toolInput(b: Block): Wire {
    try {
      const input = JSON.parse(b.value || '{}')
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error()
      if (this.custom(b) && typeof input.input !== 'string')
        throw new ProtocolError('上游 custom 工具缺少字符串 input 参数', 502)
      return input
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError('上游工具参数不是有效 JSON 对象', 502)
    }
  }
  private responseItem(
    b: Block,
    status = b.truncated ? 'incomplete' : 'completed',
    empty = false
  ): Wire {
    if (b.kind === 'tool') {
      const identity = this.context.tools.get(b.name)
      const base = {
        id: b.id,
        call_id: b.callId,
        name: identity?.name ?? b.name,
        ...(identity?.namespace ? { namespace: identity.namespace } : {}),
        status
      }
      return this.custom(b)
        ? {
            ...base,
            type: 'custom_tool_call',
            input: empty || b.truncated ? '' : str(this.toolInput(b).input)
          }
        : { ...base, type: 'function_call', arguments: empty ? '' : b.value || '{}' }
    }
    if (b.kind === 'thinking')
      return {
        id: b.id,
        type: 'reasoning',
        summary: empty ? [] : [{ type: 'summary_text', text: b.value }]
      }
    return {
      id: b.id,
      type: 'message',
      role: 'assistant',
      status,
      content: empty ? [] : [this.responsePart(b)]
    }
  }
  private responsePart(b: Block, empty = false): Wire {
    return b.kind === 'refusal'
      ? { type: 'refusal', refusal: empty ? '' : b.value }
      : { type: 'output_text', text: empty ? '' : b.value, annotations: [] }
  }
  private anthropicBlock(b: Block, empty = false): Wire {
    if (b.kind === 'tool')
      return { type: 'tool_use', id: b.callId, name: b.name, input: empty ? {} : this.toolInput(b) }
    if (b.kind === 'thinking')
      return {
        type: 'thinking',
        thinking: empty ? '' : b.value,
        ...(b.signature ? { signature: empty ? '' : b.signature } : {})
      }
    return { type: 'text', text: empty ? '' : b.value }
  }
  private block(key: string, kind: Block['kind'], metadata: Wire = {}): Block {
    const previous = this.blocks.find((b) => b.key === key)
    if (previous) {
      if (metadata.name && previous.name !== metadata.name) throw badResponse()
      return previous
    }
    if (this.blocks.length >= 1024) throw new ProtocolError('上游输出块过多', 502)
    this.start()
    const block: Block = {
      key,
      kind,
      id: uid(kind === 'tool' ? 'fc' : kind === 'thinking' ? 'rs' : 'msg'),
      callId: str(metadata.callId) || uid('call'),
      name: str(metadata.name),
      value: '',
      signature: '',
      closed: false,
      truncated: false
    }
    this.blocks.push(block)
    this.retain(block.name + block.callId)
    const index = this.blocks.length - 1
    if (this.target === 'chat-completions') {
      if (kind === 'tool')
        this.chat({
          tool_calls: [
            {
              index: this.toolIndex(block),
              id: block.callId,
              type: 'function',
              function: { name: block.name, arguments: '' }
            }
          ]
        })
    } else if (this.target === 'responses') {
      this.event('response.output_item.added', {
        output_index: index,
        item: this.responseItem(block, 'in_progress', true)
      })
      if (kind === 'thinking')
        this.event('response.reasoning_summary_part.added', {
          item_id: block.id,
          output_index: index,
          summary_index: 0,
          part: { type: 'summary_text', text: '' }
        })
      else if (kind !== 'tool')
        this.event('response.content_part.added', {
          item_id: block.id,
          output_index: index,
          content_index: 0,
          part: this.responsePart(block, true)
        })
    }
    // Messages tool blocks are emitted at close; this preserves valid JSON for parallel calls.
    return block
  }
  private toolIndex(block: Block): number {
    return this.blocks.filter((b) => b.kind === 'tool').indexOf(block)
  }
  private messageIndex = new Map<string, number>()
  private nextMessageIndex = 0
  private activeMessage?: Block
  private openMessage(block: Block): number {
    const old = this.messageIndex.get(block.key)
    if (old !== undefined && this.activeMessage === block) return old
    if (this.activeMessage) this.closeMessage(this.activeMessage)
    const index = this.nextMessageIndex++
    this.messageIndex.set(block.key, index)
    this.activeMessage = block
    this.event('content_block_start', { index, content_block: this.anthropicBlock(block, true) })
    return index
  }
  private closeMessage(block: Block): void {
    if (this.activeMessage !== block) return
    if (block.kind === 'thinking' && block.signature)
      this.event('content_block_delta', {
        index: this.messageIndex.get(block.key),
        delta: { type: 'signature_delta', signature: block.signature }
      })
    this.event('content_block_stop', { index: this.messageIndex.get(block.key) })
    this.activeMessage = undefined
  }
  private append(block: Block, delta: string): void {
    if (!delta) return
    if (block.closed) throw badResponse()
    this.retain(delta)
    block.value += delta
    const index = this.blocks.indexOf(block)
    if (this.target === 'chat-completions') {
      this.chat(
        block.kind === 'tool'
          ? { tool_calls: [{ index: this.toolIndex(block), function: { arguments: delta } }] }
          : {
              [block.kind === 'thinking'
                ? 'reasoning_content'
                : block.kind === 'refusal'
                  ? 'refusal'
                  : 'content']: delta
            }
      )
    } else if (this.target === 'responses') {
      if (this.custom(block)) return
      this.event(
        block.kind === 'tool'
          ? 'response.function_call_arguments.delta'
          : block.kind === 'thinking'
            ? 'response.reasoning_summary_text.delta'
            : block.kind === 'refusal'
              ? 'response.refusal.delta'
              : 'response.output_text.delta',
        {
          item_id: block.id,
          output_index: index,
          ...(block.kind === 'thinking'
            ? { summary_index: 0 }
            : block.kind !== 'tool'
              ? { content_index: 0 }
              : {}),
          delta
        }
      )
    } else if (block.kind !== 'tool') {
      const index = this.openMessage(block)
      this.event('content_block_delta', {
        index,
        delta:
          block.kind === 'thinking'
            ? { type: 'thinking_delta', thinking: delta }
            : { type: 'text_delta', text: delta }
      })
    }
  }
  private retain(value: string): void {
    this.size += Buffer.byteLength(value)
    if (this.size > 16 * 1024 * 1024) throw new ProtocolError('协议转换响应超过 16 MB', 502)
  }
  private close(block: Block): void {
    if (block.closed) return
    if (block.kind === 'tool') {
      if (this.reason === 'length') {
        try {
          JSON.parse(block.value)
        } catch {
          block.truncated = true
        }
      }
      if (!block.truncated) this.toolInput(block)
    }
    block.closed = true
    const index = this.blocks.indexOf(block)
    if (block.truncated) {
      // Never fabricate valid tool input for a cut-off call. Messages requires an
      // object, so omit that block and report max_tokens; Responses can retain
      // partial arguments on an explicitly incomplete item.
      if (this.target === 'responses')
        this.event('response.output_item.done', {
          output_index: index,
          item: this.responseItem(block)
        })
      return
    }
    if (this.target === 'messages') {
      if (block.kind === 'tool') {
        const index = this.openMessage(block)
        this.event('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: block.value || '{}' }
        })
      }
      this.closeMessage(block)
    } else if (this.target === 'responses') {
      const common = { item_id: block.id, output_index: index }
      if (this.custom(block)) {
        const input = str(this.toolInput(block).input)
        this.event('response.custom_tool_call_input.delta', { ...common, delta: input })
        this.event('response.custom_tool_call_input.done', { ...common, input })
      } else if (block.kind === 'tool')
        this.event('response.function_call_arguments.done', {
          ...common,
          arguments: block.value || '{}'
        })
      else if (block.kind === 'thinking') {
        this.event('response.reasoning_summary_text.done', {
          ...common,
          summary_index: 0,
          text: block.value
        })
        this.event('response.reasoning_summary_part.done', {
          ...common,
          summary_index: 0,
          part: { type: 'summary_text', text: block.value }
        })
      } else {
        this.event(
          block.kind === 'refusal' ? 'response.refusal.done' : 'response.output_text.done',
          {
            ...common,
            content_index: 0,
            [block.kind === 'refusal' ? 'refusal' : 'text']: block.value
          }
        )
        this.event('response.content_part.done', {
          ...common,
          content_index: 0,
          part: this.responsePart(block)
        })
      }
      this.event('response.output_item.done', {
        output_index: index,
        item: this.responseItem(block)
      })
    }
  }
  private response(status: string, output = this.blocks.map((b) => this.responseItem(b))): Wire {
    return {
      id: this.id,
      object: 'response',
      created_at: this.created,
      model: this.model,
      status,
      output,
      error: null,
      incomplete_details:
        status === 'incomplete'
          ? { reason: this.reason === 'content_filter' ? 'content_filter' : 'max_output_tokens' }
          : null,
      ...(this.usageFor('responses') ? { usage: this.usageFor('responses') } : {}),
      ...(this.requestId ? { request_id: this.requestId } : {})
    }
  }
  private finish(reason = this.reason): void {
    if (this.finished) return
    if (this.pendingTools.size) {
      if (reason !== 'length') throw new ProtocolError('上游工具调用缺少名称', 502)
      this.pendingTools.clear()
    }
    this.reason = reason
    this.start()
    for (const block of this.blocks) this.close(block)
    this.finished = true
    if (this.target === 'chat-completions') {
      this.chat({}, this.chatReason())
      if (this.usageFor('chat-completions')) this.chat({}, null, true)
      if (this.streaming) this.output.push(Buffer.from('data: [DONE]\n\n'))
    } else if (this.target === 'messages') {
      this.event('message_delta', {
        delta: { stop_reason: this.stopReason(), stop_sequence: null },
        usage: { output_tokens: 0, ...this.usageFor('messages') }
      })
      this.event('message_stop', {})
    } else {
      const status = ['length', 'content_filter'].includes(reason) ? 'incomplete' : 'completed'
      this.event(`response.${status}`, { response: this.response(status) })
    }
  }
  private stopReason(): string {
    return this.reason === 'length'
      ? 'max_tokens'
      : this.blocks.some((b) => b.kind === 'tool' && !b.truncated)
        ? 'tool_use'
        : this.reason === 'stop_sequence'
          ? 'stop_sequence'
          : 'end_turn'
  }
  private chatReason(): string {
    if (this.reason === 'stop_sequence') return 'stop'
    return this.reason === 'stop' && this.blocks.some((b) => b.kind === 'tool')
      ? 'tool_calls'
      : this.reason
  }
  private reconcile(block: Block, complete: string): void {
    if (!complete || complete === block.value) return
    if (!complete.startsWith(block.value)) throw badResponse()
    this.append(block, complete.slice(block.value.length))
  }
  private error(message = '上游返回错误'): void {
    if (this.finished) return
    this.failed = true
    this.finished = true
    if (!this.streaming) throw new ProtocolError(message, 502)
    if (this.target === 'responses')
      this.event('response.failed', {
        response: { ...this.response('failed', []), error: { code: 'upstream_error', message } }
      })
    else if (this.target === 'messages')
      this.event('error', { error: { type: 'api_error', message } })
    else
      this.output.push(
        Buffer.from(`data: ${JSON.stringify({ error: { type: 'api_error', message } })}\n\n`)
      )
  }
  private metadata(root: Wire, protocol: UsageProtocol): void {
    Object.assign(this.usage, parseUsage(root, protocol) ?? {})
    const data = obj(root.response ?? root.message ?? root)
    if (data.model) this.model = str(data.model)
    const id = root.request_id ?? root.requestId ?? data.request_id
    if (typeof id === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/.test(id)) this.requestId = id
  }
  private fullItem(item: Wire, key: string): void {
    if (!['function_call', 'reasoning', 'message'].includes(item.type))
      throw new ProtocolError('上游返回无法转换的输出类型', 502)
    if (item.type === 'function_call') {
      const b = this.block(key, 'tool', { callId: item.call_id, name: item.name })
      this.reconcile(b, str(item.arguments))
      return
    }
    if (item.type === 'reasoning') {
      for (const [index, summary] of list(item.summary).entries()) {
        const b = this.block(`${key}:thinking:${index}`, 'thinking')
        this.reconcile(b, str(summary.text))
      }
      return
    }
    if (item.type === 'message')
      for (const [index, part] of list(item.content).entries()) {
        const b = this.block(`${key}:${index}`, part.type === 'refusal' ? 'refusal' : 'text')
        this.reconcile(b, str(part.text ?? part.refusal))
      }
  }
  readJSON(root: Wire, source: UsageProtocol): void {
    this.metadata(root, source)
    const failure = generationFailure(root)
    if (failure) {
      this.error(`上游生成中断 (${failure})`)
      return
    }
    if (root.error || root.type === 'error' || root.status === 'failed') {
      this.error(str(obj(root.error).message) || '上游返回错误')
      return
    }
    if (source === 'chat-completions') {
      const choice = list(root.choices)[0]
      if (!choice) throw badResponse()
      const message = obj(choice.message)
      if (message.reasoning_content ?? message.reasoning)
        this.append(
          this.block('thinking', 'thinking'),
          str(message.reasoning_content ?? message.reasoning)
        )
      const content =
        typeof message.content === 'string'
          ? message.content
          : list(message.content)
              .map((p) => str(p.text))
              .join('')
      if (content) this.append(this.block('text', 'text'), content)
      if (message.refusal) this.append(this.block('refusal', 'refusal'), str(message.refusal))
      for (const [index, tool] of list(message.tool_calls).entries())
        this.append(
          this.block(`tool:${index}`, 'tool', { callId: tool.id, name: obj(tool.function).name }),
          str(obj(tool.function).arguments)
        )
      this.finish(str(choice.finish_reason) || 'stop')
    } else if (source === 'messages') {
      if (!Array.isArray(root.content)) throw badResponse()
      for (const [index, block] of list(root.content).entries()) {
        if (!['text', 'thinking', 'tool_use', 'redacted_thinking'].includes(block.type))
          throw badResponse()
        if (block.type === 'redacted_thinking') continue
        const b = this.block(
          String(index),
          block.type === 'tool_use' ? 'tool' : block.type === 'thinking' ? 'thinking' : 'text',
          { callId: block.id, name: block.name }
        )
        b.signature = str(block.signature)
        this.append(
          b,
          block.type === 'tool_use'
            ? JSON.stringify(block.input ?? {})
            : str(block.text ?? block.thinking)
        )
        if (b.kind !== 'tool') this.close(b)
      }
      this.finish(
        root.stop_reason === 'max_tokens'
          ? 'length'
          : root.stop_reason === 'tool_use'
            ? 'tool_calls'
            : root.stop_reason === 'stop_sequence'
              ? 'stop_sequence'
              : 'stop'
      )
    } else {
      if (root.status !== undefined && !['completed', 'incomplete'].includes(root.status))
        throw badResponse()
      if (!Array.isArray(root.output)) throw badResponse()
      for (const [index, item] of list(root.output).entries())
        this.fullItem(item, str(item.id) || String(index))
      this.finish(
        root.status === 'incomplete'
          ? obj(root.incomplete_details).reason === 'content_filter'
            ? 'content_filter'
            : 'length'
          : 'stop'
      )
    }
  }
  readEvent(root: Wire, event: string, source: UsageProtocol): void {
    if (this.finished) return
    this.metadata(root, source)
    const failure = generationFailure(root)
    if (failure) {
      this.error(`上游生成中断 (${failure})`)
      return
    }
    const type = str(root.type) || event
    if (root.error || type === 'error' || type === 'response.failed') {
      this.error(str(obj(root.error ?? obj(root.response).error).message) || '上游返回错误')
      return
    }
    if (source === 'chat-completions') {
      this.start()
      for (const choice of list(root.choices)) {
        if ((choice.index ?? 0) !== 0) throw badResponse()
        const delta = obj(choice.delta)
        if (delta.reasoning_content ?? delta.reasoning)
          this.append(
            this.block('thinking', 'thinking'),
            str(delta.reasoning_content ?? delta.reasoning)
          )
        if (delta.content) this.append(this.block('text', 'text'), str(delta.content))
        if (delta.refusal) this.append(this.block('refusal', 'refusal'), str(delta.refusal))
        for (const tool of list(delta.tool_calls)) {
          const fn = obj(tool.function)
          const key = `tool:${tool.index ?? 0}`
          const pending = this.pendingTools.get(key)
          if (!this.blocks.some((b) => b.key === key) && !fn.name) {
            const buffered = pending ?? { callId: str(tool.id), arguments: '' }
            buffered.callId = str(tool.id) || buffered.callId
            this.retain(str(fn.arguments))
            buffered.arguments += str(fn.arguments)
            this.pendingTools.set(key, buffered)
            if (this.pendingTools.size > 1024) throw badResponse()
            continue
          }
          if (pending) {
            this.pendingTools.delete(key)
            this.size -= Buffer.byteLength(pending.arguments)
          }
          this.append(
            this.block(key, 'tool', { callId: tool.id || pending?.callId, name: fn.name }),
            (pending?.arguments ?? '') + str(fn.arguments)
          )
        }
        if (choice.finish_reason) this.reason = choice.finish_reason
      }
    } else if (source === 'messages') {
      if (type === 'message_start') this.start()
      if (type === 'content_block_start') {
        const block = obj(root.content_block)
        this.sourceTypes.set(root.index, block.type)
        if (this.sourceTypes.size > 1024) throw badResponse()
        if (block.type === 'redacted_thinking') return
        if (!['text', 'thinking', 'tool_use'].includes(block.type)) throw badResponse()
        const b = this.block(
          String(root.index),
          block.type === 'tool_use' ? 'tool' : block.type === 'thinking' ? 'thinking' : 'text',
          { callId: block.id, name: block.name }
        )
        b.signature = str(block.signature)
        // Streaming tool_use usually starts with input: {}; actual arguments arrive as deltas.
        this.append(
          b,
          block.type === 'tool_use'
            ? Object.keys(obj(block.input)).length
              ? JSON.stringify(block.input)
              : ''
            : str(block.text ?? block.thinking)
        )
      } else if (type === 'content_block_delta') {
        if (this.sourceTypes.get(root.index) === 'redacted_thinking') return
        const b = this.blocks.find((b) => b.key === String(root.index))
        if (!b) throw badResponse()
        const delta = obj(root.delta)
        if (delta.type === 'signature_delta') {
          this.retain(str(delta.signature))
          b.signature += str(delta.signature)
        } else this.append(b, str(delta.text ?? delta.thinking ?? delta.partial_json))
      } else if (type === 'content_block_stop') {
        const b = this.blocks.find((b) => b.key === String(root.index))
        if (b && b.kind !== 'tool') this.close(b)
      } else if (type === 'message_delta') {
        const reason = obj(root.delta).stop_reason
        if (reason)
          this.reason =
            reason === 'max_tokens'
              ? 'length'
              : reason === 'tool_use'
                ? 'tool_calls'
                : reason === 'stop_sequence'
                  ? 'stop_sequence'
                  : 'stop'
      } else if (type === 'message_stop') this.finish()
    } else {
      const key =
        str(root.item_id) ||
        this.itemKeys.get(String(root.output_index)) ||
        String(root.output_index ?? 0)
      if (['response.created', 'response.in_progress'].includes(type)) this.start()
      else if (type === 'response.output_item.added') {
        const item = obj(root.item)
        const k = str(item.id) || String(root.output_index)
        this.itemKeys.set(String(root.output_index), k)
        if (this.itemKeys.size > 1024) throw badResponse()
        if (item.type === 'function_call')
          this.block(k, 'tool', { callId: item.call_id, name: item.name })
      } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta')
        this.append(
          this.block(
            `${key}:${root.content_index ?? 0}`,
            type === 'response.refusal.delta' ? 'refusal' : 'text'
          ),
          str(root.delta)
        )
      else if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta'
      )
        this.append(
          this.block(`${key}:thinking:${root.summary_index ?? 0}`, 'thinking'),
          str(root.delta)
        )
      else if (type === 'response.function_call_arguments.delta') {
        const b = this.blocks.find((b) => b.key === key)
        if (!b) throw badResponse()
        this.append(b, str(root.delta))
      } else if (type === 'response.output_text.done' || type === 'response.refusal.done') {
        this.reconcile(
          this.block(
            `${key}:${root.content_index ?? 0}`,
            type === 'response.refusal.done' ? 'refusal' : 'text'
          ),
          str(root.text ?? root.refusal)
        )
      } else if (type === 'response.reasoning_summary_text.done') {
        this.reconcile(
          this.block(`${key}:thinking:${root.summary_index ?? 0}`, 'thinking'),
          str(root.text)
        )
      } else if (type === 'response.function_call_arguments.done') {
        const b = this.blocks.find((b) => b.key === key)
        if (!b) throw badResponse()
        this.reconcile(b, str(root.arguments))
      } else if (type === 'response.output_item.done')
        this.fullItem(obj(root.item), str(obj(root.item).id) || key)
      else if (['response.completed', 'response.done', 'response.incomplete'].includes(type)) {
        const response = obj(root.response)
        if (response.status === 'failed' || response.error) {
          this.error(str(obj(response.error).message))
          return
        }
        if (response.status !== undefined && !['completed', 'incomplete'].includes(response.status))
          throw badResponse()
        for (const [index, item] of list(response.output).entries())
          this.fullItem(item, str(item.id) || this.itemKeys.get(String(index)) || String(index))
        this.finish(
          type === 'response.incomplete' || response.status === 'incomplete'
            ? obj(response.incomplete_details).reason === 'content_filter'
              ? 'content_filter'
              : 'length'
            : 'stop'
        )
      }
    }
  }
  done(source: UsageProtocol): void {
    if (source === 'chat-completions') this.finish()
    else if (!this.finished) throw badResponse()
  }
  json(): Wire {
    if (!this.finished || this.failed) throw badResponse()
    if (this.target === 'responses')
      return this.response(
        ['length', 'content_filter'].includes(this.reason) ? 'incomplete' : 'completed'
      )
    if (this.target === 'messages')
      return {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: this.blocks.filter((b) => !b.truncated).map((b) => this.anthropicBlock(b)),
        stop_reason: this.stopReason(),
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, ...this.usageFor('messages') },
        ...(this.requestId ? { request_id: this.requestId } : {})
      }
    const tools = this.blocks.filter((b) => b.kind === 'tool')
    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              this.blocks
                .filter((b) => b.kind === 'text')
                .map((b) => b.value)
                .join('') || (tools.length ? null : ''),
            ...(this.blocks.some((b) => b.kind === 'thinking')
              ? {
                  reasoning_content: this.blocks
                    .filter((b) => b.kind === 'thinking')
                    .map((b) => b.value)
                    .join('')
                }
              : {}),
            ...(this.blocks.some((b) => b.kind === 'refusal')
              ? {
                  refusal: this.blocks
                    .filter((b) => b.kind === 'refusal')
                    .map((b) => b.value)
                    .join('')
                }
              : {}),
            ...(tools.length
              ? {
                  tool_calls: tools.map((b) => ({
                    id: b.callId,
                    type: 'function',
                    function: { name: b.name, arguments: b.value || '{}' }
                  }))
                }
              : {})
          },
          finish_reason: this.chatReason()
        }
      ],
      ...(this.usageFor('chat-completions') ? { usage: this.usageFor('chat-completions') } : {}),
      ...(this.requestId ? { request_id: this.requestId } : {})
    }
  }
}

export interface ResponseConversion {
  source: UsageProtocol
  target: UsageProtocol
  context: BridgeContext
  inputStream: boolean
  outputStream: boolean
  ok: boolean
}

/** Async generator preserves pipeline backpressure and cancellation. No complete SSE buffering. */
export async function* convertResponse(
  chunks: AsyncIterable<Buffer>,
  options: ResponseConversion
): AsyncGenerator<Buffer> {
  const bridge = new ResponseBridge(options.target, options.context, options.outputStream)
  const decoder = new StringDecoder('utf8')
  let nativeResponse: Wire | undefined
  const preserveNative =
    options.source === 'responses' && options.target === 'responses' && !options.outputStream
  if (!options.inputStream || !options.ok) {
    const buffers: Buffer[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      bytes += chunk.length
      if (bytes > 16 * 1024 * 1024) throw new ProtocolError('协议转换响应超过 16 MB', 502)
      buffers.push(chunk)
    }
    let root: Wire
    try {
      root = obj(JSON.parse(Buffer.concat(buffers).toString('utf8')))
    } catch {
      if (options.ok) throw badResponse()
      root = { error: { message: '上游返回非 JSON 错误响应' } }
    }
    if (!options.ok) {
      const error = obj(root.error)
      yield Buffer.from(
        JSON.stringify(
          options.target === 'messages'
            ? {
                type: 'error',
                error: {
                  type: str(error.type) || 'api_error',
                  message: str(error.message ?? root.message) || '上游请求失败'
                }
              }
            : {
                error: {
                  message: str(error.message ?? root.message) || '上游请求失败',
                  type: str(error.type) || 'api_error',
                  code: error.code ?? null
                }
              }
        )
      )
      return
    }
    if (preserveNative) {
      yield Buffer.from(JSON.stringify(root))
      return
    }
    bridge.readJSON(root, options.source)
    if (options.outputStream) yield* bridge.drain()
    else yield Buffer.from(JSON.stringify(bridge.json()))
    return
  }
  let lineParts: string[] = [],
    lineSize = 0,
    event = '',
    data: string[] = [],
    size = 0
  function dispatch(): void {
    const value = data.join('\n')
    if (value.trim() === '[DONE]') bridge.done(options.source)
    else if (value.trim()) {
      let root: Wire
      try {
        root = obj(JSON.parse(value))
      } catch {
        throw badResponse()
      }
      if (
        preserveNative &&
        ['response.completed', 'response.incomplete'].includes(root.type ?? event)
      )
        nativeResponse = obj(root.response)
      bridge.readEvent(root, event, options.source)
    }
    event = ''
    data = []
    size = 0
  }
  for await (const chunk of chunks) {
    const lines = decoder.write(chunk).split('\n')
    for (let i = 0; i < lines.length; i++) {
      lineParts.push(lines[i])
      lineSize += lines[i].length
      if (lineSize + size > 1024 * 1024) throw new ProtocolError('上游 SSE 事件超过 1 MB', 502)
      if (i === lines.length - 1) break
      const line = lineParts.join('').replace(/\r$/, '')
      lineParts = []
      lineSize = 0
      size += line.length
      if (size > 1024 * 1024) throw new ProtocolError('上游 SSE 事件超过 1 MB', 502)
      if (!line) {
        dispatch()
        yield* bridge.drain()
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) event = line.slice(6).trim()
    }
  }
  const pending = lineParts.join('') + decoder.end()
  if (pending.startsWith('data:')) data.push(pending.slice(5).replace(/^ /, ''))
  if (data.length) {
    dispatch()
    yield* bridge.drain()
  }
  if (!bridge.finished) throw badResponse()
  if (!options.outputStream) yield Buffer.from(JSON.stringify(nativeResponse ?? bridge.json()))
}
