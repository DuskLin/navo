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
