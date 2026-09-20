import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { ResponseIdsObserver } from '../src/main/services/response-ids'

async function observe(streaming: boolean, body: string) {
  const ids: string[] = []
  const chunks: Buffer[] = []
  const observer = new ResponseIdsObserver(streaming, (id) => ids.push(id))
  observer.on('data', (chunk) => chunks.push(chunk))
  const end = once(observer, 'end')
  for (const byte of Buffer.from(body)) observer.write(Buffer.from([byte]))
  observer.end()
  await end
  assert.equal(Buffer.concat(chunks).toString(), body)
  return ids
}
test('JSON 响应中的 requestId 提取，响应内容保持不变', async () => {
  assert.deepEqual(
    await observe(false, '{"requestId":"6adf4190-2959-4444-878c-454c7a6673ad","content":"你好"}'),
    ['6adf4190-2959-4444-878c-454c7a6673ad']
  )
})
test('SSE 结束事件中的 request_id 可跨分块提取，不把 response.id 冒充请求 ID', async () => {
  assert.deepEqual(
    await observe(
      true,
      'data: {"response":{"id":"resp_other"}}\r\n\r\ndata: {"delta":"你好"}\n\ndata: {"type":"response.completed","response":{"request_id":"upstream-final"}}\n\n'
    ),
    ['upstream-final']
  )
  assert.deepEqual(await observe(false, '{"id":"local","requestId":"invalid id"}'), [])
})

test('Chat finish_reason at clean EOF completes without DONE, including an unterminated final SSE frame', async () => {
  for (const finish of ['stop', 'length', 'tool_calls', null, 'aborted']) {
    const states: string[] = []
    const observer = new ResponseIdsObserver(
      true,
      () => {},
      'chat-completions',
      undefined,
      (s) => states.push(s)
    )
    observer.resume()
    const end = once(observer, 'end')
    observer.end(
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    )
    await end
    assert.equal(states.includes('complete'), finish !== null && finish !== 'aborted')
    assert.equal(states.includes('error'), finish === 'aborted')
  }
})
