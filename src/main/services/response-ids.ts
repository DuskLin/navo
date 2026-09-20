import { Transform, type TransformCallback } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { generationFailure } from '../../shared/upstream-status'
import { parseUsage, type TokenUsage, type UsageProtocol } from '../../shared/usage'

export function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/.test(value)
}
/** 只提取明确的 requestId/request_id，不把 response.id 当作请求 ID。 */
export class ResponseIdsObserver extends Transform {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private data: string[] = []
  private event = ''
  private size = 0
  private disabled = false
  private chatChoices = new Map<number, boolean>()
  constructor(
    private readonly streaming: boolean,
    private readonly onId: (id: string) => void,
    private readonly protocol?: UsageProtocol,
    private readonly onUsage?: (usage: Partial<TokenUsage>) => void,
    private readonly onStreamState?: (state: 'complete' | 'error' | 'unknown') => void
  ) {
    super()
  }
  private inspect(data: string): void {
    if (this.streaming && data.trim() === '[DONE]') {
      this.onStreamState?.('complete')
      return
    }
    try {
      const root = JSON.parse(data)
      if (generationFailure(root)) this.onStreamState?.('error')
      if (this.streaming) {
        const type = root?.type ?? this.event
        if (['response.failed', 'error'].includes(type) || root?.error)
          this.onStreamState?.('error')
        else if (
          ['response.completed', 'response.done', 'response.incomplete', 'message_stop'].includes(
            type
          )
        )
          this.onStreamState?.('complete')
      }
      if (this.streaming && this.protocol === 'chat-completions' && Array.isArray(root?.choices)) {
        for (const choice of root.choices) {
          const index = choice.index ?? 0
          if (!Number.isInteger(index) || index < 0) continue
          const finished = [
            'stop',
            'length',
            'tool_calls',
            'function_call',
            'content_filter'
          ].includes(choice.finish_reason)
          this.chatChoices.set(index, finished || this.chatChoices.get(index) === true)
        }
      }
      if (this.protocol && this.onUsage) {
        const usage = parseUsage(root, this.protocol)
        if (usage) this.onUsage(usage)
      }
      for (const item of [root, root?.response, root?.error, root?.metadata]) {
        const id = item?.requestId ?? item?.request_id
        if (validRequestId(id)) {
          this.onId(id)
          break
        }
      }
    } catch {
      /* 心跳与非 JSON 事件不影响原样透传。 */
    }
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.disabled) {
      this.pending += this.decoder.write(chunk)
      if (this.streaming) {
        let newline: number
        while ((newline = this.pending.indexOf('\n')) >= 0) {
          const line = this.pending.slice(0, newline).replace(/\r$/, '')
          this.pending = this.pending.slice(newline + 1)
          this.size += line.length
          if (this.size > 1024 * 1024) {
            this.disabled = true
            break
          }
          if (!line) {
            this.inspect(this.data.join('\n'))
            this.data = []
            this.event = ''
            this.size = 0
          } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''))
          else if (line.startsWith('event:')) this.event = line.slice(6).trim()
        }
      }
      if (this.pending.length + this.size > 1024 * 1024) this.disabled = true
      if (this.disabled) {
        this.onStreamState?.('unknown')
        this.pending = ''
        this.data = []
      }
    }
    callback(null, chunk)
  }
  override _flush(callback: TransformCallback): void {
    if (!this.disabled) {
      const tail = this.pending + this.decoder.end()
      if (!this.streaming) this.inspect(tail)
      else {
        if (tail.startsWith('data:'))
          this.data.push(tail.slice(5).replace(/^ /, '').replace(/\r$/, ''))
        if (this.data.length) this.inspect(this.data.join('\n'))
        // Some OpenAI-compatible providers end cleanly after finish_reason, without [DONE].
        if (this.chatChoices.size && [...this.chatChoices.values()].every(Boolean))
          this.onStreamState?.('complete')
      }
    }
    callback()
  }
}
