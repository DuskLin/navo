import type { AccountBalance, AccountQuota } from './contracts'

export interface DashboardAccount {
  id: string
  name: string
  provider: 'Kimi' | 'DeepSeek' | 'Go' | 'MiniMax' | 'Codex'
  quota: AccountQuota | null
  balance?: AccountBalance
  requests: number
  tokens: number
  active: number
  checkedAt?: number
  status?: 'available' | 'disabled' | 'error' | 'stale' | 'exhausted'
}
export interface DashboardSnapshot {
  accounts: DashboardAccount[]
  generatedAt: number
  points: { time: number; tokens: number | null }[]
  totals: { requests: number; tokens: number | null; active: number }
  tunnel: 'off' | 'connecting' | 'connected' | 'error'
}
export interface DashboardSettings {
  enabled: boolean
  lan: boolean
  port: number
  tunnelMode: 'off' | 'quick' | 'named'
  hostname: string
}
export interface DashboardState {
  publicCheck: {
    status: 'idle' | 'checking' | 'reachable' | 'protected' | 'unreachable'
    checkedAt: number | null
    message: string
  }
  settings: DashboardSettings
  running: boolean
  localUrl: string
  lanUrls: string[]
  publicUrl: string
  tunnelOrigin: string
  tunnel: 'off' | 'connecting' | 'connected' | 'error'
  error: string
  fingerprint: string
  hasTunnelToken: boolean
}
