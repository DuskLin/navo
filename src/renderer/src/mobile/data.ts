import type { AccountBalance, AccountQuota, QuotaWindow } from '../../../shared/contracts'

export type Provider = DashboardAccount['provider']
export type { DashboardAccount } from '../../../shared/dashboard'
import type { DashboardAccount } from '../../../shared/dashboard'

const started = Date.now()
function window(remaining: number, hours: number): QuotaWindow {
  return {
    limit: 100,
    used: 100 - remaining,
    remaining,
    resetAt: new Date(started + hours * 3600000).toISOString()
  }
}
function quota(five: number, weekly: number, hours: number, monthly?: number): AccountQuota {
  return {
    fiveHour: window(five, hours),
    weekly: window(weekly, 78),
    monthly: monthly === undefined ? undefined : window(monthly, 312),
    total: null,
    totalUnlimited: false
  }
}

// Preview fixtures use the same quota/balance contracts as the desktop application.
// No desktop credentials or privileged Electron APIs are exposed to this page.
export const accounts: DashboardAccount[] = [
  {
    id: 'kimi-a',
    name: 'Kimi 账号 A',
    provider: 'Kimi',
    quota: quota(72, 48, 2.3),
    requests: 126,
    tokens: 1280000,
    active: 2
  },
  {
    id: 'kimi-b',
    name: 'Kimi 账号 B',
    provider: 'Kimi',
    quota: quota(8, 35, 1.2),
    requests: 42,
    tokens: 426000,
    active: 0
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'DeepSeek',
    quota: null,
    balance: { available: true, balances: [{ currency: 'CNY', balance: 128.6 }] },
    requests: 68,
    tokens: 840000,
    active: 0
  },
  {
    id: 'go',
    name: '开发账号',
    provider: 'Go',
    quota: quota(86, 64, 3.1, 79),
    requests: 24,
    tokens: 312000,
    active: 0
  }
]

export function percent(value: QuotaWindow | null | undefined): number | null {
  if (value?.remaining == null || value.limit == null || value.limit <= 0) return null
  return Math.round(Math.max(0, Math.min(1, value.remaining / value.limit)) * 100)
}
export function countdown(value: QuotaWindow | null | undefined, now: number) {
  if (!value?.resetAt) return '重置时间未知'
  const minutes = Math.ceil((Date.parse(value.resetAt) - now) / 60000)
  if (minutes <= 0) return '等待额度更新'
  if (minutes >= 1440)
    return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时后重置`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置`
}
export function formatTokens(tokens: number) {
  return tokens >= 1000000 ? `${(tokens / 1000000).toFixed(2)}M` : `${(tokens / 1000).toFixed(0)}K`
}
export const PROVIDER_NAMES: Record<Provider, string> = {
  自定义供应商: '自定义供应商',
  Kimi: 'Kimi Code',
  DeepSeek: '按量付费',
  Go: 'OpenCode Go',
  MiniMax: 'Token Plan',
  'Command Code': 'GOAT Plan',
  Codex: 'OpenAI · Codex'
}
export const DASHBOARD_PROVIDERS = Object.keys(PROVIDER_NAMES) as Provider[]
export function providerName(provider: Provider) {
  return PROVIDER_NAMES[provider]
}
