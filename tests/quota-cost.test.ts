import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateQuotaCost, quotaCacheHitRate } from '../src/shared/quota-cost'
import type { GatewaySnapshot, RequestRecord, QuotaWindow } from '../src/shared/contracts'
const hour = 3600000
const reset = 10 * hour
const window: QuotaWindow = {
  limit: 100,
  remaining: 75,
  used: 25,
  resetAt: new Date(reset).toISOString()
}
const pricing: Pick<GatewaySnapshot, 'accounts' | 'modelPrices' | 'modelPriceCatalog'> = {
  accounts: [],
  modelPrices: [],
  modelPriceCatalog: { entries: [], prices: [], updatedAt: null, error: '' }
}
const record: RequestRecord = {
  id: 'r',
  accountId: 'a',
  account: 'A',
  provider: 'kimi',
  model: 'm',
  group: '',
  time: 6 * hour,
  durationMs: 1000,
  status: 200,
  attempts: 1,
  firstTokenMs: null,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 10 }
}
test('uses the quota cycle and observation boundary, including reported interrupted costs', () => {
  const result = estimateQuotaCost(
    window,
    5 * hour,
    8 * hour,
    [
      record,
      { ...record, time: 4 * hour },
      { ...record, time: 8 * hour },
      { ...record, time: 7 * hour, status: 499, interruption: 'client_disconnect' }
    ],
    pricing,
    8 * hour
  )
  assert.deepEqual(result.amounts, [{ currency: 'USD', used: 20, total: 80, remaining: 60 }])
})
test('does not invent amounts for full, reset, invalid or unpriced quotas', () => {
  for (const quota of [
    null,
    { ...window, remaining: 100 },
    { ...window, limit: 0 },
    { ...window, remaining: 101 },
    { ...window, resetAt: null },
    { ...window, remaining: NaN }
  ]) {
    assert.equal(
      estimateQuotaCost(quota, 5 * hour, 8 * hour, [record], pricing, 8 * hour).amounts.length,
      0
    )
  }
  assert.equal(
    estimateQuotaCost(window, 5 * hour, 8 * hour, [record], pricing, reset).amounts.length,
    0
  )
  assert.equal(
    estimateQuotaCost(window, 5 * hour, 8 * hour, [], pricing, 8 * hour).amounts.length,
    0
  )
  assert.deepEqual(
    estimateQuotaCost({ ...window, remaining: 0 }, 5 * hour, 8 * hour, [record], pricing, 8 * hour)
      .amounts,
    [{ currency: 'USD', used: 10, total: 10, remaining: 0 }]
  )
})
test('weekly uses seven days and keeps currencies separate without conversion', () => {
  const prices = {
    ...pricing,
    modelPrices: [
      {
        provider: 'kimi' as const,
        model: 'm',
        currency: 'CNY' as const,
        input: 1000000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      }
    ]
  }
  const weekReset = 8 * 24 * hour
  const quota = { ...window, resetAt: new Date(weekReset).toISOString() }
  const records = [
    { ...record, time: 2 * 24 * hour },
    { ...record, time: 3 * 24 * hour, usage: { ...record.usage!, cost: null } }
  ]
  assert.deepEqual(
    estimateQuotaCost(quota, 7 * 24 * hour, weekReset - hour, records, prices, weekReset - hour)
      .amounts,
    [
      { currency: 'USD', used: 10, total: 40, remaining: 30 },
      { currency: 'CNY', used: 1, total: 4, remaining: 3 }
    ]
  )
})

test('续期后按观测基线的额度差值估算，排除续期前及跨边界请求', () => {
  const baseline = { start: 7 * hour, usedRatio: 0.125 }
  const records = [
    record,
    { ...record, time: baseline.start - 500 },
    { ...record, time: baseline.start, usage: { ...record.usage!, cacheRead: 3 } },
    { ...record, time: 8 * hour - 500 }
  ]
  const result = estimateQuotaCost(
    window,
    5 * hour,
    8 * hour,
    records,
    pricing,
    8 * hour,
    undefined,
    baseline
  )
  assert.deepEqual(result.amounts, [{ currency: 'USD', used: 10, total: 80, remaining: 60 }])
  assert.equal(quotaCacheHitRate(window, 5 * hour, 8 * hour, records, 8 * hour, baseline), 0.75)
  assert.deepEqual(
    estimateQuotaCost(
      { ...window, remaining: 87.5 },
      5 * hour,
      8 * hour,
      records,
      pricing,
      8 * hour,
      undefined,
      baseline
    ),
    { amounts: [], reason: '待产生用量' }
  )
  assert.equal(
    estimateQuotaCost(window, 5 * hour, 6 * hour, records, pricing, 8 * hour, undefined, baseline)
      .reason,
    '等待额度刷新'
  )
})

test('quota cache hit rates are token-weighted, independent of price and include cache writes', () => {
  const request = (input: number, cacheRead: number, cacheWrite = 0) => ({
    ...record,
    usage: { input, cacheRead, cacheWrite, output: 999999, cost: null }
  })
  const records = [request(100, 900), request(90, 10), request(0, 0, 100)]
  assert.equal(quotaCacheHitRate(window, 5 * hour, 8 * hour, records, 8 * hour), 910 / 1200)
  assert.equal(
    quotaCacheHitRate({ ...window, remaining: 100 }, 5 * hour, 8 * hour, records, 8 * hour),
    910 / 1200
  )
  assert.equal(quotaCacheHitRate(window, 5 * hour, 8 * hour, [request(100, 0)], 8 * hour), 0)
  assert.equal(quotaCacheHitRate(window, 5 * hour, 8 * hour, [request(0, 100)], 8 * hour), 1)
})

test('quota cache hit rates follow each cycle and observation boundary and preserve unknowns', () => {
  const hit = {
    ...record,
    usage: { input: 0, output: 1, cacheRead: 100, cacheWrite: null, cost: null }
  }
  const miss = { ...record, time: 4 * hour, usage: { ...hit.usage, input: 100, cacheRead: 0 } }
  assert.equal(
    quotaCacheHitRate(
      window,
      5 * hour,
      8 * hour,
      [hit, miss, { ...miss, time: 8 * hour }],
      8 * hour
    ),
    1
  )
  assert.equal(quotaCacheHitRate(window, 7 * 24 * hour, 8 * hour, [hit, miss], 8 * hour), 0.5)
  for (const records of [
    [],
    [{ ...hit, usage: null }],
    [{ ...hit, usage: { ...hit.usage, cacheRead: null } }],
    [{ ...hit, usage: { ...hit.usage, input: null } }],
    [{ ...hit, usage: { ...hit.usage, input: -1 } }],
    [{ ...hit, usage: { ...hit.usage, cacheRead: 0 } }]
  ]) {
    assert.equal(quotaCacheHitRate(window, 5 * hour, 8 * hour, records, 8 * hour), null)
  }
  assert.equal(quotaCacheHitRate(window, 5 * hour, 8 * hour, [hit], reset), null)
  assert.equal(
    quotaCacheHitRate({ ...window, resetAt: null }, 5 * hour, 8 * hour, [hit], 8 * hour),
    null
  )
})
