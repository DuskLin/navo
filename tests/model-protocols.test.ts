import { Gateway } from '../src/main/services/gateway'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GatewayStore,
  validateModelProtocols,
  validateManualModels
} from '../src/main/services/gateway-store'
import { modelUpstreamRoute, supportedModelProtocols } from '../src/shared/model-protocols'

test('model protocol defaults, direct preference, deterministic conversion and validation', () => {
  assert.deepEqual(supportedModelProtocols({ provider: 'opencode-go' }, 'minimax-test'), [
    'messages'
  ])
  assert.equal(supportedModelProtocols({ provider: 'kimi' }, 'kimi-for-coding').length, 3)
  const modelProtocols = validateModelProtocols({ 'gpt-test': ['messages', 'responses'] })
  const account = { provider: 'opencode-go' as const, modelProtocols }
  assert.equal(modelUpstreamRoute(account, 'gpt-test', '/v1/messages'), '/v1/messages')
  assert.equal(modelUpstreamRoute(account, 'gpt-test', '/v1/chat/completions'), '/v1/responses')
  assert.equal(
    modelUpstreamRoute(account, 'gpt-test', '/v1/messages/count_tokens'),
    '/v1/messages/count_tokens'
  )
  assert.equal(
    modelUpstreamRoute({ modelProtocols: { model: ['responses'] } }, 'model', '/v1/messages'),
    '/v1/responses'
  )
  for (const value of [null, [], { m: [] }, { m: ['invalid'] }, { m: ['messages', 'messages'] }])
    assert.throws(() => validateModelProtocols(value))
  assert.deepEqual(supportedModelProtocols({ modelProtocols: {} }, 'constructor'), [
    'messages',
    'responses',
    'chat-completions'
  ])
})

test('manual model protocols persist, survive metadata updates, and can reset to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-protocol-test-'))
  const codec = { encrypt: (v: string) => v, decrypt: (v: string) => v }
  const file = join(dir, 'store.json')
  const store = new GatewayStore(file, codec)
  try {
    const input = {
      name: 'go',
      kind: 'api-key' as const,
      provider: 'opencode-go' as const,
      region: 'global' as const,
      enabled: true,
      memberships: [{ groupId: 'default', priority: 0, weight: 1 }],
      secret: 'test-key',
      modelProtocols: validateModelProtocols({ 'minimax-test': ['responses'] })
    }
    const capabilities = {
      models: ['minimax-test'],
      maxConcurrency: null,
      checkedAt: Date.now(),
      warning: '',
      quota: null
    }
    const id = await store.saveAccount(input, capabilities)
    const { modelProtocols: _overrides, secret: _secret, ...update } = input
    await store.saveAccount(
      { ...update, id },
      { ...capabilities, models: ['minimax-test', 'new-model'] }
    )
    const restored = new GatewayStore(file, codec)
    await restored.load()
    assert.deepEqual(restored.get().accounts[0].modelProtocols, input.modelProtocols)
    assert.deepEqual(supportedModelProtocols(restored.get().accounts[0], 'new-model'), [
      'chat-completions'
    ])
    await restored.saveAccount({ ...update, id, modelProtocols: {} })
    assert.deepEqual(supportedModelProtocols(restored.get().accounts[0], 'minimax-test'), [
      'messages'
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('手动模型校验去重，拒绝无效 ID', () => {
  assert.deepEqual(validateManualModels([' gpt-6-astra ', 'gpt-6-astra', 'vendor/model']), [
    'gpt-6-astra',
    'vendor/model'
  ])
  for (const invalid of [
    null,
    {},
    [''],
    ['a b'],
    ['a\nb'],
    ['a\x00b'],
    ['x'.repeat(201)],
    Array(2001).fill('m')
  ])
    assert.throws(() => validateManualModels(invalid))
})

test('所有 API Key 供应商保留手动模型，支持刷新、去重、删除恢复及重启', async () => {
  for (const provider of ['kimi', 'deepseek', 'opencode-go'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'manual-model-test-'))
    const codec = { encrypt: (v: string) => v, decrypt: (v: string) => v }
    const file = join(dir, 'store.json')
    const store = new GatewayStore(file, codec)
    const request: typeof fetch = async () =>
      Response.json({ data: [{ id: 'upstream-model' }, { id: 'shared-model' }] })
    const gateway = new Gateway(store, request, request, request)
    try {
      const id = await store.saveAccount(
        {
          name: provider,
          provider,
          kind: 'api-key',
          region: 'global',
          enabled: true,
          secret: 'test-secret',
          memberships: [{ groupId: 'default', priority: 0, weight: 1 }],
          manualModels: ['gpt-6-astra', 'shared-model']
        },
        {
          models: ['upstream-model'],
          maxConcurrency: null,
          checkedAt: Date.now(),
          warning: '',
          quota: null
        }
      )
      await gateway.refreshAccount(id)
      assert.deepEqual(store.get().accounts[0].models, [
        'upstream-model',
        'shared-model',
        'gpt-6-astra'
      ])
      assert.ok(!store.get().accounts[0].capabilities?.models.includes('gpt-6-astra'))
      const { manualModels: _manual, ...update } = gateway.snapshot().accounts[0]
      await gateway.saveAccount({ ...update, excludedModels: ['gpt-6-astra'] })
      await gateway.refreshAccount(id)
      assert.ok(!store.get().accounts[0].models.includes('gpt-6-astra'))
      assert.deepEqual(store.get().accounts[0].manualModels, ['gpt-6-astra', 'shared-model'])
      await gateway.saveAccount({ ...gateway.snapshot().accounts[0], excludedModels: [] })
      const restored = new GatewayStore(file, codec)
      await restored.load()
      assert.deepEqual(restored.get().accounts[0].models, [
        'upstream-model',
        'shared-model',
        'gpt-6-astra'
      ])
    } finally {
      await gateway.shutdown()
      gateway.history.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
})
