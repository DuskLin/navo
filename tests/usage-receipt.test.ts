import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestHistory } from '../src/main/services/request-history'
import { receiptRange, renderUsageReceipt, type UsageReceipt } from '../src/shared/usage-receipt'
import type { RequestRecord } from '../src/shared/contracts'
import type { RequestPricing } from '../src/shared/request-cost'

test('receipt groups match dashboard totals, preserve currencies, deduplicate sessions and retain legacy records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-receipt-'))
  const history = new RequestHistory(join(dir, 'history.sqlite'))
  try {
    const now = Date.now()
    const base: RequestRecord = {
      id: '',
      time: now - 1000,
      account: 'a',
      accountId: 'a',
      group: '',
      model: 'shared',
      provider: 'custom',
      status: 200,
      attempts: 1,
      durationMs: 100,
      firstTokenMs: 10,
      usage: { input: 100, output: 50, cacheRead: 50, cacheWrite: 0, cost: null }
    }
    const records: RequestRecord[] = [
      {
        ...base,
        id: '1',
        harness: 'Codex',
        sessionId: 'same',
        usage: { ...base.usage!, cost: 0.25 }
      },
      { ...base, id: '2', harness: 'Codex', sessionId: 'same', model: 'other' },
      { ...base, id: '3', harness: 'Kimi Code', sessionId: 'different' },
      { ...base, id: '4' }, // Old records must not be guessed from provider/model.
      { ...base, id: '5', usage: null },
      { ...base, id: '6', time: now - 10 * 86400000, sessionId: 'outside' },
      { ...base, id: '7', time: now + 10000, sessionId: 'future' }
    ]
    records.forEach((r) => history.append(r))
    const pricing: RequestPricing = {
      accounts: [{ id: 'a', provider: 'custom' }],
      modelPrices: ['shared', 'other'].map((model) => ({
        provider: 'custom',
        model,
        currency: 'CNY',
        input: 2,
        output: 4,
        cacheRead: 1,
        cacheWrite: 0
      })),
      modelPriceCatalog: { entries: [], prices: [], updatedAt: null, error: '' }
    }
    const range = { start: now - 86400000, end: now, bucketMs: 86400000 }
    const plain = history.usageSnapshot(range, pricing)
    const stats = history.usageSnapshot({ ...range, receipt: true }, pricing)
    assert.deepEqual(stats.summary, plain.summary)
    assert.equal(plain.receipt, undefined)
    assert.equal(stats.receipt!.sessionCount, 2)
    assert.equal(stats.receipt!.unidentifiedSessionRequests, 1)
    assert.equal(stats.receipt!.byHarnessModel.length, 4)
    assert.equal(stats.receipt!.byHarnessModel.find((r) => r.harness === '未知客户端')!.requests, 1)
    assert.equal(
      stats.receipt!.byHarnessModel.reduce((sum, r) => sum + r.totalTokens!, 0),
      stats.summary.totalTokens
    )
    assert.equal(stats.summary.requests, 4)
    for (const amount of stats.summary.costAmounts!) {
      const grouped = stats.receipt!.byHarnessModel.reduce(
        (sum, r) => sum + (r.costAmounts?.find((c) => c.currency === amount.currency)?.value ?? 0),
        0
      )
      assert.ok(Math.abs(grouped - amount.value) < 1e-10)
    }
    assert.deepEqual(
      stats.summary.costAmounts!.map((r) => r.currency),
      ['USD', 'CNY']
    )
    assert.throws(() => history.usage({ ...range, receipt: 'yes' as unknown as boolean }), /小票/)
    const empty = history.usage({
      start: now - 20 * 86400000,
      end: now - 19 * 86400000,
      bucketMs: 86400000,
      receipt: true
    })
    assert.deepEqual(empty.receipt, {
      byHarnessModel: [],
      sessionCount: 0,
      unidentifiedSessionRequests: 0
    })
    const snapshot: UsageReceipt = {
      ...range,
      generatedAt: now,
      days: 1,
      summary: stats.summary,
      details: stats.receipt!
    }
    snapshot.details.byHarnessModel[0].model =
      '<script>alert("x")</script>&' + '超长model-name-'.repeat(20)
    const paper = renderUsageReceipt(snapshot, 'cost')
    const preview = renderUsageReceipt(snapshot, 'cost', 0)
    assert.ok(paper.svg.includes('&lt;script&gt;'))
    assert.ok(!paper.svg.includes('<script>'))
    assert.equal(preview.height - paper.height, 128)
    assert.equal(preview.width - paper.width, 128)
    assert.ok(preview.svg.includes('USD 0.25'))
    assert.ok(preview.svg.includes('CNY'))
    assert.ok(renderUsageReceipt(snapshot, 'tokens').svg.includes('总 T O K E N'))
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('receipt range uses local calendar days, including DST, and freezes its end time', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const now = +new Date('2026-03-09T12:00:00-04:00')
    const week = receiptRange(7, now)
    assert.equal(week.start, +new Date('2026-03-03T00:00:00-05:00'))
    assert.equal(week.end, now + 1)
    assert.equal(receiptRange(1, now).start, +new Date('2026-03-09T00:00:00-04:00'))
    assert.equal(receiptRange(30, now).start, +new Date('2026-02-08T00:00:00-05:00'))
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
