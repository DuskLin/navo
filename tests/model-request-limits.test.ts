import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeModelRequestLimits as normalize } from '../src/main/services/model-request-limits'
import { createModelMetadataResolver } from '../src/shared/model-metadata'
import { parseCatalogEntries } from '../src/main/services/model-price-catalog'

test('caps all three protocols and both Chat budget fields without mutating retries', () => {
  for (const [route, key] of [
    ['/v1/messages', 'max_tokens'],
    ['/v1/responses', 'max_output_tokens'],
    ['/v1/chat/completions', 'max_tokens'],
    ['/v1/chat/completions', 'max_completion_tokens']
  ]) {
    const body = { [key]: 978090, messages: [{ role: 'user', content: 'hello' }] }
    const result = normalize(body, route, { context: 1048576, output: 393216 })
    assert.equal(result[key], 393216)
    assert.equal(body[key], 978090)
    assert.equal(result.messages, body.messages)
    const small = { [key]: 100 }
    assert.equal(normalize(small, route, { output: 393216 }), small)
  }
  assert.deepEqual(
    normalize({ max_tokens: 999, max_completion_tokens: 888 }, '/v1/chat/completions', {
      output: 500
    }),
    { max_tokens: 500, max_completion_tokens: 500 }
  )
})

test('fills known output allowances, bounds them by context, and leaves unknown limits alone', () => {
  for (const [route, key] of [
    ['/v1/messages', 'max_tokens'],
    ['/v1/responses', 'max_output_tokens'],
    ['/v1/chat/completions', 'max_tokens']
  ]) {
    assert.deepEqual(
      normalize({}, route, { output: 200, context: 100 }),
      route === '/v1/messages' ? { [key]: 100 } : {}
    )
    const body = { [key]: 978090 }
    assert.equal(normalize(body, route, undefined), body)
    for (const value of [0, -1, 1.5, '999', NaN, Infinity]) {
      const invalid = { [key]: value }
      assert.equal(normalize(invalid, route, { output: 100 }), invalid)
    }
    assert.deepEqual(normalize({}, route, { context: 100 }), {})
    assert.deepEqual(normalize(body, route, { context: 100 }), { [key]: 100 })
  }
  const count = { max_tokens: 999 }
  assert.equal(normalize(count, '/v1/messages/count_tokens', { output: 100 }), count)
})

test('clamping Messages keeps explicit thinking budgets below the new output limit', () => {
  const body = { max_tokens: 978090, thinking: { type: 'enabled', budget_tokens: 500000 } }
  const result = normalize(body, '/v1/messages', { output: 393216 })
  assert.deepEqual(result.thinking, { type: 'enabled', budget_tokens: 393215 })
  assert.equal(body.thinking.budget_tokens, 500000)
  assert.throws(() => normalize(body, '/v1/messages', { output: 1024 }), /thinking.budget_tokens/)
  const adaptive = { max_tokens: 9999, thinking: { type: 'adaptive' } }
  assert.equal(normalize(adaptive, '/v1/messages', { output: 4000 }).thinking, adaptive.thinking)
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
