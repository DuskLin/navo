import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AccountView, CatalogPrice, GatewaySnapshot } from '../src/shared/contracts'
import { kimiModelConfig } from '../src/main/services/kimi-model-config'

function fixture(): Pick<GatewaySnapshot, 'accounts' | 'modelPriceCatalog' | 'modelPrices'> {
  const account: AccountView = {
    id: 'a',
    name: 'command',
    provider: 'commandcode-goat',
    baseUrl: 'https://example.com',
    kind: 'api-key',
    region: 'global',
    enabled: true,
    hasCredential: true,
    memberships: [],
    maxConcurrency: 20,
    models: ['MiniMaxAI/MiniMax-M3'],
    modelMappings: { 'MiniMax-M3': 'MiniMaxAI/MiniMax-M3' },
    capabilities: {
      models: ['MiniMaxAI/MiniMax-M3'],
      maxConcurrency: 20,
      checkedAt: 1,
      warning: ''
    },
    runtime: {
      active: 0,
      requests: 0,
      successes: 0,
      failures: 0,
      cooldownUntil: 0,
      authFailed: false,
      lastError: '',
      lastUsed: 0,
      latencyMs: 0
    }
  }
  const entry: CatalogPrice = {
    provider: 'commandcode',
    providerName: 'Command Code',
    model: 'MiniMaxAI/MiniMax-M3',
    name: 'MiniMax M3',
    currency: 'USD',
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    tiered: false,
    limit: { context: 1000000 },
    capabilities: {
      tool_call: true,
      reasoning: true,
      modalities: { input: ['text', 'image'] },
      support_efforts: ['low', 'medium', 'high', 'max']
    }
  }
  return {
    accounts: [account],
    modelPriceCatalog: { entries: [entry], prices: [], updatedAt: 1, error: '' },
    modelPrices: []
  }
}

test('Kimi config uses mapped metadata while preserving the requested model ID', () => {
  assert.equal(
    kimiModelConfig('MiniMax-M3', fixture()),
    `[models."Navo/MiniMax-M3"]
provider = "Navo"
model = "MiniMax-M3"
max_context_size = 1000000
capabilities = [ "tool_use", "thinking", "image_in" ]
display_name = "MiniMax M3"
support_efforts = [ "low", "medium", "high", "max" ]
`
  )
})

test('shared models use minimum context and common capabilities and efforts', () => {
  const snapshot = fixture()
  snapshot.accounts.push({ ...snapshot.accounts[0], id: 'b', provider: 'deepseek' })
  snapshot.modelPriceCatalog.entries.push({
    ...snapshot.modelPriceCatalog.entries[0],
    provider: 'deepseek',
    limit: { context: 128000 },
    capabilities: {
      tool_call: true,
      reasoning: true,
      modalities: { input: ['text'] },
      support_efforts: ['low', 'high']
    }
  })
  const text = kimiModelConfig('MiniMax-M3', snapshot)
  assert.match(text, /max_context_size = 128000/)
  assert.match(text, /capabilities = \[ "tool_use", "thinking" \]/)
  assert.match(text, /support_efforts = \[ "low", "high" \]/)
})

test('missing metadata is not invented, and unavailable accounts do not affect exports', () => {
  const snapshot = fixture()
  snapshot.accounts.push({ ...snapshot.accounts[0], id: 'b', provider: 'custom', enabled: false })
  assert.match(kimiModelConfig('MiniMax-M3', snapshot), /1000000/)
  snapshot.accounts[1].enabled = true
  // The same model can now resolve automatically across providers.
  assert.match(kimiModelConfig('MiniMax-M3', snapshot), /1000000/)
  snapshot.accounts[1].models = ['unlisted-model']
  snapshot.accounts[1].modelMappings = { 'MiniMax-M3': 'unlisted-model' }
  assert.throws(() => kimiModelConfig('MiniMax-M3', snapshot), /上下文长度/)
  snapshot.accounts[1].hasCredential = false
  snapshot.modelPriceCatalog.entries[0].capabilities = undefined
  const text = kimiModelConfig('MiniMax-M3', snapshot)
  assert.match(text, /capabilities = \[  \]/)
  assert.doesNotMatch(text, /support_efforts|thinking|image_in/)
  assert.throws(() => kimiModelConfig('unknown', snapshot), /来源账号/)
})

test('explicit catalog associations are honored and TOML strings are escaped', () => {
  const snapshot = fixture()
  snapshot.modelPriceCatalog.entries[0].provider = 'minimax'
  snapshot.modelPriceCatalog.entries[0].name = 'Name "quoted"\nnext\u007f'
  snapshot.modelPrices = [
    {
      provider: 'commandcode-goat',
      model: 'MiniMaxAI/MiniMax-M3',
      catalogMatch: { provider: 'minimax', model: 'MiniMaxAI/MiniMax-M3' },
      currency: 'USD',
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null
    }
  ]
  const text = kimiModelConfig('MiniMax-M3', snapshot)
  assert.ok(text.includes('display_name = "Name \\"quoted\\"\\nnext\\u007f"'))
})
