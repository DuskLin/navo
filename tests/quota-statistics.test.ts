import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaStatistics } from '../src/main/services/quota-statistics'
import { RequestHistory } from '../src/main/services/request-history'
import { estimateQuotaCost, quotaCacheHitRate } from '../src/shared/quota-cost'
import type { AccountView, RequestRecord } from '../src/shared/contracts'
import type { RequestPricing } from '../src/shared/request-cost'

const now = Date.now()
const quota = {
  limit: 100,
  remaining: 50,
  used: 50,
  resetAt: new Date(now + 3600000).toISOString()
}
const record: RequestRecord = {
  id: 'r',
  accountId: 'a',
  provider: 'kimi',
  account: 'A',
  group: '',
  model: 'm',
  time: now - 2000,
  durationMs: 100,
  firstTokenMs: 10,
  status: 200,
  attempts: 1,
  usage: { input: 100, output: 10, cacheRead: 100, cacheWrite: 0, cost: null }
}
const account = (): AccountView =>
  ({
    id: 'a',
    capabilities: { checkedAt: now, quota: { fiveHour: quota, weekly: quota } }
  }) as AccountView
const pricing: RequestPricing = {
  accounts: [{ id: 'a', provider: 'kimi' }],
  modelPrices: [
    {
      provider: 'kimi',
      model: 'm',
      currency: 'USD',
      input: 10,
      output: 20,
      cacheRead: 1,
      cacheWrite: 0
    }
  ],
  modelPriceCatalog: { entries: [], prices: [], updatedAt: null, error: '' }
}

