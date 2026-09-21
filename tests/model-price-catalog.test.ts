import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ModelPriceCatalog,
  parseCatalogEntries,
  parseModelPriceCatalog,
  MODEL_PRICE_API,
  PRICE_CACHE_TTL
} from '../src/main/services/model-price-catalog'
import {
  matchedModelPrice,
  searchCatalogPrices,
  resolveModelPrice
} from '../src/shared/model-pricing'
import { registryModels } from '../src/main/services/model-registry'
import type { ModelPrice } from '../src/shared/contracts'

const payload = {
  'kimi-for-coding': { models: { k3: { cost: { input: 0, output: 0, cache_read: 0 } } } },
  deepseek: { models: { shared: { cost: { input: 1, output: 2, cache_read: 0.1 } } } },
  'opencode-go': {
    models: { shared: { cost: { input: 3, output: 4, cache_write: 5, tiers: [{ input: 6 }] } } }
  },
  opencode: { models: { 'reseller-only': { cost: { input: 99, output: 99 } } } }
}

test('catalog uses exact provider/model mapping, USD per million, zero, unknown fields and tier metadata', () => {
  const prices = parseModelPriceCatalog(payload)
  assert.equal(prices.length, 3)
  assert.deepEqual(prices[0], {
    provider: 'kimi',
    model: 'k3',
    currency: 'USD',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: null,
    tiered: false
  })
  assert.equal(prices[1].input, 1)
  assert.equal(prices[2].input, 3)
  assert.equal(prices[2].tiered, true)
  assert.ok(!prices.some((p) => p.model === 'reseller-only'))
  const partial = parseModelPriceCatalog({
    deepseek: {
      models: { m: { cost: { input: '5', output: 2, cache_read: -1, cache_write: Infinity } } }
    }
  })[0]
  assert.equal(partial.input, null)
  assert.equal(partial.cacheRead, null)
  assert.equal(partial.cacheWrite, null)
  for (const invalid of [null, [], {}, { deepseek: { models: {} } }])
    assert.throws(() => parseModelPriceCatalog(invalid))
})

test('field fallback keeps explicit zero and original currencies; clearing overrides follows the latest API price', () => {
  const fallback = parseModelPriceCatalog(payload)[1]
  const manual: ModelPrice = {
    ...fallback,
    currency: 'CNY',
    input: 0,
    output: null,
    cacheRead: null
  }
  assert.deepEqual(resolveModelPrice(manual, fallback, 'input'), {
    amount: 0,
    currency: 'CNY',
    source: 'manual'
  })
  assert.deepEqual(resolveModelPrice(manual, fallback, 'output'), {
    amount: 2,
    currency: 'USD',
    source: 'api'
  })
  assert.deepEqual(resolveModelPrice(manual, fallback, 'cacheWrite'), {
    amount: 0,
    currency: 'CNY',
    source: 'zero'
  })
  assert.deepEqual(resolveModelPrice(undefined, undefined, 'input'), {
    amount: 0,
    currency: 'USD',
    source: 'zero'
  })
  assert.equal(
    resolveModelPrice({ ...manual, input: null }, { ...fallback, input: 7 }, 'input')?.amount,
    7
  )
})

test('batch fetch deduplicates, caches for 24 hours, persists across restart and retains stale data on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'price-catalog-test-'))
  const file = join(dir, 'prices.json')
  let now = 1000000000000
  let calls = 0
  let fail = false
  const request: typeof fetch = async (url, init) => {
    calls++
    assert.equal(url, MODEL_PRICE_API)
    assert.equal(new Headers(init?.headers).has('authorization'), false)
    assert.ok(init?.signal)
    if (fail) return new Response('unavailable', { status: 503 })
    return Response.json(payload)
  }
  try {
    const catalog = new ModelPriceCatalog(file, request, () => now)
    await catalog.load()
    await Promise.all([catalog.refresh(), catalog.refresh(true), catalog.refresh()])
    assert.equal(calls, 1)
    const original = catalog.snapshot()
    await catalog.refresh()
    assert.equal(calls, 1)
    const restored = new ModelPriceCatalog(file, request, () => now)
    await restored.load()
    assert.deepEqual(restored.snapshot(), original)
    await restored.refresh()
    assert.equal(calls, 1)
    now += PRICE_CACHE_TTL + 1
    fail = true
    await restored.refresh()
    assert.equal(calls, 2)
    assert.deepEqual(restored.snapshot().prices, original.prices)
    assert.equal(restored.snapshot().updatedAt, original.updatedAt)
    assert.match(restored.snapshot().error, /缓存/)
    await restored.refresh()
    assert.equal(calls, 2)
    await restored.refresh(true)
    assert.equal(calls, 3)
    fail = false
    await restored.refresh(true)
    assert.equal(calls, 4)
    assert.equal(restored.snapshot().error, '')
    assert.equal(restored.snapshot().updatedAt, now)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).updatedAt, now)
    await writeFile(file, 'corrupt')
    const corrupt = new ModelPriceCatalog(file, request, () => now)
    await corrupt.load()
    assert.deepEqual(corrupt.snapshot().prices, [])
    await corrupt.refresh()
    assert.equal(corrupt.snapshot().prices.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid, interrupted, oversized responses and unavailable network preserve the last successful cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'price-catalog-invalid-'))
  const file = join(dir, 'prices.json')
  let response: () => Response = () => Response.json(payload)
  const catalog = new ModelPriceCatalog(file, async () => response())
  try {
    await catalog.refresh()
    const previous = catalog.snapshot()
    for (const invalid of [
      () => Response.json({}),
      () => new Response('not json'),
      () => {
        throw new Error('network offline')
      },
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('interrupted'))
            }
          })
        ),
      () => new Response(new Uint8Array(20 * 1024 * 1024 + 1))
    ]) {
      response = invalid
      await catalog.refresh(true)
      assert.deepEqual(catalog.snapshot().prices, previous.prices)
      assert.equal(catalog.snapshot().updatedAt, previous.updatedAt)
      assert.match(catalog.snapshot().error, /更新失败/)
    }
    const disk = new ModelPriceCatalog(file)
    await disk.load()
    assert.deepEqual(disk.snapshot().prices, previous.prices)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('catalog search ignores punctuation and preserves provider identity; saved aliases select defaults', () => {
  const entries = parseCatalogEntries({
    moonshotai: {
      name: 'Moonshot AI',
      models: { 'kimi-k3': { name: 'Kimi K3', cost: { input: 3, output: 15 } } }
    },
    reseller: { models: { 'kimi-k3': { cost: { input: 9, output: 20 } } } }
  })
  assert.equal(entries.length, 2)
  assert.equal(searchCatalogPrices(entries, 'KIMI_k3').length, 2)
  assert.equal(searchCatalogPrices(entries, 'kimi k3 moonshot')[0].provider, 'moonshotai')
  assert.equal(searchCatalogPrices(entries, 'unmatched').length, 0)
  const catalog = { entries, prices: [], updatedAt: 1, error: '' }
  const manual: ModelPrice = {
    provider: 'kimi',
    model: 'k3',
    currency: 'CNY',
    input: null,
    output: 8,
    cacheRead: null,
    cacheWrite: null,
    catalogMatch: { provider: 'moonshotai', model: 'kimi-k3' }
  }
  const fallback = matchedModelPrice(manual, catalog)
  assert.equal(fallback?.input, 3)
  assert.equal(resolveModelPrice(manual, fallback, 'output')?.amount, 8)
  assert.equal(
    matchedModelPrice(
      { ...manual, catalogMatch: { provider: 'missing', model: 'kimi-k3' } },
      catalog
    ),
    undefined
  )
})

