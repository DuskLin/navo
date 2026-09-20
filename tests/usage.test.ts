import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import {
  formatUsageCost,
  summarizeActivity,
  parseUsage,
  heatmapRange,
  heatmapLevel,
  localDayKey,
  type TokenUsage
} from '../src/shared/usage'
import { ResponseIdsObserver } from '../src/main/services/response-ids'
import { RequestHistory } from '../src/main/services/request-history'

test('OpenAI 缓存包含在输入中，Anthropic 独立计数；保留零与未知', () => {
  assert.deepEqual(
    parseUsage(
      {
        response: {
          usage: {
            input_tokens: 1000,
            output_tokens: 100,
            input_tokens_details: { cached_tokens: 800 }
          }
        }
      },
      'responses'
    ),
    { input: 200, output: 100, cacheRead: 800 }
  )
  assert.deepEqual(
    parseUsage(
      {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 800 }
        }
      },
      'chat-completions'
    ),
    { input: 200, output: 100, cacheRead: 800 }
  )
  assert.deepEqual(
    parseUsage(
      {
        message: {
          usage: {
            input_tokens: 200,
            output_tokens: 100,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 50
          }
        }
      },
      'messages'
    ),
    { input: 200, output: 100, cacheRead: 800, cacheWrite: 50 }
  )
  assert.deepEqual(
    parseUsage(
      { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0 } },
      'messages'
    ),
    { input: 0, output: 0, cacheRead: 0, cost: 0 }
  )
  assert.equal(
    parseUsage({ usage: { input_tokens: -1, output_tokens: 'unknown' } }, 'responses'),
    null
  )
  assert.equal(parseUsage({ choices: [] }, 'chat-completions'), null)
})

test('流式开始与结束用量合并，重复累计输出不重复累加，字节透传不变', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  let usage: TokenUsage = {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    cost: null
  }
  const stream = new ResponseIdsObserver(
    true,
    () => {},
    'messages',
    (partial) => {
      usage = { ...usage, ...partial }
    }
  )
  const chunks: Buffer[] = []
  stream.on('data', (chunk) => chunks.push(chunk))
  const end = once(stream, 'end')
  const body = [
    {
      message: {
        usage: {
          input_tokens: 20,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 80
        }
      }
    },
    { usage: { output_tokens: 10 } },
    { usage: { output_tokens: 30 } },
    { usage: { output_tokens: 30 } }
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  for (let i = 0; i < body.length; i += 7) stream.write(body.slice(i, i + 7))
  stream.end()
  await end
  assert.equal(Buffer.concat(chunks).toString(), body)
  assert.deepEqual(usage, { input: 20, output: 30, cacheRead: 80, cacheWrite: 0, cost: null })
})