test('后台额度结果与原计算一致；未变更快照不查询历史、不重复写周期', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-quota-worker-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  const service = new QuotaStatistics(file, history, () => String(history.revision))
  try {
    history.append(record)
    const read = t.mock.method(history, 'quotaUsage', () => {
      throw new Error('不能在主线程读历史')
    })
    const write = t.mock.method(history, 'quotaAverages')
    const a = account()
    service.apply([a], pricing, 1)
    assert.equal(a.quotaEstimates?.fiveHour?.reason, '额度估算更新中')
    await service.whenIdle()
    service.apply([a], pricing, 1)
    const expected = estimateQuotaCost(quota, 5 * 3600000, now, [record], pricing, now)
    assert.deepEqual(a.quotaEstimates?.fiveHour?.amounts, expected.amounts)
    assert.equal(
      a.quotaEstimates?.fiveHour?.cacheHitRate,
      quotaCacheHitRate(quota, 5 * 3600000, now, [record], now)
    )
    assert.equal(write.mock.callCount(), 2)
    for (let i = 0; i < 100; i++) service.apply([a], pricing, 1)
    await service.whenIdle()
    assert.equal(read.mock.callCount(), 0)
    assert.equal(write.mock.callCount(), 2)
    a.quotaEstimates!.fiveHour!.amounts[0].total = 999
    service.apply([a], pricing, 1)
    assert.deepEqual(
      a.quotaEstimates?.fiveHour?.amounts,
      expected.amounts,
      '调用方不能修改内部缓存'
    )
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('请求追加、价格修改、排除周期和到期均使对应额度统计失效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-quota-invalidate-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  let version = 1
  const service = new QuotaStatistics(file, history, () => `${version}`)
  try {
    history.append(record)
    const a = account()
    const refresh = async (p = pricing, at = now) => {
      service.apply([a], p, version, at)
      await service.whenIdle()
      service.apply([a], p, version, at)
      return a.quotaEstimates!.fiveHour!
    }
    const first = await refresh()
    history.append({ ...record, id: 'second' })
    assert.equal((await refresh()).amounts[0].used, first.amounts[0].used * 2)
    history.append({ ...record, id: 'after-observation', time: now + 1 })
    assert.equal((await refresh()).amounts[0].used, first.amounts[0].used * 2)
    version++
    const changed = {
      ...pricing,
      modelPrices: pricing.modelPrices.map((p) => ({ ...p, input: 0 }))
    }
    assert.ok((await refresh(changed)).amounts[0].used < first.amounts[0].used * 2)
    history.setQuotaCycleExcluded({
      accountId: 'a',
      window: 'fiveHour',
      resetAt: quota.resetAt,
      excluded: true
    })
    assert.deepEqual((await refresh(changed)).averages, [])
    history.setQuotaCycleExcluded({
      accountId: 'a',
      window: 'fiveHour',
      resetAt: quota.resetAt,
      excluded: false
    })
    assert.equal((await refresh(changed)).averages?.[0].cycles, 1)
    const expired = await refresh(changed, Date.parse(quota.resetAt) + 1)
    assert.deepEqual(expired.amounts, [])
    assert.equal(expired.cacheHitRate, null)
    assert.equal(expired.reason, '等待额度刷新')
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('同周期后台刷新期间保留整组数字，新结果就绪后一起替换', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-quota-no-flicker-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  const service = new QuotaStatistics(file, history, () => '1')
  try {
    history.append(record)
    const a = account()
    service.apply([a], pricing, 1)
    await service.whenIdle()
    service.apply([a], pricing, 1)
    const previous = structuredClone(a.quotaEstimates!)

    history.append({ ...record, id: 'second', usage: { ...record.usage!, cacheRead: 0 } })
    a.capabilities = { ...a.capabilities!, checkedAt: now + 1 }
    for (let i = 0; i < 20; i++) {
      service.apply([a], pricing, 1)
      for (const window of ['fiveHour', 'weekly'] as const) {
        const { refreshing, ...shown } = a.quotaEstimates![window]!
        assert.equal(refreshing, true)
        assert.deepEqual(shown, previous[window], '金额、均值、命中率不能先清空')
      }
    }
    await service.whenIdle()
    service.apply([a], pricing, 1)
    assert.equal(a.quotaEstimates!.fiveHour!.refreshing, undefined)
    assert.ok(a.quotaEstimates!.fiveHour!.amounts[0].used > previous.fiveHour!.amounts[0].used)
    assert.notEqual(a.quotaEstimates!.fiveHour!.cacheHitRate, previous.fiveHour!.cacheHitRate)
    assert.equal(
      a.quotaEstimates!.fiveHour!.averages![0].total,
      a.quotaEstimates!.fiveHour!.amounts[0].total
    )

    const latest = structuredClone(a.quotaEstimates!.fiveHour!)
    const changed = {
      ...pricing,
      modelPrices: pricing.modelPrices.map((p) => ({ ...p, input: 0 }))
    }
    service.apply([a], changed, 2)
    assert.deepEqual(a.quotaEstimates!.fiveHour, { ...latest, refreshing: true })
    await service.whenIdle()
    service.apply([a], changed, 2)
    assert.ok(a.quotaEstimates!.fiveHour!.amounts[0].used < latest.amounts[0].used)
    assert.equal(a.quotaEstimates!.fiveHour!.refreshing, undefined)
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('周期到期、切换或缺少重置时间时不会沿用上一周期的金额', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-quota-cycle-display-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  const service = new QuotaStatistics(file, history, () => '1')
  try {
    history.append(record)
    const a = account()
    service.apply([a], pricing, 1)
    await service.whenIdle()
    service.apply([a], pricing, 1)
    assert.ok(a.quotaEstimates!.fiveHour!.amounts.length)

    service.apply([a], pricing, 1, Date.parse(quota.resetAt))
    assert.deepEqual(a.quotaEstimates!.fiveHour!.amounts, [])
    const changed = structuredClone(account())
    changed.capabilities!.quota!.fiveHour!.resetAt = new Date(now + 2 * 3600000).toISOString()
    service.apply([changed], pricing, 1)
    assert.deepEqual(changed.quotaEstimates!.fiveHour!.amounts, [])
    changed.capabilities!.quota!.fiveHour!.resetAt = null
    service.apply([changed], pricing, 1)
    assert.deepEqual(changed.quotaEstimates!.fiveHour!.amounts, [])
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('刷新失败后的重试等待仍保留同周期数字', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-quota-retry-display-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  const service = new QuotaStatistics(file, history, () => '1')
  try {
    history.append(record)
    const a = account()
    service.apply([a], pricing, 1)
    await service.whenIdle()
    service.apply([a], pricing, 1)
    const previous = structuredClone(a.quotaEstimates!.fiveHour!)
    t.mock.method(history, 'quotaAverages', () => {
      throw new Error('临时读取失败')
    })
    history.append({ ...record, id: 'second' })
    service.apply([a], pricing, 1)
    await service.whenIdle()
    service.apply([a], pricing, 1)
    assert.deepEqual(a.quotaEstimates!.fiveHour, { ...previous, refreshing: true })
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('运行中多次修改只提交最新结果；删除账号和关闭服务后不写回旧任务', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-quota-race-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  let version = 1
  const service = new QuotaStatistics(file, history, () => `${version}`)
  try {
    history.append(record)
    const write = t.mock.method(history, 'quotaAverages')
    const a = account()
    service.apply([a], pricing, version)
    let latest = pricing
    for (let i = 0; i < 50; i++) {
      version++
      latest = { ...pricing, modelPrices: pricing.modelPrices.map((p) => ({ ...p, input: i })) }
      service.apply([a], latest, version)
    }
    await service.whenIdle()
    service.apply([a], latest, version)
    assert.equal(write.mock.callCount(), 2, '中间版本不得写入周期历史')
    assert.deepEqual(
      a.quotaEstimates?.fiveHour?.amounts,
      estimateQuotaCost(quota, 5 * 3600000, now, [record], latest, now).amounts
    )
    version++
    service.apply([a], pricing, version)
    service.apply([], pricing, version)
    await service.whenIdle()
    assert.equal(write.mock.callCount(), 2, '已删除账号不得回写')
    service.apply([a], pricing, version)
    const waiting = service.whenIdle()
    await service.close()
    await waiting
    assert.equal(write.mock.callCount(), 2)
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Worker 启动失败后退避重试，恢复时重新发送价格配置', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const dir = await mkdtemp(join(tmpdir(), 'navo-quota-restart-'))
  const history = new RequestHistory(join(dir, 'writer.sqlite'))
  const missingFile = join(dir, 'reader.sqlite')
  const service = new QuotaStatistics(missingFile, history, () => '1')
  let reader: RequestHistory | undefined
  try {
    const a = account()
    service.apply([a], pricing, 1)
    await service.whenIdle()
    service.apply([a], pricing, 1)
    assert.equal(a.quotaEstimates?.fiveHour?.reason, '额度估算暂不可用，稍后重试')
    reader = new RequestHistory(missingFile)
    reader.append(record)
    t.mock.timers.tick(5001)
    service.apply([a], pricing, 1)
    await service.whenIdle()
    service.apply([a], pricing, 1)
    assert.ok(a.quotaEstimates?.fiveHour?.amounts.length)
  } finally {
    await service.close()
    reader?.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('一个账号持续追加请求不会阻止其他账号提交统计结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-quota-isolation-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  const service = new QuotaStatistics(file, history, () => '1')
  try {
    history.append(record)
    history.append({ ...record, id: 'b-first', accountId: 'b' })
    const a = account(),
      b = { ...account(), id: 'b' }
    service.apply([a, b], pricing, 1)
    history.append({ ...record, id: 'b-second', accountId: 'b' })
    await service.whenIdle()
    service.apply([a, b], pricing, 1)
    assert.ok(a.quotaEstimates?.fiveHour?.amounts.length)
    assert.equal(b.quotaEstimates?.fiveHour?.reason, '额度估算更新中')
    await service.whenIdle()
    service.apply([a, b], pricing, 1)
    assert.equal(
      b.quotaEstimates?.fiveHour?.amounts[0].used,
      a.quotaEstimates!.fiveHour!.amounts[0].used * 2
    )
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})
