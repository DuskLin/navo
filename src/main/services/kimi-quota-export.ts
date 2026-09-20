import { hasQuotaDisplay } from '../../shared/quota-display'
import { access, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { KimiDesktopPreferences } from '../../shared/kimi-desktop'
import type { AccountView } from '../../shared/contracts'
import { KimiSessionMetrics } from './kimi-session-metrics'

export const KIMI_QUOTA_ASSETS =
  '/Applications/Kimi Code.app/Contents/Resources/desktop-dist/assets'

// 实验功能：只导出明确列出的展示字段，绝不序列化凭据、请求或网关配置。
export function quotaDisplaySnapshot(
  accounts: Pick<AccountView, 'id' | 'name' | 'provider' | 'enabled' | 'capabilities'>[]
) {
  return {
    exportedAt: Date.now(),
    source: 'Navo',
    accounts: accounts
      .filter((a) => a.enabled && hasQuotaDisplay(a.capabilities))
      .map((a) => ({
        id: a.id,
        name: a.name,
        provider: a.provider ?? 'kimi',
        enabled: a.enabled,
        checkedAt: a.capabilities?.checkedAt ?? null,
        fiveHour: a.capabilities?.quota?.fiveHour ?? null,
        weekly: a.capabilities?.quota?.weekly ?? null,
        monthly: a.capabilities?.quota?.monthly ?? null,
        balance: a.capabilities?.balance
          ? {
              available: a.capabilities.balance.available,
              balances: a.capabilities.balance.balances.map(({ currency, balance }) => ({
                currency,
                balance
              }))
            }
          : null
      }))
  }
}

export function startKimiQuotaExport(
  userData: string,
  accounts: () => Parameters<typeof quotaDisplaySnapshot>[0],
  preferences: () => KimiDesktopPreferences
): () => void {
  let busy = false
  const sessions = new KimiSessionMetrics()
  const tick = async (): Promise<void> => {
    if (busy || process.platform !== 'darwin') return
    busy = true
    try {
      await access(join(userData, 'kimi-quota-experiment.enabled'))
      const target = join(KIMI_QUOTA_ASSETS, 'navo-quota-data.json')
      const metrics =
        preferences().enabled && preferences().sessionStats ? await sessions.snapshot() : {}
      // 读取日志期间用户可能关闭集成，写入前重新确认开关。
      await access(join(userData, 'kimi-quota-experiment.enabled'))
      const current = preferences()
      await writeFile(
        `${target}.tmp`,
        JSON.stringify({
          ...quotaDisplaySnapshot(current.enabled && current.accountQuota ? accounts() : []),
          enabled: current.enabled,
          accountQuota: current.accountQuota,
          sessionStats: current.sessionStats,
          sessions: current.enabled && current.sessionStats ? metrics : {}
        }),
        {
          mode: 0o600
        }
      )
      await rename(`${target}.tmp`, target)
    } catch {
      // 默认关闭；卸载或应用更新期间不影响主业务。
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), 5_000)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
