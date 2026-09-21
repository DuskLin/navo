import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoMatchCatalog } from '../src/shared/catalog-match'
import { matchedModelPrice, searchCatalogPrices } from '../src/shared/model-pricing'
import { parseCatalogEntries } from '../src/main/services/model-price-catalog'

test('automatic matching ignores prefixes, case and separators and prefers priced names', () => {
  const entries = parseCatalogEntries({
    commandcode: { models: { 'MiniMax-M3': { name: 'MiniMax M3', limit: { context: 1000000 } } } },
    minimax: { models: { 'MiniMax-M3': { name: 'MiniMax M3', cost: { input: 0, output: 2 } } } }
  })
  for (const model of ['MiniMaxAI/MiniMax-M3', 'minimax_m3', 'MiniMax M3'])
    assert.equal(autoMatchCatalog(entries, model, 'commandcode-goat')?.provider, 'minimax')
  assert.equal(searchCatalogPrices(entries, 'MiniMaxAI/MiniMax-M3')[0]?.provider, 'minimax')
  entries[0].input = 1
  assert.equal(autoMatchCatalog(entries, 'MiniMax-M3', 'commandcode-goat')?.provider, 'commandcode')
  entries[0].input = null
  entries[1].output = null
  assert.equal(autoMatchCatalog(entries, 'MiniMax-M3', 'commandcode-goat')?.input, 0)
})

test('automatic matching keeps versions and variants separate and leaves ambiguous names unresolved', () => {
  const entries = parseCatalogEntries({
    vendor: {
      models: {
        'deepseek-v4.1-flash': { name: 'DeepSeek Flash' },
        'deepseek-v4.2-flash': { name: 'DeepSeek Flash' },
        'deepseek-v4-pro': { name: 'DeepSeek V4 Pro' }
      }
    }
  })
  for (const model of ['deepseek-flash', 'deepseek-v41-flash', 'deepseek-v4', 'deepseek-v4.1-pro'])
    assert.equal(autoMatchCatalog(entries, model, 'custom'), undefined, model)
  assert.equal(autoMatchCatalog(entries, 'DeepSeek V4 Pro', 'custom')?.model, 'deepseek-v4-pro')
  const single = parseCatalogEntries({
    vendor: { models: { 'opaque-id': { name: 'MiniMax M3' } } }
  })
  assert.equal(autoMatchCatalog(single, 'MiniMaxAI/minimax-m3', 'custom')?.model, 'opaque-id')
})

test('manual associations override automatic price preference and missing saved targets stay unresolved', () => {
  const entries = parseCatalogEntries({
    a: { models: { 'model-3': { name: 'Model 3' } } },
    b: { models: { 'model-3': { cost: { input: 1 } } } }
  })
  const catalog = { entries, prices: [], updatedAt: 1, error: '' }
  const price = {
    provider: 'custom' as const,
    model: 'Model_3',
    currency: 'USD' as const,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null
  }
  assert.equal(matchedModelPrice(price, catalog)?.provider, 'b')
  assert.equal(
    matchedModelPrice({ ...price, catalogMatch: { provider: 'a', model: 'model-3' } }, catalog)
      ?.provider,
    'a'
  )
  assert.equal(
    matchedModelPrice(
      { ...price, catalogMatch: { provider: 'missing', model: 'model-3' } },
      catalog
    ),
    undefined
  )
})
