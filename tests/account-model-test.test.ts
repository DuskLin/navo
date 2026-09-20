import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testAccountModel } from '../src/main/services/account-model-test'
import type { ModelProtocol } from '../src/shared/contracts'

const credential = { accessToken: 'secret-test-token', accountId: 'account-1' }
const input = { provider: 'kimi' as const, region: 'mainland-cn' as const, model: 'manual-model' }
const sse = (...events: unknown[]): Response =>
  new Response(
    events
      .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )

test('model probes send selected model and native protocol and parse stream replies', async () => {
  for (const protocol of ['messages', 'responses', 'chat-completions'] as ModelProtocol[]) {
    const result = await testAccountModel({ ...input, protocol }, credential, async (url, init) => {
      assert.ok(
        String(url).endsWith(protocol === 'chat-completions' ? '/chat/completions' : '/' + protocol)
      )
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-test-token')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, 'manual-model')
      assert.equal(body.stream, true)
      assert.ok(init?.signal)
      assert.equal(init?.redirect, 'error')
      return protocol === 'messages'
        ? sse({ type: 'content_block_delta', delta: { text: 'OK' } }, { type: 'message_stop' })
        : protocol === 'responses'
          ? sse({ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed' })
          : sse({ choices: [{ delta: { content: 'OK' }, finish_reason: null }] }, '[DONE]')
    })
    assert.equal(result.text, 'OK')
    assert.equal(result.model, input.model)
    assert.equal(result.protocol, protocol)
    assert.ok(result.durationMs >= 0)
  }
})

test('Codex probes use account identity, stateless streaming and supported parameters', async () => {
  await testAccountModel(
    { ...input, provider: 'codex', protocol: 'responses' },
    credential,
    async (url, init) => {
      assert.ok(String(url).includes('/backend-api/codex/responses'))
      assert.equal(new Headers(init?.headers).get('chatgpt-account-id'), 'account-1')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.store, false)
      assert.equal(body.max_output_tokens, undefined)
      assert.ok(Array.isArray(body.input))
      return sse({
        type: 'response.completed',
        response: { output: [{ content: [{ text: 'OK' }] }] }
      })
    }
  )
})

test('probes reject HTTP errors, SSE errors, truncated and empty successful responses', async () => {
  for (const response of [
    new Response('invalid secret-test-token', { status: 401 }),
    sse({ type: 'error', error: { message: 'invalid secret-test-token' } }),
    sse({ type: 'response.output_text.delta', delta: 'partial' }),
    sse({ type: 'response.incomplete' }),
    sse('[DONE]'),
    Response.json({}),
    new Response('x'.repeat(1024 * 1024 + 1))
  ]) {
    await assert.rejects(
      testAccountModel({ ...input, protocol: 'responses' }, credential, async () => response),
      (error: Error) => {
        assert.ok(!error.message.includes(credential.accessToken))
        return true
      }
    )
  }
})

test('JSON fallback and split UTF-8 streaming are decoded', async () => {
  const result = await testAccountModel({ ...input, protocol: 'messages' }, credential, async () =>
    Response.json({ content: [{ text: '正常' }], stop_reason: 'end_turn' })
  )
  assert.equal(result.text, '正常')
  const bytes = new TextEncoder().encode(
    'data: {"type":"content_block_delta","delta":{"text":"正常"}}\n\ndata: {"type":"message_stop"}\n\n'
  )
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      }
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  )
  assert.equal(
    (await testAccountModel({ ...input, protocol: 'messages' }, credential, async () => response))
      .text,
    '正常'
  )
})

