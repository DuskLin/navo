import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectUpstreamBody } from '../src/main/services/upstream-body'

test('缺失或错误响应头时识别 SSE，跨分块原样保留 UTF-8 与心跳', async () => {
  const data = Buffer.from(': 心跳\n\nevent: response.completed\ndata: {"text":"你好"}\n\n')
  for (const header of [null, 'application/json', 'text/event-stream']) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of data) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      }
    })
    const result = await inspectUpstreamBody(body, header)
    assert.equal(result.streaming, true)
    const chunks: Buffer[] = []
    for await (const chunk of result.source) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), data)
    assert.equal(body.locked, false)
  }
})

test('事件字段拆分仍能识别，JSON 不被错误标为 SSE', async () => {
  for (const [parts, header, expected] of [
    [['ev', 'ent', ': ping\n\ndata: {}\n\n'], null, true],
    [[' ', '{"error":"test"}'], 'text/event-stream', false]
  ] as const) {
    const result = await inspectUpstreamBody(
      new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(Buffer.from(part))
          controller.close()
        }
      }),
      header
    )
    assert.equal(result.streaming, expected)
    const chunks = []
    for await (const chunk of result.source) chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(), parts.join(''))
  }
})
