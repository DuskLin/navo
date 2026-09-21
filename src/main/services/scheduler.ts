import { createHash } from 'node:crypto'
import type { AccountRuntime } from '../../shared/contracts'
import { hasCommandCodeExtraCredits, remainingRatio } from '../../shared/kimi-quota'
import type { StoredAccount, StoredGroup } from './gateway-store'

export class Scheduler {
  private states = new Map<string, AccountRuntime>()
  private sticky = new Map<string, { accountId: string; expires: number }>()
  constructor(private readonly now = Date.now) {}
  state(id: string): AccountRuntime {
    let state = this.states.get(id)
    if (!state) {
      state = {
        active: 0,
        requests: 0,
        successes: 0,
        failures: 0,
        cooldownUntil: 0,
        authFailed: false,
        lastError: '',
        lastUsed: 0,
        latencyMs: 0
      }
      this.states.set(id, state)
    }
    return state
  }
  reset(id: string): void {
    const state = this.state(id)
    state.cooldownUntil = 0
    state.authFailed = false
    state.lastError = ''
    for (const [key, value] of this.sticky) if (value.accountId === id) this.sticky.delete(key)
  }
  prune(accounts: StoredAccount[]): void {
    const ids = new Set(accounts.map((a) => a.id))
    for (const [id, state] of this.states)
      if (!ids.has(id) && state.active === 0) this.states.delete(id)
    for (const [key, value] of this.sticky)
      if (!ids.has(value.accountId) || value.expires <= this.now()) this.sticky.delete(key)
  }
  private sessionKey(group: StoredGroup, model: string, session: string): string {
    return createHash('sha256')
      .update(JSON.stringify([group.id, model, session]))
      .digest('hex')
  }
  acquire(
    accounts: StoredAccount[],
    group: StoredGroup,
    model: string,
    session: string,
    excluded: Set<string>
  ): { account: StoredAccount; release: () => void } | undefined {
    const now = this.now()
    if (!group.enabled) return
    for (const [key, value] of this.sticky) if (value.expires <= now) this.sticky.delete(key)
    const candidates = accounts.flatMap((account) => {
      const membership = account.memberships.find((m) => m.groupId === group.id)
      const state = this.state(account.id)
      if (
        !membership ||
        !account.enabled ||
        !account.credential.accessToken ||
        !account.capabilities ||
        account.capabilities.balance?.available === false ||
        excluded.has(account.id) ||
        state.authFailed ||
        state.cooldownUntil > now ||
        state.active >= account.maxConcurrency ||
        (model && !account.models.includes(model))
      )
        return []
      const fiveHour = remainingRatio(
        account.capabilities.quota?.fiveHour,
        account.capabilities.checkedAt,
        now
      )
      const weekly = remainingRatio(
        account.capabilities.quota?.weekly,
        account.capabilities.checkedAt,
        now
      )
      const monthly = remainingRatio(
        account.capabilities.quota?.monthly,
        account.capabilities.checkedAt,
        now
      )
      if (
        (fiveHour === 0 || weekly === 0 || monthly === 0) &&
        !hasCommandCodeExtraCredits(
          account.provider,
          account.capabilities.quota,
          account.capabilities.checkedAt,
          now
        )
      )
        return []
      return [{ account, state, fiveHour, weekly, score: 0 }]
    })
    if (!candidates.length) return
    // 未知额度取候选账号已知比例的中位数；全部未知时取中性值，按并发均衡。
    const median = (values: (number | null)[]): number => {
      const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b)
      const middle = Math.floor(known.length / 2)
      return known.length ? (known[middle] + known[Math.floor((known.length - 1) / 2)]) / 2 : 0.5
    }
    const fiveFallback = median(candidates.map((c) => c.fiveHour))
    const weeklyFallback = median(candidates.map((c) => c.weekly))
    for (const candidate of candidates) {
      const idle = 1 - (candidate.state.active + 1) / candidate.account.maxConcurrency
      candidate.score =
        0.5 * idle +
        0.25 * (candidate.fiveHour ?? fiveFallback) +
        0.25 * (candidate.weekly ?? weeklyFallback)
    }
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        a.state.active - b.state.active ||
        a.state.lastUsed - b.state.lastUsed ||
        a.state.requests - b.state.requests
    )
    const stickyKey = this.sessionKey(group, model, session)
    const bound = session && group.stickySeconds ? this.sticky.get(stickyKey) : undefined
    const preferred = candidates.find((c) => c.account.id === bound?.accountId)
    // 缓存命中优先：绑定账号仍可用就复用，评分仅用于首次分配和故障转移。
    const selected = preferred ?? candidates[0]
    if (session && group.stickySeconds) {
      if (this.sticky.size >= 10000) this.sticky.delete(this.sticky.keys().next().value!)
      this.sticky.set(stickyKey, {
        accountId: selected.account.id,
        expires: now + group.stickySeconds * 1000
      })
    }
    const state = selected.state
    state.active++
    state.requests++
    state.lastUsed = now
    let released = false
    return {
      account: selected.account,
      release: () => {
        if (!released) {
          state.active--
          released = true
        }
      }
    }
  }
  success(id: string, latencyMs: number): void {
    const state = this.state(id)
    state.successes++
    state.latencyMs = latencyMs
    // 其他并发请求已经触发的熔断不能被迟到的成功响应清除。
    if (!state.authFailed && state.cooldownUntil <= this.now()) state.lastError = ''
  }
  failure(id: string, status: number, cooldownSeconds: number, retryAfter?: string | null): void {
    const state = this.state(id)
    state.failures++
    state.lastError =
      status === 401 || status === 403
        ? `认证失败 (${status})，请更新凭据后恢复`
        : status === 429
          ? '触发上游限流，冷却后重试'
          : status === 0
            ? '连接失败或请求超时'
            : `上游返回 ${status}`
    if (status === 401 || status === 403) state.authFailed = true
    if (status === 0 || status === 408 || status === 429 || status >= 500) {
      const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN
      const until = Number.isFinite(seconds)
        ? this.now() + seconds * 1000
        : retryAfter
          ? Date.parse(retryAfter)
          : NaN
      state.cooldownUntil = Math.max(
        state.cooldownUntil,
        this.now() + cooldownSeconds * 1000,
        Number.isFinite(until) ? Math.min(until, this.now() + 86400000) : 0
      )
    }
    if (state.authFailed || state.cooldownUntil > this.now()) {
      for (const [key, value] of this.sticky) if (value.accountId === id) this.sticky.delete(key)
    }
  }
}
