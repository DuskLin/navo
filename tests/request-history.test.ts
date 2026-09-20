import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performanceHistoryRange } from '../src/shared/usage'
import { RequestHistory } from '../src/main/services/request-history'

test('quota usage reads complete account history within cycle boundaries and invalidates cache', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-quota-history-'))
  const history = new RequestHistory(join(dir, 'requests.sqlite'))
  try {
    const record = {
      id: 'base',
      time: Date.now() - 1000 + 10,
      accountId: 'a',
      group: '',
      account: 'same name',
      model: 'm',
      status: 200,
      attempts: 1,
      durationMs: 1,
      firstTokenMs: null
    }
    for (let i = 0; i < 20; i++)
      history.append({ ...record, id: String(i), time: Date.now() - 1000 + i })
    history.append({ ...record, id: 'other', accountId: 'b' })
    assert.equal(history.quotaUsage('a', Date.now() - 995, Date.now() - 981).length, 15)
    assert.equal(history.quotaUsage('b', Date.now() - 995, Date.now() - 981).length, 1)
    history.append({ ...record, id: 'late' })
    assert.equal(history.quotaUsage('a', Date.now() - 995, Date.now() - 981).length, 16)
    assert.equal(history.quotaUsage('a', Date.now() - 981, Date.now() - 980).length, 1)
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('请求记录落盘超过 100 条，重启可分页读取且新请求不打乱旧页游标', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-history-'))
  let history = new RequestHistory(join(dir, 'requests.sqlite'))
  try {
    for (let i = 0; i < 137; i++)
      history.append({
        id: String(i),
        time: Date.now() - 1000 + i,
        group: '',
        account: 'account',
        model: 'k3',
        status: 200,
        attempts: 1,
        durationMs: 1234,
        firstTokenMs: 955,
        upstreamRequestId: `request-${i}`
      })
    history.close()
    history = new RequestHistory(join(dir, 'requests.sqlite'))
    const first = history.page()
    assert.equal(first.total, 137)
    assert.equal(first.records.length, 10)
    assert.equal(first.records[0].upstreamRequestId, 'request-136')
    history.append({ ...first.records[0], id: 'new' })
    const all = [...first.records]
    let cursor = first.nextCursor
    while (cursor) {
      const next = history.page(cursor)
      assert.ok(next.records.length <= 10)
      all.push(...next.records)
      cursor = next.nextCursor
    }
    assert.equal(all.at(-1)!.id, '0')
    assert.equal(new Set(all.map((r) => r.id)).size, 137)
    assert.equal(first.records[0].firstTokenMs, 955)
    assert.throws(() => history.page(-1))
    assert.throws(() => history.page(NaN))
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('quota averages persist one latest valid sample per account, window and cycle', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-quota-averages-'))
  const file = join(dir, 'requests.sqlite')
  let history = new RequestHistory(file)
  const cycle1 = '2026-09-16T12:00:00.000Z'
  const cycle2 = '2026-09-16T17:00:00.000Z'
  const estimate = (total: number, currency: 'USD' | 'CNY' = 'USD') => ({
    amounts: [{ currency, used: total / 2, total, remaining: total / 2 }]
  })
  try {
    assert.deepEqual(history.quotaAverages('a', 'fiveHour', cycle1, 1, estimate(10)), [
      { currency: 'USD', total: 10, cycles: 1 }
    ])
    history.quotaAverages('a', 'fiveHour', cycle1, 1, estimate(10))
    history.quotaAverages('a', 'fiveHour', cycle1, 2, estimate(20))
    history.quotaAverages('a', 'fiveHour', cycle1, 1, estimate(99))
    assert.deepEqual(history.quotaAverages('a', 'fiveHour', cycle2, 3, estimate(40)), [
      { currency: 'USD', total: 30, cycles: 2 }
    ])
    // An empty new cycle or failed refresh keeps past valid samples, without adding a zero.
    assert.deepEqual(history.quotaAverages('a', 'fiveHour', cycle2, 4, { amounts: [] }), [
      { currency: 'USD', total: 30, cycles: 2 }
    ])
    assert.deepEqual(history.quotaAverages('a', 'weekly', cycle1, 1, estimate(100)), [
      { currency: 'USD', total: 100, cycles: 1 }
    ])
    assert.deepEqual(history.quotaAverages('b', 'fiveHour', cycle1, 1, estimate(200)), [
      { currency: 'USD', total: 200, cycles: 1 }
    ])
    history.close()
    history = new RequestHistory(file)
    assert.deepEqual(history.quotaAverages('a', 'fiveHour', null, 5, { amounts: [] }), [
      { currency: 'USD', total: 30, cycles: 2 }
    ])
    assert.deepEqual(
      history.quotaAverages('a', 'fiveHour', cycle2, 5, {
        amounts: [...estimate(40).amounts, ...estimate(60, 'CNY').amounts]
      }),
      [
        { currency: 'CNY', total: 60, cycles: 1 },
        { currency: 'USD', total: 30, cycles: 2 }
      ]
    )
    assert.deepEqual(history.quotaAverages('empty', 'weekly', cycle1, 1, estimate(Infinity)), [])
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('cycle exclusions migrate old databases, survive refresh and restart, and restore averages', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-cycle-exclusions-'))
  const file = join(dir, 'requests.sqlite')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE quota_cost_cycles (
    account_id TEXT NOT NULL, window TEXT NOT NULL, reset_at TEXT NOT NULL,
    checked_at REAL NOT NULL, amounts TEXT NOT NULL,
    PRIMARY KEY(account_id, window, reset_at)
  )`)
  const resetAt = '2026-09-16T12:00:00.000Z'
  old
    .prepare('INSERT INTO quota_cost_cycles VALUES (?, ?, ?, ?, ?)')
    .run('a', 'fiveHour', resetAt, 1, JSON.stringify([{ currency: 'USD', total: 10 }]))
  old.close()
  let history = new RequestHistory(file)
  const query = { accountId: 'a', window: 'fiveHour' as const }
  const empty = { amounts: [] }
  try {
    assert.equal(history.getQuotaCycles(query)[0].excluded, false)
    history.setQuotaCycleExcluded({ ...query, resetAt, excluded: true })
    assert.deepEqual(
      history.quotaAverages('a', 'fiveHour', resetAt, 2, {
        amounts: [{ currency: 'USD', total: 20, used: 10, remaining: 10 }]
      }),
      []
    )
    assert.equal(history.getQuotaCycles(query)[0].amounts[0].total, 20)
    history.close()
    history = new RequestHistory(file)
    assert.equal(history.getQuotaCycles(query)[0].excluded, true)
    assert.deepEqual(history.quotaAverages('a', 'fiveHour', null, 3, empty), [])
    assert.deepEqual(history.getQuotaCycles({ ...query, accountId: 'b' }), [])
    assert.deepEqual(history.getQuotaCycles({ ...query, window: 'weekly' }), [])
    history.setQuotaCycleExcluded({ ...query, resetAt, excluded: false })
    assert.deepEqual(history.quotaAverages('a', 'fiveHour', null, 3, empty), [
      { currency: 'USD', total: 20, cycles: 1 }
    ])
    assert.throws(() => history.setQuotaCycleExcluded({ ...query, resetAt, excluded: 'false' }))
    assert.throws(() =>
      history.setQuotaCycleExcluded({ ...query, accountId: 'b', resetAt, excluded: true })
    )
    assert.throws(() => history.getQuotaCycles({ ...query, window: 'monthly' }))
    assert.throws(() => history.getQuotaCycles(null))
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('daily performance uses Beijing calendar days and keeps metrics and accounts separate', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-daily-performance-'))
  const history = new RequestHistory(join(dir, 'requests.sqlite'))
  try {
    const now = Date.parse('2026-09-16T10:00:00+08:00')
    const range = performanceHistoryRange(now)
    assert.equal(range.days.length, 30)
    assert.equal(range.days[0], '2026-09-16')
    assert.equal(range.days[29], '2026-08-18')
    assert.equal(range.start, Date.parse('2026-08-18T00:00:00+08:00'))
    const base = {
      id: '1',
      accountId: 'a',
      account: 'A',
      group: '',
      model: 'm',
      status: 200,
      attempts: 1,
      durationMs: 1000,
      firstTokenMs: 100,
      streamDurationMs: 1000,
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0 },
      time: Date.parse('2026-09-15T23:59:59+08:00')
    }
    history.append(base)
    history.append({
      ...base,
      id: '2',
      time: Date.parse('2026-09-16T00:00:00+08:00'),
      firstTokenMs: 500,
      usage: { ...base.usage, output: 50 }
    })
    history.append({
      ...base,
      id: '3',
      time: Date.parse('2026-09-16T09:00:00+08:00'),
      firstTokenMs: 900
    })
    history.append({ ...base, id: 'other', accountId: 'b', firstTokenMs: 99999 })
    history.append({ ...base, id: 'old', time: range.start - 1 })
    const query = { start: range.start, end: range.end, bucketMs: 86400000, accountId: 'a' }
    const rows = history.usage({ ...query, performanceByDay: true }).byAccount
    assert.equal(rows.length, 3)
    assert.deepEqual(
      rows.map((r) => [r.day, r.period, r.averageFirstTokenMs, r.averageTokensPerSecond]),
      [
        ['2026-09-16', 'off-peak', 500, 50],
        ['2026-09-16', 'peak', 900, 10],
        ['2026-09-15', 'off-peak', 100, 10]
      ]
    )
    assert.ok(rows.every((r) => r.firstTokenSamples === 1 && r.speedSamples === 1))
    assert.equal(history.usage(query).byAccount.length, 2)
    assert.ok(history.usage(query).byAccount.every((r) => r.day === undefined))
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('retention removes expired persisted records on startup, append, page and idle cleanup', async (t) => {
  let now = Date.parse('2026-09-20T00:00:00Z')
  t.mock.method(Date, 'now', () => now)
  t.mock.timers.enable({ apis: ['setInterval'] })
  const dir = await mkdtemp(join(tmpdir(), 'navo-retention-'))
  const file = join(dir, 'requests.sqlite')
  let history = new RequestHistory(file)
  const cutoff = now - 90 * 86400000
  const base = {
    id: 'boundary',
    time: cutoff,
    accountId: 'a',
    account: 'A',
    group: '',
    model: 'm',
    status: 200,
    attempts: 1,
    durationMs: 1,
    firstTokenMs: null
  }
  try {
    history.append(base)
    history.append({ ...base, id: 'recent', time: now })
    history.close()
    const seed = new DatabaseSync(file)
    seed
      .prepare('INSERT INTO requests (id, record) VALUES (?, ?)')
      .run('expired', JSON.stringify({ ...base, id: 'expired', time: cutoff - 1 }))
    seed.close()
    history = new RequestHistory(file)
    assert.equal(history.page().total, 2)
    assert.equal(history.quotaUsage('a', 0, now).length, 2)
    now += 1
    history.append({ ...base, id: 'too-old', time: cutoff - 1 })
    assert.equal(history.page().total, 1)
    assert.equal(history.quotaUsage('a', 0, now - 1).length, 1)
    history.append({ ...base, id: 'page-boundary', time: now - 90 * 86400000 })
    now += 1
    assert.equal(history.page().total, 1)
    history.append({ ...base, id: 'idle-boundary', time: now - 90 * 86400000 })
    now += 1
    t.mock.timers.tick(60 * 60 * 1000)
    const reader = new DatabaseSync(file, { readOnly: true })
    try {
      assert.equal(reader.prepare('SELECT COUNT(*) AS total FROM requests').get()!.total, 1)
    } finally {
      reader.close()
    }
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})
