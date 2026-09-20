import { normalizeMiniMaxRequest } from '../src/main/services/minimax-request'
import { convertRequest } from '../src/main/services/protocol-request'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMiniMaxQuota } from '../src/shared/minimax'
import { KimiCapabilities } from '../src/main/services/kimi-capabilities'
import { upstreamUrl } from '../src/shared/contracts'

test('MiniMax uses general remaining percentages, weekly enablement and reset timestamps', () => {
  const general = {
    model_name: ' General ',
    current_interval_remaining_percent: '72.5',
    end_time: 1893456000,
    current_weekly_status: 1,
    current_weekly_remaining_percent: 0,
    weekly_end_time: '1893456000000'
  }
  const parse = (fields = {}) =>
    parseMiniMaxQuota({
      model_remains: [
        { model_name: 'video', current_interval_remaining_percent: 0 },
        { ...general, ...fields }
      ]
    })!
  const quota = parse()
  assert.equal(quota.unit, 'percent')
  assert.equal(quota.fiveHour?.remaining, 72.5)
  assert.equal(quota.fiveHour?.used, 27.5)
  assert.equal(quota.weekly?.remaining, 0)
  assert.equal(quota.fiveHour?.resetAt, '2030-01-01T00:00:00.000Z')
  assert.equal(quota.weekly?.resetAt, quota.fiveHour?.resetAt)
  assert.equal(parse({ current_weekly_status: 0 }).weekly, null)
  for (const value of [null, '', true, 'NaN', Infinity])
    assert.equal(parse({ current_interval_remaining_percent: value }).fiveHour, null)
  assert.equal(parse({ current_interval_remaining_percent: -1 }).fiveHour?.remaining, 0)
  assert.equal(parse({ current_interval_remaining_percent: 101 }).fiveHour?.remaining, 100)
  assert.equal(
    parse({ end_time: '2030-01-01T00:00:00Z' }).fiveHour?.resetAt,
    quota.fiveHour?.resetAt
  )
  assert.equal(parse({ end_time: 0 }).fiveHour?.resetAt, null)
  assert.equal(parseMiniMaxQuota({ model_remains: [{ model_name: 'video' }] }), null)
})

test('MiniMax capabilities select regional endpoints and use Bearer subscription keys', async () => {
  for (const region of ['mainland-cn', 'global'] as const) {
    const host = region === 'global' ? 'api.minimax.io' : 'api.minimaxi.com'
    const calls: string[] = []
    const reader = new KimiCapabilities(async (url, init) => {
      calls.push(String(url))
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer subscription-key')
      return Response.json(
        String(url).endsWith('/models')
          ? { data: [{ id: 'MiniMax-M3' }] }
          : {
              base_resp: { status_code: 0 },
              model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }]
            }
      )
    })
    const cap = await reader.get(region, 'subscription-key', false, 'minimax')
    assert.deepEqual(calls, [
      `https://${host}/v1/models`,
      `https://${host}/v1/api/openplatform/coding_plan/remains`
    ])
    assert.deepEqual(cap.models, ['MiniMax-M3'])
    assert.equal(cap.quota?.fiveHour?.remaining, 50)
    assert.equal(cap.maxConcurrency, null)
    assert.equal(
      upstreamUrl(region, 'minimax', '/v1/messages'),
      `https://${host}/anthropic/v1/messages`
    )
  }
})

test('MiniMax rejects HTTP and business authentication failures without exposing upstream text', async () => {
  for (const response of [
    new Response('', { status: 401 }),
    new Response('', { status: 403 }),
    Response.json({ base_resp: { status_code: 1004, status_msg: 'secret-must-not-leak' } })
  ]) {
    const reader = new KimiCapabilities(async (url) =>
      String(url).endsWith('/models') ? Response.json({ data: [{ id: 'MiniMax-M3' }] }) : response
    )
    await assert.rejects(reader.get('global', 'key', false, 'minimax'), (error: Error) => {
      assert.match(error.message, /API Key 无效|套餐查询失败/)
      assert.ok(!error.message.includes('secret-must-not-leak'))
      return true
    })
  }
})

test('MiniMax SDK thinking is normalized without losing effort or history', () => {
  const body = {
    thinking: { type: 'enabled', budget_tokens: 8192 },
    output_config: { effort: 'high' },
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'history', signature: 'sig' }] }
    ]
  }
  for (const model of ['MiniMax-M3', 'MiniMax-M2.7', 'minimax-m3-highspeed']) {
    const result = normalizeMiniMaxRequest(body, model, '/v1/messages')
    assert.equal(result.thinking.type, 'adaptive')
    assert.equal(result.thinking.budget_tokens, 8192)
    assert.deepEqual(result.output_config, body.output_config)
    assert.strictEqual(result.messages, body.messages)
    assert.equal(body.thinking.type, 'enabled')
  }
  for (const model of ['kimi-k3', 'claude-opus-4-6', 'deepseek-v4', 'glm-5'])
    assert.strictEqual(normalizeMiniMaxRequest(body, model, '/v1/messages'), body)
  assert.strictEqual(normalizeMiniMaxRequest(body, 'MiniMax-M3', '/v1/responses'), body)
  for (const thinking of [{ type: 'adaptive' }, { type: 'disabled' }, undefined]) {
    const original = { thinking, messages: [] }
    assert.strictEqual(normalizeMiniMaxRequest(original, 'MiniMax-M3', '/v1/messages'), original)
  }
})

test('MiniMax preserves reasoning levels through Responses/Chat to Messages conversion', () => {
  for (const source of ['responses', 'chat-completions'] as const) {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const input =
        source === 'responses'
          ? { model: 'MiniMax-M3', input: 'hi', reasoning: { effort } }
          : {
              model: 'MiniMax-M3',
              messages: [{ role: 'user', content: 'hi' }],
              reasoning_effort: effort
            }
      const converted = convertRequest(input, source, 'messages').body
      const result = normalizeMiniMaxRequest(converted, 'MiniMax-M3', '/v1/messages')
      assert.equal(result.thinking.type, effort === 'none' ? 'disabled' : 'adaptive')
      assert.equal(result.output_config.effort, effort === 'xhigh' ? 'max' : effort)
    }
  }
})

test('MiniMax Chat requests separate reasoning by default and respect explicit overrides', () => {
  const input = { model: 'MiniMax-M3', thinking: { type: 'enabled' } }
  const normalized = normalizeMiniMaxRequest<Record<string, any>>(
    input,
    input.model,
    '/v1/chat/completions'
  )
  assert.equal(normalized.reasoning_split, true)
  assert.equal(normalized.thinking.type, 'adaptive')
  assert.equal(
    normalizeMiniMaxRequest(
      { ...input, reasoning_split: false },
      input.model,
      '/v1/chat/completions'
    ).reasoning_split,
    false
  )
  assert.equal(
    Object.hasOwn(normalizeMiniMaxRequest(input, input.model, '/v1/messages'), 'reasoning_split'),
    false
  )
})
