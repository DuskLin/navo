export interface TokenUsage {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  cost: number | null
}
export type UsageProtocol = 'responses' | 'chat-completions' | 'messages'
export interface UsageQuery {
  receipt?: boolean
  performanceByDay?: boolean
  allHistory?: boolean
  start: number
  end: number
  bucketMs: number
  protocol?: UsageProtocol
  accountId?: string
  model?: string
}
export interface UsageTotals extends TokenUsage {
  costAmounts?: { currency: 'USD' | 'CNY'; value: number }[]
  interruptedCostAmounts?: { currency: 'USD' | 'CNY'; value: number }[]
  averageTokensPerSecond: number | null
  speedSamples: number
  interruptedRequests: number
  interruptionCounts: { client: number; timeout: number; upstream: number; shutdown: number }
  interruptedReported: number
  interruptedTokens: number | null
  interruptedCost: number | null
  requests: number
  reported: number
  totalTokens: number | null
  cacheHitRate: number | null
}
export interface ActivitySummary {
  totalTokens: number
  peakTokens: number
  longestChatMs: number | null
  currentStreak: number
  longestStreak: number
}
export interface UsageStats {
  receipt?: {
    byHarnessModel: (UsageTotals & { harness: string; model: string })[]
    sessionCount: number
    unidentifiedSessionRequests: number
  }
  accountTotals?: { accountId: string; requests: number; totalTokens: number | null }[]
  activity?: ActivitySummary
  byAccount: {
    day?: string
    period: 'peak' | 'off-peak'
    averageFirstTokenMs: number | null
    firstTokenSamples: number
    accountId: string
    model: string
    averageTokensPerSecond: number | null
    speedSamples: number
  }[]
  byModel: (UsageTotals & { model: string })[]
  summary: UsageTotals
  points: (UsageTotals & { time: number })[]
  accounts: { id: string; name: string }[]
  models: string[]
}

export function localDayKey(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function performanceHistoryRange(now = Date.now()) {
  const dayMs = 86400000
  const offset = 8 * 3600000
  const today = Math.floor((now + offset) / dayMs) * dayMs - offset
  return {
    start: today - 29 * dayMs,
    end: now,
    days: Array.from({ length: 30 }, (_, i) =>
      new Date(today - i * dayMs + offset).toISOString().slice(0, 10)
    )
  }
}
export function heatmapRange(now = Date.now()): { start: number; end: number } {
  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(1)
  start.setMonth(start.getMonth() - 11)
  return { start: start.getTime(), end: end.getTime() }
}
export function heatmapLevel(tokens: number | null, maximum: number): number {
  return tokens === null || tokens <= 0
    ? 0
    : Math.min(4, Math.max(1, Math.ceil((tokens / Math.max(1, maximum)) * 4)))
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
/** OpenAI 的 input 包含缓存，Anthropic 的 input 不包含缓存。 */
export function parseUsage(value: unknown, protocol: UsageProtocol): Partial<TokenUsage> | null {
  const root = object(value)
  const u = object(object(root.response).usage ?? object(root.message).usage ?? root.usage)
  if (!Object.keys(u).length) return null
  const input = count(u.input_tokens ?? u.prompt_tokens)
  const output = count(u.output_tokens ?? u.completion_tokens)
  const read = count(
    u.cache_read_input_tokens ??
      u.prompt_cache_hit_tokens ??
      object(u.input_tokens_details ?? u.prompt_tokens_details).cached_tokens
  )
  const write = count(u.cache_creation_input_tokens)
  const result: Partial<TokenUsage> = {}
  if (input !== null)
    result.input = protocol === 'messages' ? input : Math.max(0, input - (read ?? 0) - (write ?? 0))
  if (output !== null) result.output = output
  if (read !== null) result.cacheRead = read
  if (write !== null) result.cacheWrite = write
  const cost = u.cost_usd ?? u.total_cost_usd
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) result.cost = cost
  return Object.keys(result).length ? result : null
}

export function formatUsageCost(totals: Pick<UsageTotals, 'cost' | 'costAmounts'>): string {
  if (totals.costAmounts) {
    const amounts = totals.costAmounts.filter((amount) => amount.value !== 0)
    return amounts.length
      ? amounts
          .map(
            (p) =>
              `${p.currency} ${p.value > 0 && p.value < 0.000001 ? '<0.000001' : p.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
          )
          .join(' + ')
      : '—'
  }
  return totals.cost == null ? '未知' : totals.cost === 0 ? '—' : `USD ${totals.cost.toFixed(4)}`
}

export function summarizeActivity(
  records: {
    time: number
    durationMs: number
    account: string
    tokens: number
    sessionId?: string | null
  }[],
  now = Date.now()
): ActivitySummary {
  const days = new Map<string, number>()
  const sessions = new Map<string, { start: number; end: number }>()
  let totalTokens = 0
  let longestChatMs: number | null = null
  for (const record of [...records].sort((a, b) => a.time - b.time)) {
    if (!Number.isFinite(record.time) || record.time > now) continue
    const tokens = Number.isFinite(record.tokens) ? Math.max(0, record.tokens) : 0
    const day = localDayKey(record.time)
    days.set(day, (days.get(day) ?? 0) + tokens)
    totalTokens += tokens
    const end =
      record.time + (Number.isFinite(record.durationMs) ? Math.max(0, record.durationMs) : 0)
    if (record.sessionId) {
      const previous = sessions.get(record.sessionId)
      const session = previous
        ? { start: previous.start, end: Math.max(previous.end, end) }
        : { start: record.time, end }
      sessions.set(record.sessionId, session)
      longestChatMs = Math.max(longestChatMs ?? 0, session.end - session.start)
    }
  }
  let longestStreak = 0,
    streak = 0,
    previousDay = ''
  for (const day of [...days.keys()].sort()) {
    const yesterday = new Date(`${day}T12:00:00`)
    yesterday.setDate(yesterday.getDate() - 1)
    streak = localDayKey(+yesterday) === previousDay ? streak + 1 : 1
    longestStreak = Math.max(longestStreak, streak)
    previousDay = day
  }
  const cursor = new Date(now)
  cursor.setHours(12, 0, 0, 0)
  if (!days.has(localDayKey(+cursor))) cursor.setDate(cursor.getDate() - 1)
  let currentStreak = 0
  while (days.has(localDayKey(+cursor))) {
    currentStreak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return {
    totalTokens,
    peakTokens: Math.max(0, ...days.values()),
    longestChatMs,
    currentStreak,
    longestStreak
  }
}