test('registry metadata preserves names and limits without prices, respects mappings and shared limits', () => {
  const entries = parseCatalogEntries({
    'kimi-for-coding': {
      models: {
        k3: { name: 'Kimi K3', limit: { context: 1048576, output: 131072 } },
        'k3-256k': { name: 'Kimi K3-256K', limit: { context: 262144, output: 131072 } },
        invalid: { name: 'Invalid', limit: { context: -1, output: '123' } }
      }
    },
    'opencode-go': {
      models: { k3: { name: 'Kimi K3', limit: { context: 262144, output: 32768 } } }
    },
    unrelated: { models: { unknown: { name: 'Wrong provider', limit: { context: 999999 } } } }
  })
  assert.equal(entries.length, 5)
  assert.equal(entries.find((entry) => entry.model === 'invalid')?.limit, undefined)
  const accounts = [
    { provider: 'kimi' as const, models: ['k3', 'k3-256k', 'alias', 'unknown', 'kimi-for-coding'] }
  ]
  const prices: ModelPrice[] = [
    {
      provider: 'kimi',
      model: 'alias',
      currency: 'USD',
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      catalogMatch: { provider: 'kimi-for-coding', model: 'k3' }
    }
  ]
  const models = registryModels(accounts, entries, prices)
  assert.deepEqual(models.k3, {
    id: 'k3',
    name: 'Kimi K3',
    limit: { context: 1048576, output: 131072 }
  })
  assert.equal(models['k3-256k'].limit?.context, 262144)
  assert.equal(models.alias.name, 'Kimi K3')
  assert.equal(models.alias.id, 'alias')
  assert.equal(models.alias.limit?.context, 1048576)
  assert.deepEqual(models.unknown, {
    id: 'unknown',
    name: 'Wrong provider',
    limit: { context: 999999 }
  })
  assert.equal(models['kimi-for-coding'].name, 'Kimi for Coding')
  const shared = registryModels(
    [...accounts, { provider: 'opencode-go', models: ['k3'] }],
    entries,
    prices
  )
  assert.deepEqual(shared.k3.limit, { context: 262144, output: 32768 })
})

test('metadata survives restart and upgrades a fresh v2 price cache immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-metadata-'))
  const file = join(dir, 'prices.json')
  const now = 1000000000000
  const data = {
    'kimi-for-coding': {
      models: {
        k3: { name: 'Kimi K3', limit: { context: 1048576, output: 131072 }, cost: { input: 1 } }
      }
    }
  }
  let calls = 0
  const request: typeof fetch = async () => {
    calls++
    return Response.json(data)
  }
  try {
    await writeFile(
      file,
      JSON.stringify({ version: 2, updatedAt: now, entries: parseCatalogEntries(payload) })
    )
    const catalog = new ModelPriceCatalog(file, request, () => now)
    await catalog.load()
    assert.equal(catalog.snapshot().prices.length, 3)
    await catalog.refresh()
    assert.equal(calls, 1)
    assert.deepEqual(catalog.snapshot().entries[0].limit, { context: 1048576, output: 131072 })
    const restored = new ModelPriceCatalog(file, request, () => now)
    await restored.load()
    assert.deepEqual(restored.snapshot(), catalog.snapshot())
    await restored.refresh()
    assert.equal(calls, 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
