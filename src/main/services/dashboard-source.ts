import { hasQuotaDisplay } from '../../shared/quota-display'
import type { Gateway } from './gateway'
import type { UsageService } from './usage-service'
import type { Provider } from '../../shared/contracts'
import type { DashboardAccount, DashboardSnapshot } from '../../shared/dashboard'
import { storedQuota } from '../../shared/kimi-quota'

const providerLabels: Record<Provider, DashboardAccount['provider']> = {
  custom: '自定义供应商',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  'opencode-go': 'Go',
  minimax: 'MiniMax',
  codex: 'Codex'
}

/** Explicit projection: never return a desktop snapshot, request records or credentials. */
export function dashboardSource(gateway: Gateway, usage: UsageService) {
  const cache = new Map<string, { at: number; work: Promise<DashboardSnapshot> }>()
  return (selected = ''): Promise<DashboardSnapshot> => {
    const data = gateway.store.get()
    if (selected && !data.accounts.some((a) => a.id === selected)) throw new Error('账号不存在')
    const cached = cache.get(selected)
    if (cached && Date.now() - cached.at < 5000) return cached.work
    const at = Date.now()
    const work = (async (): Promise<DashboardSnapshot> => {
      const today = new Date(at)
      today.setHours(0, 0, 0, 0)
      const hour = 3600000
      const start = Math.floor(at / hour) * hour - 23 * hour
      const [daily, trend] = await Promise.all([
        usage.usage({ start: +today, end: at, bucketMs: hour }),
        usage.usage({
          start,
          end: at,
          bucketMs: hour,
          ...(selected ? { accountId: selected } : {})
        })
      ])
      const current = gateway.store.get()
      const now = Date.now()
      const accounts = current.accounts
        .filter((a) => hasQuotaDisplay(a.capabilities))
        .map((a) => {
          const runtime = gateway.scheduler.state(a.id)
          const cap = a.capabilities
          const rows = (daily.accountTotals ?? []).filter((row) => row.accountId === a.id)
          return {
            id: a.id,
            name: a.name,
            provider: providerLabels[a.provider ?? 'kimi'],
            quota: storedQuota(cap?.quota),
            ...(cap?.balance
              ? {
                  balance: {
                    available: cap.balance.available,
                    balances: cap.balance.balances.map((b) => ({
                      currency: b.currency,
                      balance: b.balance
                    }))
                  }
                }
              : {}),
            checkedAt: cap?.checkedAt ?? 0,
            status: !a.enabled
              ? ('disabled' as const)
              : runtime.authFailed
                ? ('error' as const)
                : !cap || now - cap.checkedAt > 120000
                  ? ('stale' as const)
                  : cap.quota?.fiveHour?.remaining === 0 ||
                      cap.quota?.weekly?.remaining === 0 ||
                      cap.quota?.monthly?.remaining === 0 ||
                      cap.balance?.available === false
                    ? ('exhausted' as const)
                    : ('available' as const),
            requests: rows.reduce((n, r) => n + (r.requests ?? 0), 0),
            tokens: rows.reduce((n, r) => n + (r.totalTokens ?? 0), 0),
            active: runtime.active
          }
        })
      const order = current.quotaCardOrder
      accounts.sort(
        (a, b) =>
          (order.indexOf(a.id) < 0 ? Infinity : order.indexOf(a.id)) -
          (order.indexOf(b.id) < 0 ? Infinity : order.indexOf(b.id))
      )
      return {
        accounts,
        generatedAt: now,
        points: Array.from({ length: 24 }, (_, i) => {
          const time = start + i * hour
          return { time, tokens: trend.points.find((p) => p.time === time)?.totalTokens ?? 0 }
        }),
        totals: {
          requests: daily.summary.requests,
          tokens: daily.summary.totalTokens,
          active: current.accounts.reduce((n, a) => n + gateway.scheduler.state(a.id).active, 0)
        },
        tunnel: 'off'
      }
    })().catch((error) => {
      cache.delete(selected)
      throw error
    })
    if (cache.size >= 32) cache.delete(cache.keys().next().value!)
    cache.set(selected, { at, work })
    return work
  }
}
