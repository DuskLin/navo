import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestHistory } from '../src/main/services/request-history'
import { UsageService } from '../src/main/services/usage-service'
import type { RequestPricing } from '../src/shared/request-cost'

const start = new Date().setHours(0, 0, 0, 0)
const record = {
  id: 'a',
  time: start + 1000,
  group: '',
  account: 'account',
  accountId: 'a',
  provider: 'kimi' as const,
  model: 'm',
  status: 200,
  attempts: 1,
  durationMs: 100,
  firstTokenMs: 10,
  usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: null }
}
const query = { start, end: start + 86400000, bucketMs: 86400000 }
const pricing: RequestPricing = {
  accounts: [{ id: 'a', provider: 'kimi' }],
  modelPrices: [],
  modelPriceCatalog: { entries: [], prices: [], updatedAt: null, error: '' }
}

test('worker statistics match synchronous results and invalidate on writes and pricing changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-usage-worker-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  const service = new UsageService(file)
  try {
    history.append(record)
    const first = service.usage(query, pricing)
    assert.equal(service.usage(query, pricing), first)
    assert.deepEqual(await first, structuredClone(history.usage(query, pricing)))
    assert.deepEqual(
      await service.usage(query, pricing),
      structuredClone(history.usage(query, pricing))
    )
    history.append({ ...record, id: 'b' })
    assert.equal((await service.usage(query, pricing)).summary.requests, 2)
    const changed: RequestPricing = {
      ...pricing,
      modelPrices: [
        {
          provider: 'kimi',
          model: 'm',
          currency: 'USD',
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0
        }
      ]
    }
    assert.equal((await service.usage(query, changed)).summary.cost, 0.022)
    await assert.rejects(service.usage({ ...query, end: -1 }, pricing), /统计时间/)
    assert.equal((await service.usage(query, pricing)).summary.requests, 2)
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('large worker scans leave HTTP responsive and pending queries can be cancelled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-usage-load-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  const service = new UsageService(file)
  const server = createServer((_req, res) => res.end('gateway alive'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    // Warm up the real worker before measuring responsiveness during the scan.
    await service.usage(query, pricing)
    const seed = new DatabaseSync(file)
    try {
      seed.exec('BEGIN')
      const insert = seed.prepare('INSERT INTO requests (id, record) VALUES (?, ?)')
      for (let i = 0; i < 20000; i++)
        insert.run(String(i), JSON.stringify({ ...record, id: String(i), time: start + i }))
      seed.exec('COMMIT')
    } finally {
      seed.close()
    }
    let completed = false
    const result = service.usage(query, pricing).finally(() => {
      completed = true
    })
    void result.catch(() => {})
    const port = (server.address() as { port: number }).port
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'gateway alive')
    assert.equal(completed, false, 'HTTP must respond while the history scan is still running')
    assert.equal((await result).summary.requests, 20000)
    const pending = service.usage({ ...query, model: 'm' }, pricing)
    const rejected = assert.rejects(pending, /已关闭/)
    await service.close()
    await rejected
    await assert.rejects(service.usage(query), /已关闭/)
  } finally {
    await service.close()
    history.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('版本化价格与无价格查询交错时保持正确，并在改价后失效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-usage-price-version-'))
  const file = join(dir, 'history.sqlite')
  const history = new RequestHistory(file)
  const service = new UsageService(file)
  try {
    history.append(record)
    const first = {
      ...pricing,
      modelPrices: [
        {
          provider: 'kimi' as const,
          model: 'm',
          currency: 'USD' as const,
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0
        }
      ]
    }
    const second = { ...first, modelPrices: first.modelPrices.map((p) => ({ ...p, input: 0 })) }
    const results = await Promise.all([
      service.usage(query, first, 1),
      service.usage(query),
      service.usage({ ...query, model: 'm' }, first, 1),
      service.usage(query, second, 2)
    ])
    assert.equal(results[0].summary.cost, 0.011)
    assert.equal(results[1].summary.cost, null)
    assert.equal(results[2].summary.cost, 0.011)
    assert.equal(results[3].summary.cost, 0.001)
    assert.deepEqual(await service.usage(query, second, 2), results[3])
    history.append({ ...record, id: 'new' })
    assert.equal((await service.usage(query, second, 2)).summary.cost, 0.002)
  } finally {
    await service.close()
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('热力图缓存考虑跨日、未来记录及已经结束的查询范围', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-usage-expiry-'))
  const history = new RequestHistory(join(dir, 'history.sqlite'))
  try {
    const at = new Date().setHours(12, 0, 0, 0)
    const tomorrow = new Date(at)
    tomorrow.setHours(24, 0, 0, 0)
    const range = {
      start: at - 86400000,
      end: +tomorrow + 86400000,
      bucketMs: 86400000,
      allHistory: true
    }
    assert.equal(history.usageCacheExpiry(range, at), +tomorrow)
    history.append({ ...record, id: 'future', time: at + 1000 })
    assert.equal(history.usageCacheExpiry(range, at), at + 1000)
    assert.equal(history.usageCacheExpiry(range, at + 1000), +tomorrow)
    assert.equal(history.usageCacheExpiry({ ...range, end: at - 1 }, at), Infinity)
    assert.equal(history.usageCacheExpiry({ ...range, allHistory: false }, at), Infinity)
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})
