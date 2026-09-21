import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestCost, requestCostDetails } from '../src/shared/request-cost'
import type { GatewaySnapshot, RequestRecord, ModelPrice } from '../src/shared/contracts'
const record: RequestRecord = {
  id: 'r',
  provider: 'kimi',
  accountId: 'a',
  account: 'a',
  model: 'm',
  group: '',
  time: 1,
  status: 200,
  attempts: 1,
  durationMs: 10,
  firstTokenMs: null,
  usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: null, cost: null }
}
const price: ModelPrice = {
  provider: 'kimi',
  model: 'm',
  currency: 'CNY',
  input: 2,
  output: null,
  cacheRead: 0,
  cacheWrite: null
}
const snapshot: Pick<GatewaySnapshot, 'accounts' | 'modelPrices' | 'modelPriceCatalog'> = {
  accounts: [],
  modelPrices: [price],
  modelPriceCatalog: {
    entries: [],
    prices: [{ ...price, currency: 'USD', input: 1, output: 10, cacheRead: 1, tiered: false }],
    updatedAt: 1,
    error: ''
  }
}

test('request costs prefer reported USD, including explicit zero', () => {
  for (const cost of [0, 0.25]) {
    const result = requestCost({ ...record, usage: { ...record.usage!, cost } }, snapshot)
    assert.equal(result.source, 'reported')
    assert.deepEqual(result.amounts, [{ currency: 'USD', value: cost }])
  }
})

test('mapped requests use the recorded upstream model for historical cost and details', () => {
  const mapped = { ...record, model: 'alias', upstreamModel: 'm' }
  assert.deepEqual(requestCost(mapped, snapshot), requestCost(record, snapshot))
  assert.deepEqual(requestCostDetails(mapped, snapshot), requestCostDetails(record, snapshot))
})
test('request estimates resolve each price field, keep currencies separate and preserve free cached tokens', () => {
  const result = requestCost(record, snapshot)
  assert.equal(result.source, 'estimated')
  assert.deepEqual(result.amounts, [
    { currency: 'CNY', value: 0.002 },
    { currency: 'USD', value: 0.001 }
  ])
  assert.match(requestCost({ ...record, status: 499 }, snapshot).note, /中断/)
  assert.equal(
    requestCost({ ...record, usage: { ...record.usage!, cacheWrite: 200 } }, snapshot).source,
    'estimated'
  )
  assert.equal(requestCost({ ...record, usage: null }, snapshot).amounts[0].value, 0)
  assert.equal(requestCost({ ...record, provider: undefined }, snapshot).source, 'unknown')
})
test('request estimates follow saved aliases and treat missing usage as zero', () => {
  const mapped = {
    ...snapshot,
    modelPrices: [{ ...price, input: null, catalogMatch: { provider: 'source', model: 'other' } }],
    modelPriceCatalog: {
      ...snapshot.modelPriceCatalog,
      entries: [
        {
          ...price,
          provider: 'source',
          model: 'other',
          name: 'Other',
          providerName: 'Source',
          currency: 'USD' as const,
          input: 4,
          output: 8,
          tiered: true
        }
      ]
    }
  }
  assert.deepEqual(
    requestCost(record, mapped).amounts.map((p) => ({ ...p, value: Number(p.value.toFixed(10)) })),
    [
      { currency: 'USD', value: 0.0048 },
      { currency: 'CNY', value: 0 }
    ]
  )
  assert.equal(
    requestCost({ ...record, usage: { ...record.usage!, input: null } }, mapped).source,
    'estimated'
  )
})

test('cost detail treats unreported tokens as zero and shows per-field units and subtotals', () => {
  const detail = requestCostDetails(record, snapshot)
  assert.deepEqual(
    detail.map((p) => p.tokens),
    [1000, 100, 500, 0]
  )
  assert.equal(detail[0].price?.currency, 'CNY')
  assert.equal(detail[0].subtotal, 0.002)
  assert.equal(detail[1].price?.currency, 'USD')
  assert.equal(detail[1].subtotal, 0.001)
  assert.equal(detail[2].subtotal, 0)
  assert.equal(detail[3].subtotal, 0)
  assert.equal(
    requestCostDetails({ ...record, usage: { ...record.usage!, cost: 2 } }, snapshot)[0].subtotal,
    0.002
  )
})

test('unset prices count as zero for every reported token category', () => {
  const noPrices = {
    accounts: [],
    modelPrices: [],
    modelPriceCatalog: { entries: [], prices: [], updatedAt: null, error: '' }
  }
  const request = {
    ...record,
    usage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: null }
  }
  assert.deepEqual(requestCost(request, noPrices).amounts, [{ currency: 'USD', value: 0 }])
  assert.ok(
    requestCostDetails(request, noPrices).every((d) => d.price.amount === 0 && d.subtotal === 0)
  )
  assert.deepEqual(
    requestCost({ ...record, usage: { ...record.usage!, cacheWrite: 1000000 } }, snapshot).amounts,
    requestCost(record, snapshot).amounts
  )
})

test('missing usage contributes zero while known output remains billable', () => {
  const partial = {
    ...record,
    usage: { ...record.usage!, input: null, cacheRead: null, cacheWrite: null }
  }
  assert.deepEqual(requestCost(partial, snapshot).amounts, [{ currency: 'USD', value: 0.001 }])
  for (const usage of [undefined, null]) {
    const empty = { ...record, usage }
    assert.ok(requestCostDetails(empty, snapshot).every((p) => p.tokens === 0 && p.subtotal === 0))
    assert.equal(requestCost(empty, snapshot).amounts[0].value, 0)
  }
})
