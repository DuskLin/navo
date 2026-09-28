import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeCommandCodeRequest } from '../src/main/services/commandcode-request'

test('Command Code Responses omits only reasoning.summary without mutating input or history', () => {
  const body = {
    model: 'deepseek/deepseek-v4.1-flash',
    reasoning: { effort: 'xhigh', summary: 'auto', other: true },
    input: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'history' }] }]
  }
  const snapshot = structuredClone(body)
  const result = normalizeCommandCodeRequest(body, 'commandcode-goat', '/v1/responses')
  assert.deepEqual(result, { ...body, reasoning: { effort: 'xhigh', other: true } })
  assert.deepEqual(body, snapshot)
  for (const provider of ['custom', 'codex', 'kimi', 'opencode-go'] as const)
    assert.strictEqual(normalizeCommandCodeRequest(body, provider, '/v1/responses'), body)
  for (const route of ['/v1/chat/completions', '/v1/messages'])
    assert.strictEqual(normalizeCommandCodeRequest(body, 'commandcode-goat', route), body)
  const absent = { model: 'test', reasoning: { effort: 'high' } }
  assert.strictEqual(
    normalizeCommandCodeRequest(absent, 'commandcode-goat', '/v1/responses'),
    absent
  )
})
