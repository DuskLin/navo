import assert from 'node:assert/strict'
import { test } from 'node:test'
import { convertRequest } from '../src/main/services/protocol-request'
import { normalizeModelRequestLimits as normalize } from '../src/main/services/model-request-limits'
import { createModelMetadataResolver } from '../src/shared/model-metadata'
import { parseCatalogEntries } from '../src/main/services/model-price-catalog'

test('disabled accounts preserve every client budget and do not fill omitted values', () => {
  for (const [route, key] of [
    ['/v1/messages', 'max_tokens'],
    ['/v1/responses', 'max_output_tokens'],
    ['/v1/chat/completions', 'max_tokens'],
    ['/v1/chat/completions', 'max_completion_tokens']
  ]) {
    for (const value of [978090, 100, 0, -1, 1.5, '999', null]) {
      const body = { [key]: value, thinking: { type: 'enabled', budget_tokens: 500000 } }
      assert.equal(normalize(body, route, { context: 1000, output: 500 }), body)
    }
  }
  const both = { max_tokens: 999, max_completion_tokens: 888 }
  assert.equal(normalize(both, '/v1/chat/completions', { output: 500 }), both)
})

test('enabled accounts prefer configured output and preserve input when configuration is missing', () => {
  for (const [route, key] of [
    ['/v1/messages', 'max_tokens'],
    ['/v1/responses', 'max_output_tokens'],
    ['/v1/chat/completions', 'max_tokens']
  ]) {
    const body = { thinking: { type: 'enabled', budget_tokens: 500000 } }
    const result = normalize(body, route, { output: 200, context: 100 }, true)
    assert.equal(result[key], 200)
    for (const value of [50, 978090, null, 0]) {
      const supplied = { [key]: value }
      assert.equal(normalize(supplied, route, { output: 200 }, true)[key], 200)
      assert.equal(normalize(supplied, route, undefined, true), supplied)
    }
    assert.deepEqual(normalize({}, route, { output: 200 }), {})
    assert.equal(result.thinking, body.thinking)
    assert.equal(Object.hasOwn(body, key), false)
    assert.equal(normalize(body, route, undefined, true), body)
    assert.equal(normalize(body, route, { context: 100 }, true), body)
    for (const output of [0, -1, NaN, Infinity])
      assert.equal(normalize(body, route, { output }, true), body)
  }
  const count = { messages: [] }
  assert.equal(normalize(count, '/v1/messages/count_tokens', { output: 100 }, true), count)
})

test('cross-protocol conversion prefers explicit gateway overrides, then client budgets, then omission', () => {
  for (const target of ['messages', 'chat-completions'] as const) {
    const body = { model: 'test', input: 'hi', reasoning: { effort: 'high' } }
    assert.equal(
      convertRequest({ ...body, max_output_tokens: 978090 }, 'responses', target, 2000).body
        .max_tokens,
      2000
    )
    const fallback = convertRequest(body, 'responses', target, 2000).body
    assert.equal(fallback.max_tokens, 2000)
    if (target === 'messages') assert.ok(fallback.thinking.budget_tokens < fallback.max_tokens)
    assert.equal(convertRequest(body, 'responses', target).body.max_tokens, undefined)
    assert.equal(
      convertRequest({ ...body, max_output_tokens: null }, 'responses', target, 2000).body
        .max_tokens,
      2000
    )
    assert.equal(
      convertRequest({ ...body, max_output_tokens: 978090 }, 'responses', target).body.max_tokens,
      978090
    )
  }
})

test('Chat override preserves field choice and aligns competing fields', () => {
  assert.deepEqual(
    normalize({ max_completion_tokens: 50 }, '/v1/chat/completions', { output: 100 }, true),
    { max_completion_tokens: 100 }
  )
  assert.deepEqual(
    normalize(
      { max_completion_tokens: 50, max_tokens: 500 },
      '/v1/chat/completions',
      { output: 100 },
      true
    ),
    { max_completion_tokens: 100, max_tokens: 100 }
  )
})

test('metadata prefers provider limits over priced alternatives and honors explicit associations', () => {
  const entries = parseCatalogEntries({
    deepseek: { models: { m: { limit: { output: 100 } } } },
    other: { models: { m: { cost: { input: 1 }, limit: { output: 200 } } } }
  })
  assert.equal(createModelMetadataResolver(entries, [])('m', 'deepseek')?.limit?.output, 100)
  assert.equal(createModelMetadataResolver(entries, [])('unknown', 'deepseek'), undefined)
  const price = {
    provider: 'deepseek' as const,
    model: 'm',
    currency: 'USD' as const,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    catalogMatch: { provider: 'other', model: 'm' }
  }
  assert.equal(createModelMetadataResolver(entries, [price])('m', 'deepseek')?.limit?.output, 200)
  assert.equal(
    createModelMetadataResolver(entries, [
      { ...price, catalogMatch: { provider: 'missing', model: 'm' } }
    ])('m', 'deepseek'),
    undefined
  )
})

test('manual limits override each catalog field and work without any catalog match', () => {
  const entries = parseCatalogEntries({
    deepseek: { models: { m: { limit: { context: 1000, output: 200 } } } }
  })
  const price = {
    provider: 'deepseek' as const,
    model: 'm',
    currency: 'USD' as const,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    limits: { output: 300 }
  }
  assert.deepEqual(createModelMetadataResolver(entries, [price])('m', 'deepseek')?.limit, {
    context: 1000,
    output: 300
  })
  assert.deepEqual(createModelMetadataResolver([], [price])('m', 'deepseek')?.limit, {
    output: 300
  })
  assert.deepEqual(
    createModelMetadataResolver(entries, [{ ...price, limits: undefined }])('m', 'deepseek')?.limit,
    { context: 1000, output: 200 }
  )
})
