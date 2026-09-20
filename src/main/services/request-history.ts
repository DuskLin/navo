import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RequestHistoryPage, RequestRecord } from '../../shared/contracts'
import type { UsageQuery, UsageStats, UsageTotals } from '../../shared/usage'
import { requestCost, type RequestPricing } from '../../shared/request-cost'
import { localDayKey, summarizeActivity } from '../../shared/usage'
import type { QuotaCostCycle, QuotaCostEstimate, QuotaCycleQuery } from '../../shared/quota-cost'

function cycleQuery(value: unknown): QuotaCycleQuery {
  if (!value || typeof value !== 'object') throw new Error('周期查询无效')
  const query = value as QuotaCycleQuery
  if (
    typeof query.accountId !== 'string' ||
    !query.accountId ||
    query.accountId.length > 200 ||
    !['fiveHour', 'weekly'].includes(query.window)
  )
    throw new Error('周期查询无效')
  return query
}

const REQUEST_RETENTION_MS = 90 * 86400000

/** 仅保留最近 90 天的请求摘要；按游标分页，避免将全部历史加载进内存。 */
export class RequestHistory {
  private cleanupTimer?: ReturnType<typeof setInterval>
  private db: DatabaseSync
  private quotaRecords = new Map<string, { start: number; end: number; records: RequestRecord[] }>()
  constructor(file: string, readOnly = false) {
    if (readOnly) {
      this.db = new DatabaseSync(file, { readOnly: true })
      return
    }
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS quota_cost_cycles (
        account_id TEXT NOT NULL,
        window TEXT NOT NULL,
        reset_at TEXT NOT NULL,
        checked_at REAL NOT NULL,
        amounts TEXT NOT NULL,
        excluded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, window, reset_at)
      );
      CREATE TABLE IF NOT EXISTS requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_time ON requests(json_extract(record, '$.time'));
      CREATE INDEX IF NOT EXISTS requests_quota_usage ON requests(json_extract(record, '$.accountId'), json_extract(record, '$.time'));
      CREATE INDEX IF NOT EXISTS requests_model ON requests(json_extract(record, '$.model'));
      CREATE INDEX IF NOT EXISTS requests_account ON requests(COALESCE(json_extract(record, '$.accountId'), json_extract(record, '$.account')), json_extract(record, '$.account'));
    `)
    if (
      !this.db
        .prepare('PRAGMA table_info(quota_cost_cycles)')
        .all()
        .some((row) => row.name === 'excluded')
    )
      this.db.exec('ALTER TABLE quota_cost_cycles ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0')
    this.prune()
    this.cleanupTimer = setInterval(() => this.prune(), 60 * 60 * 1000)
    this.cleanupTimer.unref()
  }
  private prune(): void {
    const result = this.db
      .prepare("DELETE FROM requests WHERE json_extract(record, '$.time') < ?")
      .run(Date.now() - REQUEST_RETENTION_MS)
    if (result.changes) this.quotaRecords.clear()
  }
  append(record: RequestRecord): void {
    this.prune()
    if (record.time < Date.now() - REQUEST_RETENTION_MS) return
    this.db
      .prepare('INSERT INTO requests (id, record) VALUES (?, ?)')
      .run(record.id, JSON.stringify(record))
    this.quotaRecords.clear()
  }
  quotaUsage(accountId: string, start: number, end: number): RequestRecord[] {
    const key = `${accountId}:${start}`
    const cached = this.quotaRecords.get(key)
    if (cached?.start === start && cached.end === end) return cached.records
    const records = this.db
      .prepare(
        "SELECT record FROM requests WHERE json_extract(record, '$.accountId') = ? AND json_extract(record, '$.time') >= ? AND json_extract(record, '$.time') <= ?"
      )
      .all(accountId, start, end)
      .map((row) => JSON.parse(String(row.record)) as RequestRecord)
    if (this.quotaRecords.size >= 100) this.quotaRecords.clear()
    this.quotaRecords.set(key, { start, end, records })
    return records
  }
  quotaAverages(
    accountId: string,
    window: 'fiveHour' | 'weekly',
    resetAt: string | null | undefined,
    checkedAt: number,
    estimate: QuotaCostEstimate
  ): NonNullable<QuotaCostEstimate['averages']> {
    const valid =
      estimate.amounts.length > 0 &&
      estimate.amounts.every((amount) => Number.isFinite(amount.total) && amount.total > 0)
    if (valid && resetAt && Number.isFinite(Date.parse(resetAt)) && Number.isFinite(checkedAt)) {
      // One latest valid observation per cycle. Repeated refreshes must not increase its weight.
      this.db
        .prepare(
          `
        INSERT INTO quota_cost_cycles (account_id, window, reset_at, checked_at, amounts)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, window, reset_at) DO UPDATE SET
          checked_at = excluded.checked_at, amounts = excluded.amounts
        WHERE excluded.checked_at >= quota_cost_cycles.checked_at
          AND (excluded.checked_at != quota_cost_cycles.checked_at OR excluded.amounts != quota_cost_cycles.amounts)
      `
        )
        .run(
          accountId,
          window,
          new Date(resetAt).toISOString(),
          checkedAt,
          JSON.stringify(estimate.amounts.map(({ currency, total }) => ({ currency, total })))
        )
    }
    return this.db
      .prepare(
        `
      SELECT json_extract(value, '$.currency') AS currency,
             AVG(json_extract(value, '$.total')) AS total, COUNT(*) AS cycles
      FROM quota_cost_cycles, json_each(quota_cost_cycles.amounts)
      WHERE account_id = ? AND window = ? AND excluded = 0
      GROUP BY currency ORDER BY currency
    `
      )
      .all(accountId, window)
      .map((row) => ({
        currency: String(row.currency) as 'USD' | 'CNY',
        total: Number(row.total),
        cycles: Number(row.cycles)
      }))
  }
  getQuotaCycles(value: unknown): QuotaCostCycle[] {
    const query = cycleQuery(value)
    return this.db
      .prepare(
        `
      SELECT reset_at, checked_at, amounts, excluded FROM quota_cost_cycles
      WHERE account_id = ? AND window = ? ORDER BY reset_at DESC
    `
      )
      .all(query.accountId, query.window)
      .map((row) => ({
        resetAt: String(row.reset_at),
        checkedAt: Number(row.checked_at),
        excluded: row.excluded === 1,
        amounts: JSON.parse(String(row.amounts)) as QuotaCostCycle['amounts']
      }))
  }
  setQuotaCycleExcluded(value: unknown): void {
    const query = cycleQuery(value)
    const input = value as { resetAt?: unknown; excluded?: unknown }
    if (
      typeof input.resetAt !== 'string' ||
      !Number.isFinite(Date.parse(input.resetAt)) ||
      typeof input.excluded !== 'boolean'
    )
      throw new Error('周期排除设置无效')
    const result = this.db
      .prepare(
        `
      UPDATE quota_cost_cycles SET excluded = ? WHERE account_id = ? AND window = ? AND reset_at = ?
    `
      )
      .run(
        input.excluded ? 1 : 0,
        query.accountId,
        query.window,
        new Date(input.resetAt).toISOString()
      )
    if (!result.changes) throw new Error('周期记录不存在，请刷新后重试')
  }
  page(before?: number): RequestHistoryPage {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new Error('请求记录游标无效')
    if (this.cleanupTimer) this.prune()
    const rows = (
      before === undefined
        ? this.db.prepare('SELECT seq, record FROM requests ORDER BY seq DESC LIMIT 11').all()
        : this.db
            .prepare('SELECT seq, record FROM requests WHERE seq < ? ORDER BY seq DESC LIMIT 11')
            .all(before)
    ) as { seq: number; record: string }[]
    const records = rows.slice(0, 10)
    return {
      records: records.map((row) => JSON.parse(row.record) as RequestRecord),
      nextCursor: rows.length > 10 ? records.at(-1)!.seq : null,
      total: Number(this.db.prepare('SELECT COUNT(*) AS total FROM requests').get()!.total)
    }
  }
  close(): void {
    clearInterval(this.cleanupTimer)
    this.db.close()
  }
  get dataVersion(): number {
    return Number(this.db.prepare('PRAGMA data_version').get()!.data_version)
  }
  usageSnapshot(query: UsageQuery, pricing?: RequestPricing): UsageStats {
    this.db.exec('BEGIN')
    try {
      return this.usage(query, pricing)
    } finally {
      this.db.exec('ROLLBACK')
    }
  }
  usage(query: UsageQuery, pricing?: RequestPricing): UsageStats {
    const costs = new Map<string, string>()
    if (pricing)
      this.db.function('request_cost', (raw) => {
        const key = String(raw)
        let value = costs.get(key)
        if (value === undefined) {
          const calculated = requestCost(JSON.parse(key) as RequestRecord, pricing)
          value = JSON.stringify(
            Object.fromEntries(calculated.amounts.map((p) => [p.currency, p.value]))
          )
          costs.set(key, value)
        }
        return value
      })
    const usdCost = pricing
      ? "json_extract(request_cost(record), '$.USD')"
      : "json_extract(record, '$.usage.cost')"
    const cnyCost = pricing ? "json_extract(request_cost(record), '$.CNY')" : 'NULL'

    if (query?.allHistory !== undefined && typeof query.allHistory !== 'boolean')
      throw new Error('统计时间范围无效')
    if (
      !query ||
      !Number.isSafeInteger(query.start) ||
      !Number.isSafeInteger(query.end) ||
      query.start < 0 ||
      query.end <= query.start ||
      query.end - query.start > 366 * 86400000 ||
      ![3600000, 86400000].includes(query.bucketMs) ||
      (query.end - query.start) / query.bucketMs > 366
    )
      throw new Error('统计时间范围无效')
    const tokensKnown =
      "(json_extract(record, '$.usage.input') IS NOT NULL OR json_extract(record, '$.usage.output') IS NOT NULL OR json_extract(record, '$.usage.cacheRead') IS NOT NULL OR json_extract(record, '$.usage.cacheWrite') IS NOT NULL)"
    if (query.allHistory && query.bucketMs === 86400000) {
      const earliest = this.db
        .prepare(
          `SELECT MIN(json_extract(record, '$.time')) AS time FROM requests WHERE ${tokensKnown}`
        )
        .get()!
      if (earliest.time != null && Number(earliest.time) < query.start) {
        const start = new Date(Number(earliest.time))
        start.setHours(0, 0, 0, 0)
        start.setDate(1)
        query = { ...query, start: start.getTime() }
      }
    }
    for (const value of [query.accountId, query.model])
      if (value !== undefined && (typeof value !== 'string' || value.length > 200))
        throw new Error('统计筛选条件无效')
    if (query.protocol && !['responses', 'chat-completions', 'messages'].includes(query.protocol))
      throw new Error('统计来源无效')
    const values: (number | string)[] = [query.start, query.end]
    // Unknown token usage must not contribute to any dashboard statistics. Zero is known.
    let where = `WHERE ${tokensKnown} AND json_extract(record, '$.time') >= ? AND json_extract(record, '$.time') < ?`
    for (const [field, value] of [
      ['accountId', query.accountId],
      ['model', query.model],
      ['protocol', query.protocol]
    ] as const) {
      if (value) {
        where +=
          field === 'accountId'
            ? " AND COALESCE(json_extract(record, '$.accountId'), json_extract(record, '$.account')) = ?"
            : ` AND json_extract(record, '$.${field}') = ?`
        values.push(value)
      }
    }
    const speedEligible =
      "json_extract(record, '$.status') >= 200 AND json_extract(record, '$.status') < 300 AND json_extract(record, '$.interruption') IS NULL AND json_extract(record, '$.streamDurationMs') > 0 AND json_extract(record, '$.usage.output') IS NOT NULL"
    const tokenSum =
      "COALESCE(json_extract(record, '$.usage.input'), 0) + COALESCE(json_extract(record, '$.usage.output'), 0) + COALESCE(json_extract(record, '$.usage.cacheRead'), 0) + COALESCE(json_extract(record, '$.usage.cacheWrite'), 0)"
    const clientInterrupted =
      "(json_extract(record, '$.interruption') = 'client_disconnect' OR (json_type(record, '$.interruption') IS NULL AND json_extract(record, '$.status') = 499))"
    const interrupted = `(${clientInterrupted} OR json_extract(record, '$.interruption') IN ('timeout', 'upstream_disconnect', 'upstream_error', 'gateway_shutdown'))`
    const aggregate = `COUNT(*) AS requests,
      SUM(CASE WHEN ${clientInterrupted} THEN 1 ELSE 0 END) AS interruptedClient,
      SUM(CASE WHEN json_extract(record, '$.interruption') = 'timeout' THEN 1 ELSE 0 END) AS interruptedTimeout,
      SUM(CASE WHEN json_extract(record, '$.interruption') IN ('upstream_disconnect', 'upstream_error') THEN 1 ELSE 0 END) AS interruptedUpstream,
      SUM(CASE WHEN json_extract(record, '$.interruption') = 'gateway_shutdown' THEN 1 ELSE 0 END) AS interruptedShutdown,
      SUM(CASE WHEN ${speedEligible} THEN json_extract(record, '$.usage.output') ELSE 0 END) AS speedOutput,
      SUM(CASE WHEN ${speedEligible} THEN json_extract(record, '$.streamDurationMs') ELSE 0 END) AS speedMs,
      SUM(CASE WHEN ${speedEligible} THEN 1 ELSE 0 END) AS speedSamples,
      SUM(CASE WHEN ${interrupted} THEN 1 ELSE 0 END) AS interruptedRequests,
      SUM(CASE WHEN ${interrupted} AND ${tokensKnown} THEN 1 ELSE 0 END) AS interruptedReported,
      SUM(CASE WHEN ${interrupted} AND ${tokensKnown} THEN ${tokenSum} ELSE NULL END) AS interruptedTokens,
      SUM(CASE WHEN ${interrupted} THEN ${usdCost} ELSE NULL END) AS interruptedCost,
      SUM(CASE WHEN ${interrupted} THEN ${cnyCost} ELSE NULL END) AS interruptedCostCny,
      SUM(CASE WHEN json_type(record, '$.usage') = 'object' THEN 1 ELSE 0 END) AS reported,
      SUM(json_extract(record, '$.usage.input')) AS input,
      SUM(json_extract(record, '$.usage.output')) AS output,
      SUM(json_extract(record, '$.usage.cacheRead')) AS cacheRead,
      SUM(json_extract(record, '$.usage.cacheWrite')) AS cacheWrite,
      SUM(${usdCost}) AS cost, SUM(${cnyCost}) AS costCny`
    const totals = (row: Record<string, unknown>): UsageTotals => {
      const num = (key: string): number | null => (row[key] == null ? null : Number(row[key]))
      const input = num('input'),
        output = num('output'),
        cacheRead = num('cacheRead'),
        cacheWrite = num('cacheWrite')
      const known = [input, output, cacheRead, cacheWrite].some((v) => v !== null)
      const denominator = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      return {
        averageTokensPerSecond:
          Number(row.speedMs ?? 0) > 0
            ? (Number(row.speedOutput) * 1000) / Number(row.speedMs)
            : null,
        speedSamples: Number(row.speedSamples ?? 0),
        interruptedRequests: Number(row.interruptedRequests ?? 0),
        interruptionCounts: {
          client: Number(row.interruptedClient ?? 0),
          timeout: Number(row.interruptedTimeout ?? 0),
          upstream: Number(row.interruptedUpstream ?? 0),
          shutdown: Number(row.interruptedShutdown ?? 0)
        },
        interruptedReported: Number(row.interruptedReported ?? 0),
        interruptedTokens: num('interruptedTokens'),
        interruptedCost: num('interruptedCost'),
        requests: Number(row.requests ?? 0),
        reported: Number(row.reported ?? 0),
        input,
        output,
        cacheRead,
        cacheWrite,
        cost: num('cost'),
        ...(pricing
          ? {
              costAmounts: [
                ...(num('cost') !== null
                  ? [{ currency: 'USD' as const, value: num('cost')! }]
                  : []),
                ...(num('costCny') !== null
                  ? [{ currency: 'CNY' as const, value: num('costCny')! }]
                  : [])
              ],
              interruptedCostAmounts: [
                ...(num('interruptedCost') !== null
                  ? [{ currency: 'USD' as const, value: num('interruptedCost')! }]
                  : []),
                ...(num('interruptedCostCny') !== null
                  ? [{ currency: 'CNY' as const, value: num('interruptedCostCny')! }]
                  : [])
              ]
            }
          : {}),
        totalTokens: known
          ? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
          : null,
        cacheHitRate: cacheRead !== null && denominator > 0 ? cacheRead / denominator : null
      }
    }
    const summary = totals(
      this.db.prepare(`SELECT ${aggregate} FROM requests ${where}`).get(...values)!
    )
    const rows = this.db
      .prepare(
        `SELECT CAST((json_extract(record, '$.time') - ?) / ? AS INTEGER) AS bucket, ${aggregate} FROM requests ${where} GROUP BY bucket ORDER BY bucket`
      )
      .all(query.start, query.bucketMs, ...values)
    const buckets = new Map(rows.map((row) => [Number(row.bucket), totals(row)]))
    let points = Array.from(
      { length: Math.ceil((query.end - query.start) / query.bucketMs) },
      (_, i) => ({ ...totals({}), ...buckets.get(i), time: query.start + i * query.bucketMs })
    )
    if (query.bucketMs === 86400000) {
      // 本地自然日分桶，避免夏令时的 23/25 小时日偏移。
      const days = this.db
        .prepare(
          `SELECT date(json_extract(record, '$.time') / 1000, 'unixepoch', 'localtime') AS day, ${aggregate} FROM requests ${where} GROUP BY day`
        )
        .all(...values)
      const daily = new Map(days.map((row) => [String(row.day), totals(row)]))
      points = []
      for (
        const date = new Date(query.start);
        date.getTime() < query.end;
        date.setDate(date.getDate() + 1)
      ) {
        points.push({
          ...totals({}),
          ...daily.get(localDayKey(date.getTime())),
          time: date.getTime()
        })
      }
    }
    const accounts = this.db
      .prepare(
        `SELECT COALESCE(json_extract(record, '$.accountId'), json_extract(record, '$.account')) AS id, MAX(json_extract(record, '$.account')) AS name FROM requests WHERE ${tokensKnown} AND json_extract(record, '$.account') != '' GROUP BY id ORDER BY name`
      )
      .all() as { id: string; name: string }[]
    const models = this.db
      .prepare(
        `SELECT DISTINCT json_extract(record, '$.model') AS model FROM requests WHERE ${tokensKnown} AND json_extract(record, '$.model') != '' ORDER BY model`
      )
      .all()
      .map((row) => String(row.model))
    const byModel = this.db
      .prepare(
        `SELECT json_extract(record, '$.model') AS model, ${aggregate} FROM requests ${where} GROUP BY model ORDER BY requests DESC`
      )
      .all(...values)
      .map((row) => ({ ...totals(row), model: String(row.model || '未知模型') }))
    if (query.performanceByDay !== undefined && typeof query.performanceByDay !== 'boolean')
      throw new Error('每日模型表现参数无效')
    const performanceDay = query.performanceByDay
      ? "date(json_extract(record, '$.time') / 1000, 'unixepoch', '+8 hours') AS day, "
      : ''
    const firstTokenEligible =
      "json_extract(record, '$.status') >= 200 AND json_extract(record, '$.status') < 300 AND json_extract(record, '$.interruption') IS NULL AND json_type(record, '$.firstTokenMs') IN ('integer', 'real') AND json_extract(record, '$.firstTokenMs') >= 0"
    const weekday =
      "CAST(strftime('%w', json_extract(record, '$.time') / 1000, 'unixepoch', '+8 hours') AS INTEGER)"
    const hour =
      "CAST(strftime('%H', json_extract(record, '$.time') / 1000, 'unixepoch', '+8 hours') AS INTEGER)"
    const period = `CASE WHEN ${weekday} BETWEEN 1 AND 5 AND ((${hour} >= 9 AND ${hour} < 12) OR (${hour} >= 14 AND ${hour} < 18)) THEN 'peak' ELSE 'off-peak' END`
    const byAccount = this.db
      .prepare(
        `SELECT ${performanceDay}json_extract(record, '$.accountId') AS accountId, COALESCE(NULLIF(json_extract(record, '$.model'), ''), '未知模型') AS model, ${period} AS period, AVG(CASE WHEN ${firstTokenEligible} THEN json_extract(record, '$.firstTokenMs') END) AS averageFirstTokenMs, COUNT(CASE WHEN ${firstTokenEligible} THEN 1 END) AS firstTokenSamples, ${aggregate} FROM requests ${where} AND json_extract(record, '$.accountId') IS NOT NULL GROUP BY accountId, model, period${query.performanceByDay ? ', day' : ''} ORDER BY ${query.performanceByDay ? 'day DESC, ' : ''}accountId, model, period`
      )
      .all(...values)
      .map((row) => {
        const summary = totals(row)
        return {
          ...(query.performanceByDay ? { day: String(row.day) } : {}),
          accountId: String(row.accountId),
          model: String(row.model),
          period: row.period === 'peak' ? ('peak' as const) : ('off-peak' as const),
          averageFirstTokenMs:
            row.averageFirstTokenMs == null ? null : Number(row.averageFirstTokenMs),
          firstTokenSamples: Number(row.firstTokenSamples),
          averageTokensPerSecond: summary.averageTokensPerSecond,
          requests: summary.requests,
          totalTokens: summary.totalTokens,
          speedSamples: summary.speedSamples
        }
      })
    const activity =
      query.allHistory && query.bucketMs === 86400000
        ? summarizeActivity(
            this.db
              .prepare(
                `SELECT json_extract(record, '$.time') AS time, json_extract(record, '$.durationMs') AS durationMs, json_extract(record, '$.sessionId') AS sessionId, COALESCE(json_extract(record, '$.accountId'), json_extract(record, '$.account'), '') AS account, ${tokenSum} AS tokens FROM requests ${where} AND COALESCE(json_extract(record, '$.model'), '') != ''`
              )
              .all(...values)
              .map((row) => ({
                time: Number(row.time),
                durationMs: Number(row.durationMs ?? 0),
                sessionId: row.sessionId == null ? undefined : String(row.sessionId),
                account: String(row.account),
                tokens: Number(row.tokens)
              })),
            Math.min(Date.now(), query.end - 1)
          )
        : undefined
    costs.clear()
    return {
      summary,
      points,
      accounts,
      models,
      byModel,
      byAccount: byAccount.map(
        ({ requests: _requests, totalTokens: _tokens, ...performance }) => performance
      ),
      accountTotals: byAccount.map(({ accountId, requests, totalTokens }) => ({
        accountId,
        requests,
        totalTokens
      })),
      ...(activity ? { activity } : {})
    }
  }
}
