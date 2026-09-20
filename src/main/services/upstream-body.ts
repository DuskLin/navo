import { Readable } from 'node:stream'

/** 有些上游省略或误报 Content-Type；查看有限前缀，并将读取的数据原样放回管线。 */
export async function inspectUpstreamBody(
  body: ReadableStream<Uint8Array>,
  contentType: string | null
) {
  const reader = body.getReader()
  const prefix: Buffer[] = []
  let bytes = 0
  let streaming = /text\/event-stream/i.test(contentType ?? '')
  try {
    while (bytes < 4096) {
      const chunk = await reader.read()
      if (chunk.done) break
      prefix.push(Buffer.from(chunk.value))
      bytes += chunk.value.length
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
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    throw error
  }
  const source = Readable.from(
    (async function* () {
      try {
        yield* prefix
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          yield Buffer.from(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    })()
  )
  return { source, streaming }
}
