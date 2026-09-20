import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayStore, validateModelPrice } from '../src/main/services/gateway-store'
import { PROVIDERS, type ModelPrice, type Provider } from '../src/shared/contracts'

const price: ModelPrice = {
  provider: 'kimi',
  model: 'shared-model',
  currency: 'CNY',
  input: 1.25,
  output: 8,
  cacheRead: 0,
  cacheWrite: null
}

test('model prices reject invalid amounts, identities and currencies while preserving zero and unset', () => {
  assert.deepEqual(validateModelPrice(price), price)
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    for (const value of [-1, NaN, Infinity, '1', undefined, 1_000_000_001]) {
      assert.throws(() => validateModelPrice({ ...price, [key]: value }))
    }
  }
  for (const patch of [
    { currency: 'EUR' },
    { provider: undefined },
    { provider: 'unknown' },
    { model: '' }
  ])
    assert.throws(() => validateModelPrice({ ...price, ...patch }))
})

test('prices persist independently by provider, survive account refresh, and migrate old stores', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-price-test-'))
  const file = join(dir, 'gateway.json')
  const codec = { encrypt: (v: string) => v, decrypt: (v: string) => v }
  const store = new GatewayStore(file, codec)
  try {
    const ids: string[] = []
    for (const provider of ['kimi', 'deepseek'] as Provider[])
      ids.push(
        await store.saveAccount(
          {
            name: provider,
            ...(provider === 'custom' ? { baseUrl: 'https://custom.example/v1' } : {}),
            provider,
            kind: 'api-key',
            region: 'mainland-cn',
            enabled: false,
            memberships: [{ groupId: 'default', priority: 0, weight: 1 }],
            secret: 'test-key'
          },
          { models: ['shared-model'], maxConcurrency: null, checkedAt: Date.now(), warning: '' }
        )
      )
    await Promise.all([
      store.saveModelPrice(price),
      store.saveModelPrice({ ...price, provider: 'deepseek', currency: 'USD', input: 0.1 })
    ])
    await assert.rejects(store.saveModelPrice({ ...price, model: 'unknown' }), /支持列表/)
    await store.saveModelPrice({
      ...price,
      output: 10,
      catalogMatch: { provider: 'moonshotai', model: 'kimi-k3' }
    })
    const account = store.get().accounts[0]
    await store.saveAccount(account, {
      ...account.capabilities!,
      models: ['shared-model', 'new-model']
    })
    await store.saveQuotaCardOrder([...ids].reverse())
    await assert.rejects(store.saveQuotaCardOrder([ids[0], ids[0]]), /重复/)
    const restored = new GatewayStore(file, codec)
    await restored.load()
    assert.deepEqual(restored.get().quotaCardOrder, [...ids].reverse())
    assert.equal(restored.get().modelPrices.length, 2)
    assert.deepEqual(
      restored.get().modelPrices.find((p) => p.provider === 'kimi'),
      { ...price, output: 10, catalogMatch: { provider: 'moonshotai', model: 'kimi-k3' } }
    )
    assert.equal(restored.get().modelPrices.find((p) => p.provider === 'deepseek')?.input, 0.1)
    await restored.deleteAccount(ids[0])
    await assert.rejects(restored.saveModelPrice(price), /支持列表/)
    assert.equal(restored.get().modelPrices.length, 2)
    const envelope = JSON.parse(await readFile(file, 'utf8'))
    const legacy = JSON.parse(envelope.encrypted)
    delete legacy.modelPrices
    envelope.encrypted = JSON.stringify(legacy)
    await writeFile(file, JSON.stringify(envelope))
    const migrated = new GatewayStore(file, codec)
    await migrated.load()
    assert.deepEqual(migrated.get().modelPrices, [])
    assert.equal(migrated.get().accounts.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('所有供应商的单价均可保存和重启恢复，包含 Codex OAuth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-prices-'))
  const file = join(dir, 'gateway.json')
  const codec = { encrypt: (v: string) => v, decrypt: (v: string) => v }
  const store = new GatewayStore(file, codec)
  try {
    for (const provider of PROVIDERS) {
      const id = await store.saveAccount(
        {
          provider: provider === 'codex' ? 'kimi' : provider,
          name: provider,
          ...(provider === 'custom' ? { baseUrl: 'https://custom.example/v1' } : {}),
          kind: 'api-key',
          region: 'global',
          enabled: true,
          secret: 'test-key',
          memberships: [{ groupId: 'default', priority: 0, weight: 1 }]
        },
        { models: [price.model], maxConcurrency: null, checkedAt: Date.now(), warning: '' }
      )
      if (provider === 'codex')
        await store.mutate((data) => {
          const account = data.accounts.find((a) => a.id === id)!
          account.provider = 'codex'
          account.kind = 'oauth'
          account.credential.accountId = 'workspace-test'
        })
      await store.saveModelPrice({ ...price, provider })
    }
    const restored = new GatewayStore(file, codec)
    await restored.load()
    assert.deepEqual(
      restored
        .get()
        .modelPrices.map((p) => p.provider)
        .sort(),
      [...PROVIDERS].sort()
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