test('test telemetry retains reported usage on streaming failure and records HTTP/timeout status', async () => {
  const samples: import('../src/main/services/account-model-test').ModelTestTelemetry[] = []
  await assert.rejects(
    testAccountModel(
      { ...input, protocol: 'messages' },
      credential,
      async () =>
        sse(
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 12,
                cache_read_input_tokens: 4,
                cache_creation_input_tokens: 2
              }
            }
          },
          { type: 'content_block_delta', delta: { text: 'partial' } },
          { type: 'message_delta', usage: { output_tokens: 3 } },
          { type: 'error', error: { message: 'upstream failed' } }
        ),
      (value) => samples.push(value)
    )
  )
  assert.equal(samples.length, 1)
  assert.equal(samples[0].status, 502)
  assert.equal(samples[0].interruption, 'upstream_error')
  assert.deepEqual(samples[0].usage, {
    input: 12,
    output: 3,
    cacheRead: 4,
    cacheWrite: 2,
    cost: null
  })
  assert.notEqual(samples[0].firstTokenMs, null)
  assert.notEqual(samples[0].streamDurationMs, null)
  await assert.rejects(
    testAccountModel(
      { ...input, protocol: 'responses' },
      credential,
      async () => new Response('denied', { status: 401 }),
      (value) => samples.push(value)
    )
  )
  assert.equal(samples[1].status, 401)
  await assert.rejects(
    testAccountModel(
      { ...input, protocol: 'responses' },
      credential,
      async () => {
        throw new DOMException('timeout', 'TimeoutError')
      },
      (value) => samples.push(value)
    )
  )
  assert.equal(samples[2].status, 504)
  assert.equal(samples[2].interruption, 'timeout')
})

test('Responses completed event records usage and reported cost once', async () => {
  let sample: import('../src/main/services/account-model-test').ModelTestTelemetry | undefined
  await testAccountModel(
    { ...input, protocol: 'responses' },
    credential,
    async () =>
      sse({
        type: 'response.completed',
        response: {
          request_id: 'test-id',
          output: [{ content: [{ text: 'OK' }] }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 3 },
            cost_usd: 0.02
          }
        }
      }),
    (value) => {
      sample = value
    }
  )
  assert.equal(sample?.status, 200)
  assert.equal(sample?.upstreamRequestId, 'test-id')
  assert.deepEqual(sample?.usage, {
    input: 7,
    output: 2,
    cacheRead: 3,
    cacheWrite: null,
    cost: 0.02
  })
})

test('SSE with incorrect or missing content type is detected across chunk boundaries, including usage', async () => {
  for (const contentType of [undefined, 'application/json', 'text/plain', 'Text/Event-Stream']) {
    let sample: import('../src/main/services/account-model-test').ModelTestTelemetry | undefined
    const raw =
      ': heartbeat\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2},"request_id":"sniffed-request"}}\n\n'
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of new TextEncoder().encode(raw))
            controller.enqueue(new Uint8Array([byte]))
          controller.close()
        }
      }),
      { headers: contentType ? { 'content-type': contentType } : {} }
    )
    const result = await testAccountModel(
      { ...input, protocol: 'responses' },
      credential,
      async () => response,
      (value) => {
        sample = value
      }
    )
    assert.equal(result.text, 'OK')
    assert.equal(sample?.usage?.input, 10)
    assert.equal(sample?.usage?.output, 2)
    assert.equal(sample?.upstreamRequestId, 'sniffed-request')
    assert.notEqual(sample?.firstTokenMs, null)
    assert.notEqual(sample?.streamDurationMs, null)
  }
})

test('SSE event prefix without heartbeat and falsely labelled JSON are both decoded', async () => {
  for (const [contentType, raw] of [
    [
      'application/json',
      'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"content":[{"text":"OK"}]}]}}\n\n'
    ],
    ['text/event-stream', '{"status":"completed","output":[{"content":[{"text":"OK"}]}]}']
  ]) {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of new TextEncoder().encode(raw))
            controller.enqueue(new Uint8Array([byte]))
          controller.close()
        }
      }),
      { headers: { 'content-type': contentType } }
    )
    assert.equal(
      (
        await testAccountModel(
          { ...input, protocol: 'responses' },
          credential,
          async () => response
        )
      ).text,
      'OK'
    )
  }
})