test('用量按完整历史汇总、筛选和时间分桶，重启保留，未知费用不计为零', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-stats-'))
  const file = join(dir, 'history.sqlite')
  let history = new RequestHistory(file)
  const start = new Date(2026, 8, 15).getTime()
  const query = { start, end: start + 86400000, bucketMs: 3600000 }
  try {
    for (let i = 0; i < 30; i++)
      history.append({
        id: String(i),
        time: start + i * 3600000,
        group: '',
        account: 'A',
        accountId: 'a',
        protocol: 'responses',
        model: 'k3',
        status: 200,
        attempts: 1,
        durationMs: 100,
        firstTokenMs: 20,
        usage: { input: 20, output: 10, cacheRead: 80, cacheWrite: null, cost: null }
      })
    history.append({
      id: 'old',
      time: start,
      group: '',
      account: 'B',
      accountId: 'b',
      model: 'old-model',
      status: 200,
      attempts: 1,
      durationMs: 50,
      firstTokenMs: null
    })
    const result = history.usage(query)
    assert.equal(result.summary.requests, 25)
    assert.equal(result.summary.reported, 24)
    assert.equal(result.summary.totalTokens, 2640)
    assert.equal(result.summary.cacheHitRate, 0.8)
    assert.equal(result.summary.cost, null)
    assert.equal(result.summary.cacheWrite, null)
    assert.equal(result.points.length, 24)
    assert.equal(result.points[0].requests, 2)
    assert.equal(
      history.usage({ ...query, accountId: 'a', model: 'k3', protocol: 'responses' }).summary
        .requests,
      24
    )
    assert.equal(history.usage({ ...query, accountId: 'b' }).summary.totalTokens, null)
    assert.equal(history.usage({ ...query, model: 'missing' }).summary.requests, 0)
    history.close()
    history = new RequestHistory(file)
    assert.equal(history.usage(query).summary.totalTokens, 2640)
    assert.throws(() => history.usage({ ...query, bucketMs: 1 }))
    assert.throws(() => history.usage({ ...query, end: start - 1 }))
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('平均速度按有效流式时长加权，中断数量和已报告消耗单独汇总', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-performance-'))
  const history = new RequestHistory(join(dir, 'history.sqlite'))
  const start = new Date(2026, 8, 16).getTime()
  const base = {
    time: start,
    group: '',
    account: 'A',
    accountId: 'account-a',
    model: 'k3',
    status: 200,
    attempts: 1,
    durationMs: 12000,
    firstTokenMs: 500
  }
  const usage = (output: number) => ({
    input: 20,
    output,
    cacheRead: 80,
    cacheWrite: null,
    cost: null
  })
  try {
    history.append({ ...base, id: 'a', streamDurationMs: 1000, usage: usage(100) })
    history.append({ ...base, id: 'b', streamDurationMs: 9000, usage: usage(200) })
    history.append({ ...base, id: 'non-stream', usage: usage(1000) })
    history.append({ ...base, id: 'unknown', streamDurationMs: 5000 })
    history.append({
      ...base,
      id: 'cancelled',
      status: 499,
      streamDurationMs: 2000,
      usage: { ...usage(50), cost: 0.01 }
    })
    history.append({ ...base, id: 'cancelled-unknown', status: 499 })
    const result = history.usage({ start, end: start + 86400000, bucketMs: 3600000 })
    assert.equal(result.summary.averageTokensPerSecond, 30)
    assert.equal(result.summary.speedSamples, 2)
    assert.equal(result.summary.interruptedRequests, 2)
    assert.equal(result.summary.interruptedReported, 1)
    assert.equal(result.summary.interruptedTokens, 150)
    assert.equal(result.summary.interruptedCost, 0.01)
    assert.equal(result.byModel[0].averageTokensPerSecond, 30)
    assert.equal(result.points[0].interruptedRequests, 2)
    history.append({
      ...base,
      id: 'other-account',
      accountId: 'account-b',
      streamDurationMs: 3000,
      usage: usage(900)
    })
    const byAccount = history.usage({ start, end: start + 86400000, bucketMs: 3600000 }).byAccount
    assert.deepEqual(
      byAccount.find((a) => a.accountId === 'account-a'),
      {
        accountId: 'account-a',
        model: 'k3',
        period: 'off-peak',
        averageTokensPerSecond: 30,
        speedSamples: 2,
        averageFirstTokenMs: 500,
        firstTokenSamples: 4
      }
    )
    assert.deepEqual(
      byAccount.find((a) => a.accountId === 'account-b'),
      {
        accountId: 'account-b',
        model: 'k3',
        period: 'off-peak',
        averageTokensPerSecond: 300,
        speedSamples: 1,
        averageFirstTokenMs: 500,
        firstTokenSamples: 1
      }
    )
    history.append({
      ...base,
      id: 'other-model',
      model: 'k2',
      streamDurationMs: 2000,
      usage: usage(400)
    })
    history.append({ ...base, id: 'no-speed-model', model: 'k1', usage: usage(10) })
    const grouped = history.usage({ start, end: start + 86400000, bucketMs: 3600000 }).byAccount
    assert.deepEqual(grouped, [
      {
        accountId: 'account-a',
        model: 'k1',
        period: 'off-peak',
        averageTokensPerSecond: null,
        speedSamples: 0,
        averageFirstTokenMs: 500,
        firstTokenSamples: 1
      },
      {
        accountId: 'account-a',
        model: 'k2',
        period: 'off-peak',
        averageTokensPerSecond: 200,
        speedSamples: 1,
        averageFirstTokenMs: 500,
        firstTokenSamples: 1
      },
      {
        accountId: 'account-a',
        model: 'k3',
        period: 'off-peak',
        averageTokensPerSecond: 30,
        speedSamples: 2,
        averageFirstTokenMs: 500,
        firstTokenSamples: 4
      },
      {
        accountId: 'account-b',
        model: 'k3',
        period: 'off-peak',
        averageTokensPerSecond: 300,
        speedSamples: 1,
        averageFirstTokenMs: 500,
        firstTokenSamples: 1
      }
    ])
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('按账号和模型平均首 token，保留零值并排除未知、失败和中断', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-first-token-stats-'))
  const file = join(dir, 'history.sqlite')
  let history = new RequestHistory(file)
  const start = new Date(2026, 8, 16).getTime()
  const base = {
    time: start,
    group: '',
    account: 'A',
    accountId: 'a',
    model: 'm1',
    status: 200,
    attempts: 1,
    durationMs: 3000,
    firstTokenMs: 100
  }
  try {
    history.append({ ...base, id: 'zero', firstTokenMs: 0 })
    history.append({ ...base, id: 'slow', firstTokenMs: 1200 })
    history.append({ ...base, id: 'unknown', firstTokenMs: null })
    history.append({ ...base, id: 'failed', status: 500, firstTokenMs: 9000 })
    history.append({ ...base, id: 'cancelled', status: 499, firstTokenMs: 8000 })
    history.append({
      ...base,
      id: 'interrupted',
      interruption: 'upstream_disconnect',
      firstTokenMs: 7000
    })
    history.append({ ...base, id: 'invalid', firstTokenMs: -1 })
    history.append({ ...base, id: 'different-model', model: 'm2', firstTokenMs: 2400 })
    history.append({ ...base, id: 'different-account', accountId: 'b', firstTokenMs: 50 })
    history.append({ ...base, id: 'no-sample', model: 'm3', firstTokenMs: null })
    history.append({ ...base, id: 'outside-window', time: start - 1, firstTokenMs: 99999 })
    history.close()
    history = new RequestHistory(file)
    const result = history.usage({ start, end: start + 86400000, bucketMs: 3600000 }).byAccount
    assert.deepEqual(
      result.map(({ accountId, model, averageFirstTokenMs, firstTokenSamples }) => ({
        accountId,
        model,
        averageFirstTokenMs,
        firstTokenSamples
      })),
      [
        { accountId: 'a', model: 'm1', averageFirstTokenMs: 600, firstTokenSamples: 2 },
        { accountId: 'a', model: 'm2', averageFirstTokenMs: 2400, firstTokenSamples: 1 },
        { accountId: 'a', model: 'm3', averageFirstTokenMs: null, firstTokenSamples: 0 },
        { accountId: 'b', model: 'm1', averageFirstTokenMs: 50, firstTokenSamples: 1 }
      ]
    )
    assert.equal(result[0].averageTokensPerSecond, null)
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('北京时间工作日峰谷边界、周末和分时性能统计', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'kimi-period-stats-'))
  const history = new RequestHistory(join(dir, 'history.sqlite'))
  const base = {
    group: '',
    account: 'A',
    accountId: 'a',
    status: 200,
    attempts: 1,
    durationMs: 5000,
    firstTokenMs: 300,
    streamDurationMs: 1000,
    usage: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, cost: null }
  }
  const cases = [
    ['2026-09-14T08:59:59.999+08:00', 'off-peak'],
    ['2026-09-14T09:00:00+08:00', 'peak'],
    ['2026-09-14T11:59:59.999+08:00', 'peak'],
    ['2026-09-14T12:00:00+08:00', 'off-peak'],
    ['2026-09-14T13:59:59.999+08:00', 'off-peak'],
    ['2026-09-14T14:00:00+08:00', 'peak'],
    ['2026-09-14T17:59:59.999+08:00', 'peak'],
    ['2026-09-14T18:00:00+08:00', 'off-peak'],
    ['2026-09-18T10:00:00+08:00', 'peak'],
    ['2026-09-19T10:00:00+08:00', 'off-peak'],
    ['2026-09-20T15:00:00+08:00', 'off-peak']
  ] as const
  try {
    for (const [index, [time]] of cases.entries())
      history.append({
        ...base,
        id: `boundary-${index}`,
        model: `boundary-${index}`,
        time: Date.parse(time)
      })
    history.append({
      ...base,
      id: 'peak-a',
      model: 'weighted',
      time: Date.parse('2026-09-14T09:30:00+08:00'),
      firstTokenMs: 100,
      usage: { ...base.usage, output: 100 }
    })
    history.append({
      ...base,
      id: 'peak-b',
      model: 'weighted',
      time: Date.parse('2026-09-14T14:30:00+08:00'),
      firstTokenMs: 900,
      streamDurationMs: 3000,
      usage: { ...base.usage, output: 60 }
    })
    history.append({
      ...base,
      id: 'valley',
      model: 'weighted',
      time: Date.parse('2026-09-14T12:30:00+08:00'),
      firstTokenMs: 50,
      usage: { ...base.usage, output: 80 }
    })
    const query = {
      start: Date.parse('2026-09-14T00:00:00+08:00'),
      end: Date.parse('2026-09-21T00:00:00+08:00'),
      bucketMs: 3600000
    }
    const rows = history.usage(query).byAccount
    for (const [index, [, period]] of cases.entries())
      assert.equal(rows.find((row) => row.model === `boundary-${index}`)?.period, period)
    const peak = rows.find((row) => row.model === 'weighted' && row.period === 'peak')!
    const valley = rows.find((row) => row.model === 'weighted' && row.period === 'off-peak')!
    assert.equal(peak.averageFirstTokenMs, 500)
    assert.equal(peak.firstTokenSamples, 2)
    assert.equal(peak.averageTokensPerSecond, 40)
    assert.equal(valley.averageFirstTokenMs, 50)
    assert.equal(valley.averageTokensPerSecond, 80)
    const timezone = process.env.TZ
    try {
      process.env.TZ = 'UTC'
      assert.deepEqual(history.usage(query).byAccount, rows)
    } finally {
      if (timezone === undefined) delete process.env.TZ
      else process.env.TZ = timezone
    }
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('热力图默认最近十二个月并支持完整历史，日期边界与未知用量分级正确', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const now = new Date(2026, 0, 2, 13).getTime()
  t.mock.method(Date, 'now', () => now)
  const range = heatmapRange(now)
  const dates: string[] = []
  for (
    const date = new Date(range.start);
    date.getTime() < range.end;
    date.setDate(date.getDate() + 1)
  )
    dates.push(localDayKey(date.getTime()))
  assert.equal(dates[0], '2025-02-01')
  assert.equal(dates.at(-1), '2026-01-02')
  assert.equal(heatmapLevel(null, 100), 0)
  assert.equal(heatmapLevel(0, 100), 0)
  assert.equal(heatmapLevel(25, 100), 1)
  assert.equal(heatmapLevel(100, 100), 4)
  const dir = await mkdtemp(join(tmpdir(), 'kimi-calendar-'))
  const history = new RequestHistory(join(dir, 'history.sqlite'))
  try {
    const time = new Date(2026, 0, 1, 23, 59, 59).getTime()
    const record = {
      id: 'before',
      time,
      group: '',
      account: 'a',
      model: 'k3',
      status: 200,
      attempts: 1,
      durationMs: 100,
      firstTokenMs: 10
    }
    history.append(record)
    history.append({ ...record, id: 'after', time: time + 1000 })
    const result = history.usage({ ...range, bucketMs: 86400000 })
    assert.equal(result.points.length, dates.length)
    assert.equal(result.points.at(-2)!.requests, 1)
    assert.equal(result.points.at(-1)!.requests, 1)
    assert.equal(result.points.at(-1)!.totalTokens, null)
    history.append({ ...record, id: 'older', time: new Date(2023, 0, 15).getTime() })
    const full = history.usage({ ...range, bucketMs: 86400000, allHistory: true })
    assert.equal(localDayKey(full.points[0].time), '2025-02-01')
    assert.equal(full.points.length, dates.length)
    assert.equal(full.summary.requests, 2)
    assert.equal(
      full.points.find((point) => localDayKey(point.time) === '2023-01-15')?.requests,
      undefined
    )
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('usage costs apply current pricing consistently to totals, daily buckets and model details', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-20T00:00:00Z'))
  const dir = await mkdtemp(join(tmpdir(), 'usage-prices-'))
  const history = new RequestHistory(join(dir, 'history.sqlite'))
  try {
    const start = new Date(2026, 8, 16).getTime()
    const price = {
      provider: 'kimi' as const,
      model: 'm',
      currency: 'CNY' as const,
      input: 2,
      output: null,
      cacheRead: null,
      cacheWrite: null
    }
    const pricing = {
      accounts: [],
      modelPrices: [price],
      modelPriceCatalog: {
        entries: [],
        prices: [{ ...price, currency: 'USD' as const, output: 10, tiered: false }],
        updatedAt: 1,
        error: ''
      }
    }
    const record = {
      id: 'one',
      provider: 'kimi' as const,
      accountId: 'a',
      account: 'a',
      model: 'm',
      group: '',
      time: start + 1000,
      status: 200,
      attempts: 1,
      durationMs: 1,
      firstTokenMs: null,
      usage: { input: 1000, output: 100, cacheRead: null, cacheWrite: null, cost: null }
    }
    history.append(record)
    history.append({ ...record, id: 'two', status: 499, usage: { ...record.usage, cost: 0.5 } })
    const query = { start, end: start + 86400000, bucketMs: 86400000 }
    const result = history.usage(query, pricing)
    const expected = [
      { currency: 'USD', value: 0.501 },
      { currency: 'CNY', value: 0.002 }
    ]
    assert.deepEqual(result.summary.costAmounts, expected)
    assert.deepEqual(result.byModel[0].costAmounts, expected)
    assert.deepEqual(result.points[0].costAmounts, expected)
    assert.equal(result.summary.interruptedCostAmounts?.[0].value, 0.5)
    pricing.modelPrices[0].input = 4
    assert.equal(
      history.usage(query, pricing).summary.costAmounts?.find((p) => p.currency === 'CNY')?.value,
      0.004
    )
    assert.equal(history.page().records[1].usage?.cost, null)
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('activity summary counts daily peaks and streaks, and estimates sessions per account', () => {
  const at = (day: number, hour = 10) => new Date(2026, 8, day, hour).getTime()
  const rows = [
    { time: at(12), durationMs: 60000, account: 'a', tokens: 100 },
    { time: at(13), durationMs: 60000, account: 'a', tokens: 200 },
    { time: at(14), durationMs: 60000, account: 'a', tokens: 300 },
    { time: at(14) + 31 * 60000, durationMs: 60000, account: 'a', tokens: 400 },
    { time: at(14) + 40 * 60000, durationMs: 60000, account: 'b', tokens: 500 },
    { time: at(16), durationMs: 60000, account: 'a', tokens: 50 }
  ]
  assert.deepEqual(summarizeActivity(rows, at(16, 12)), {
    totalTokens: 1550,
    peakTokens: 1200,
    longestChatMs: null,
    currentStreak: 1,
    longestStreak: 3
  })
  assert.equal(summarizeActivity(rows, at(15, 12)).currentStreak, 3)
  assert.equal(summarizeActivity(rows, at(18, 12)).currentStreak, 0)
  assert.deepEqual(summarizeActivity([], at(16)), {
    totalTokens: 0,
    peakTokens: 0,
    longestChatMs: null,
    currentStreak: 0,
    longestStreak: 0
  })
})

test('session duration spans days and account switches without sticky expiry', () => {
  const start = new Date(2026, 8, 10, 9).getTime()
  const result = summarizeActivity(
    [
      { time: start, durationMs: 60000, account: 'a', tokens: 1, sessionId: 'session-one' },
      {
        time: start + 48 * 3600000,
        durationMs: 120000,
        account: 'b',
        tokens: 2,
        sessionId: 'session-one'
      },
      { time: start - 86400000, durationMs: 60000, account: 'a', tokens: 1 },
      {
        time: start + 49 * 3600000,
        durationMs: 60000,
        account: 'a',
        tokens: 1,
        sessionId: 'session-two'
      }
    ],
    start + 50 * 3600000
  )
  assert.equal(result.longestChatMs, 48 * 3600000 + 120000)
})

test('cost display omits zero currencies while retaining nonzero mixed amounts and unknown totals', () => {
  assert.equal(
    formatUsageCost({
      cost: null,
      costAmounts: [
        { currency: 'USD', value: 2.402607 },
        { currency: 'CNY', value: 0 }
      ]
    }),
    'USD 2.402607'
  )
  assert.equal(
    formatUsageCost({
      cost: null,
      costAmounts: [
        { currency: 'USD', value: 0 },
        { currency: 'CNY', value: 3 }
      ]
    }),
    'CNY 3.00'
  )
  assert.equal(
    formatUsageCost({
      cost: null,
      costAmounts: [
        { currency: 'USD', value: 2 },
        { currency: 'CNY', value: 3 }
      ]
    }),
    'USD 2.00 + CNY 3.00'
  )
  assert.equal(formatUsageCost({ cost: 0, costAmounts: [{ currency: 'USD', value: 0 }] }), '—')
  assert.equal(formatUsageCost({ cost: 0, costAmounts: [] }), '—')
  assert.equal(formatUsageCost({ cost: 0 }), '—')
  assert.equal(formatUsageCost({ cost: null }), '未知')
  assert.equal(
    formatUsageCost({ cost: null, costAmounts: [{ currency: 'USD', value: 0.0000001 }] }),
    'USD <0.000001'
  )
})
