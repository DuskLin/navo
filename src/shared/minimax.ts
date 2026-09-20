import type { AccountQuota, QuotaWindow } from './contracts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export class MiniMaxQuotaError extends Error {
  constructor() {
    // 不回显上游 status_msg，避免凭据或其他敏感内容进入 IPC。
    super('MiniMax 套餐查询失败，请检查区域及 Token Plan 套餐密钥')
  }
}

function window(value: unknown, reset: unknown): QuotaWindow | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null
  const percent = Number(value)
  if (!Number.isFinite(percent)) return null
  const remaining = Math.max(0, Math.min(100, percent))
  const numeric =
    typeof reset === 'number' || (typeof reset === 'string' && /^\d+(\.\d+)?$/.test(reset))
      ? Number(reset)
      : NaN
  const time = Number.isFinite(numeric)
    ? numeric > 0
      ? numeric * (numeric < 1e12 ? 1000 : 1)
      : NaN
    : typeof reset === 'string'
      ? Date.parse(reset)
      : NaN
  const date = new Date(time)
  return {
    limit: 100,
    used: 100 - remaining,
    remaining,
    resetAt: Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
}

// 与 sub2api 一致：general 是共享编程套餐，video 等独立资源不可混入调度额度。
export function parseMiniMaxQuota(value: unknown): AccountQuota | null {
  const root = record(value)
  const status = record(root.base_resp).status_code
  if (status !== undefined && status !== 0 && status !== '0') throw new MiniMaxQuotaError()
  const general = (Array.isArray(root.model_remains) ? root.model_remains : [])
    .map(record)
    .find((item) => String(item.model_name).trim().toLowerCase() === 'general')
  if (!general) return null
  const quota: AccountQuota = {
    fiveHour: window(general.current_interval_remaining_percent, general.end_time),
    weekly:
      Number(general.current_weekly_status) === 1
        ? window(general.current_weekly_remaining_percent, general.weekly_end_time)
        : null,
    total: null,
    totalUnlimited: false,
    unit: 'percent'
  }
  return quota.fiveHour || quota.weekly ? quota : null
}
