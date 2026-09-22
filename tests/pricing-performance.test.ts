import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoMatchCatalog, createCatalogMatcher } from '../src/shared/catalog-match'
import {
  createRequestCostCalculator,
  requestCost,
  requestCostDetails,
  type RequestPricing
} from '../src/shared/request-cost'
import type { CatalogPrice, Provider, RequestRecord } from '../src/shared/contracts'

const entry = (model: string, provider = 'vendor'): CatalogPrice => ({
  provider,
  model,
  name: model,
  providerName: provider,
  currency: 'USD',
  input: 1,
  output: 2,
  cacheRead: 0.1,
  cacheWrite: null,
  tiered: false
})
const record: RequestRecord = {
  id: 'r',
  accountId: 'a',
  account: 'A',
  group: '',
  model: 'Model_3',
  time: Date.now(),
  durationMs: 1,
  firstTokenMs: null,
  status: 200,
  attempts: 1,
  usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0, cost: null }
}

test('目录索引保留原有匹配顺序、版本区分和歧义规则', () => {
  const entries = [
    entry('model-3', 'kimi-for-coding'),
    entry('model-3', 'vendor'),
    { ...entry('opaque'), name: 'Model 3' },
    { ...entry('v4.1'), name: 'Version Four' },
    { ...entry('v4.2'), name: 'Version Four' },
    { ...entry('other'), name: '独立模型 7', input: null, output: null, cacheRead: null },
    entry('中文模型-2'),
    entry('MODEL3', 'openai')
  ]
  const indexed = createCatalogMatcher(entries)
  for (const model of [
    'Model_3',
    'prefix/model-3',
    'v41',
    'v4.1',
    'Version Four',
    '独立模型7',
    '中文模型2',
    'missing',
    '',
    '---'
  ])
    for (const provider of ['kimi', 'codex', 'custom'] as Provider[])
      assert.deepEqual(indexed(model, provider), autoMatchCatalog(entries, model, provider))
})

test('批量计价与原函数一致，并在价格、手动关联及供应商变化后重新解析', () => {
  const pricing: RequestPricing = {
    accounts: [{ id: 'a', provider: 'kimi' }],
    modelPrices: [],
    modelPriceCatalog: {
      entries: [entry('model-3'), entry('model-3', 'kimi-for-coding')],
      prices: [],
      updatedAt: 1,
      error: ''
    }
  }
  for (const p of [
    pricing,
    {
      ...pricing,
      modelPrices: [
        {
          ...entry('Model_3', 'kimi'),
          provider: 'kimi' as const,
          currency: 'CNY' as const,
          input: 0,
          catalogMatch: { provider: 'vendor', model: 'model-3' }
        }
      ]
    },
    { ...pricing, accounts: [] }
  ]) {
    const calculate = createRequestCostCalculator(p)
    for (const r of [
      record,
      { ...record, provider: 'codex' as const },
      { ...record, upstreamModel: 'missing' },
      { ...record, usage: null },
      { ...record, usage: { ...record.usage!, cost: 0 } },
      { ...record, interruption: 'client_disconnect' as const },
      { ...record, usage: { ...record.usage!, input: -1 } }
    ]) {
      assert.deepEqual(calculate(r), requestCost(r, p))
      assert.deepEqual(calculate.details(r), requestCostDetails(r, p))
    }
  }
})

test('8000 项目录只构建一次索引，重复请求和未命中模型不重新扫描目录', () => {
  let reads = 0
  const entries = Array.from({ length: 8000 }, (_, i) => {
    const value = entry(`model-${i}`)
    return {
      ...value,
      get name() {
        reads++
        return value.name
      }
    }
  })
  const calculate = createRequestCostCalculator({
    accounts: [{ id: 'a', provider: 'kimi' }],
    modelPrices: [],
    modelPriceCatalog: { entries, prices: [], updatedAt: 1, error: '' }
  })
  const afterIndex = reads
  for (let i = 0; i < 2000; i++) calculate({ ...record, model: i % 2 ? 'model-3' : 'missing' })
  assert.equal(reads, afterIndex, '计价阶段不应再次遍历目录名称')
  assert.equal(afterIndex, entries.length)
})
