export type Theme = 'light' | 'dark'

export interface AppSettings {
  theme: Theme
  preventSleepDuringRequests: boolean
  sleepOnlyOnAC: boolean
  sleepReleaseDelaySeconds: number
}

export interface SleepProtectionState {
  onBatteryPower?: boolean
  mode: 'system' | 'idle'
  authorized: boolean
  active: boolean
  externallyDisabled: boolean
  error: string
}

export interface AppInfo {
  version: string
  platform: string
  electron: string
}

export interface HelperApi {
  onWindowVisibilityChange(listener: (visible: boolean) => void): () => void
  onMigrationProgress(
    listener: (progress: import('./session-migration').MigrationProgress) => void
  ): () => void
  chooseMigrationDirectory(currentPath: string): Promise<string | null>
  scanZcodeSessions(
    paths?: import('./session-migration').MigrationPaths
  ): Promise<import('./session-migration').MigrationScan>
  migrateZcodeSessions(
    paths: import('./session-migration').MigrationPaths,
    sessions: Pick<import('./session-migration').MigrationSession, 'key' | 'fingerprint'>[]
  ): Promise<import('./session-migration').MigrationResult>
  getKimiDesktop(): Promise<import('./kimi-desktop').KimiDesktopState>
  saveKimiDesktop(
    value: import('./kimi-desktop').KimiDesktopPreferences
  ): Promise<import('./kimi-desktop').KimiDesktopState>
  reapplyKimiDesktop(): Promise<import('./kimi-desktop').KimiDesktopState>
  getDashboard(): Promise<import('./dashboard').DashboardState>
  saveDashboard(
    input: import('./dashboard').DashboardSettings & { token?: string }
  ): Promise<import('./dashboard').DashboardState>
  rotateDashboardCode(): Promise<import('./dashboard').DashboardState>
  copyDashboardCode(): Promise<void>
  copyDashboardUrl(lanUrl?: string): Promise<void>
  checkDashboardPublic(): Promise<import('./dashboard').DashboardState>
  openDashboard(): Promise<void>
  getUpdateState(): Promise<import('./updates').UpdateState>
  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>
  openReleasePage(): Promise<void>
  openIssuesPage(): Promise<void>
  openProjectPage(): Promise<void>
  getUsageStats(query: import('./usage').UsageQuery): Promise<import('./usage').UsageStats>
  getAppInfo(): Promise<AppInfo>
  getSettings(): Promise<AppSettings>
  getSleepProtection(): Promise<SleepProtectionState>
  saveSettings(settings: Partial<AppSettings>): Promise<AppSettings>
  getGateway(): Promise<GatewaySnapshot>
  getRequestHistory(before?: number): Promise<RequestHistoryPage>
  getQuotaCycles(
    query: import('./quota-cost').QuotaCycleQuery
  ): Promise<import('./quota-cost').QuotaCostCycle[]>
  setQuotaCycleExcluded(input: import('./quota-cost').QuotaCycleExclusion): Promise<GatewaySnapshot>
  importKimiAccount(region: Region): Promise<GatewaySnapshot>
  importCodexAccount(): Promise<GatewaySnapshot>
  saveAccount(input: AccountInput): Promise<GatewaySnapshot>
  inspectAccount(input: AccountProbe): Promise<AccountCapabilities>
  testAccountModel(input: AccountModelTest): Promise<AccountModelTestResult>
  refreshAccount(id: string): Promise<GatewaySnapshot>
  deleteAccount(id: string): Promise<GatewaySnapshot>
  resetAccount(id: string): Promise<GatewaySnapshot>
  refreshModelPrices(force?: boolean): Promise<GatewaySnapshot>
  saveQuotaCardOrder(ids: string[]): Promise<GatewaySnapshot>
  saveModelPrice(input: ModelPrice): Promise<GatewaySnapshot>
  saveGateway(input: GatewaySettings): Promise<GatewaySnapshot>
  setGatewayRunning(running: boolean): Promise<GatewaySnapshot>
  rotateGatewayKey(groupId: string): Promise<GatewaySnapshot>
  copyKimiModelConfig(model: string): Promise<void>
  copyConnection(input: {
    groupId: string
    lanAddress?: string
    format: 'url' | 'key' | 'kimi' | 'anthropic' | 'registry'
  }): Promise<void>
}

export type Region = 'mainland-cn' | 'global'
export const PROVIDERS = [
  'kimi',
  'deepseek',
  'opencode-go',
  'codex',
  'minimax',
  'commandcode-goat',
  'custom'
] as const
export type Provider = (typeof PROVIDERS)[number]
export type ModelProtocol = 'messages' | 'responses' | 'chat-completions'
export const DEFAULT_ACCOUNT_CONCURRENCY = 20
export type Strategy = 'balanced'
export interface Membership {
  groupId: string
  /** 仅保留以兼容旧配置，不再参与调度。 */
  priority: number
  /** 仅保留以兼容旧配置，不再参与调度。 */
  weight: number
}
export interface AccountInput {
  /** 旧配置缺省为 Kimi。 */
  provider?: Provider
  baseUrl?: string
  modelSource?: 'automatic' | 'manual'
  id?: string
  name: string
  kind: 'api-key' | 'oauth'
  kimiOAuthOnly?: boolean
  region: Region
  enabled: boolean
  concurrencyOverride?: number | null
  modelProtocols?: Record<string, ModelProtocol[]>
  /** 请求模型 ID（支持末尾 *）到此账号上游模型 ID 的映射。 */
  modelMappings?: Record<string, string>
  excludedModels?: string[]
  manualModels?: string[]
  memberships: Membership[]
  secret?: string
}
export interface AccountView extends Omit<AccountInput, 'secret' | 'id'> {
  id: string
  baseUrl: string
  maxConcurrency: number
  models: string[]
  capabilities: AccountCapabilities | null
  quotaEstimates?: Partial<Record<'fiveHour' | 'weekly', import('./quota-cost').QuotaCostEstimate>>
  hasCredential: boolean
  runtime: AccountRuntime
}
export interface AccountProbe {
  provider?: Provider
  baseUrl?: string
  id?: string
  region: Region
  secret?: string
}
export interface AccountModelTest extends AccountProbe {
  name?: string
  model: string
  protocol: ModelProtocol
}
export interface AccountModelTestResult {
  model: string
  protocol: ModelProtocol
  durationMs: number
  text: string
}
export interface AccountCapabilities {
  modelProtocols?: Record<string, ModelProtocol[]>
  balance?: AccountBalance | null
  models: string[]
  maxConcurrency: number | null
  checkedAt: number
  warning: string
  quota?: AccountQuota | null
}
export interface QuotaWindow {
  limit: number | null
  used: number | null
  remaining: number | null
  resetAt: string | null
}
export interface AccountQuota {
  monthly?: QuotaWindow | null
  unit?: 'percent' | 'USD'
  /** Purchased and free credits available after Command Code plan limits. */
  extraCredits?: number
  fiveHour: QuotaWindow | null
  weekly: QuotaWindow | null
  total: QuotaWindow | null
  totalUnlimited: boolean
}
export interface AccountBalance {
  available: boolean
  balances: { currency: string; balance: number }[]
}
/** Base URL includes the API prefix (for example /v1); preserve custom paths. */
export function normalizeCustomBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
    throw new Error('请填写有效的上游 Base URL')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('上游 Base URL 格式无效')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('上游 Base URL 须为 HTTP 或 HTTPS 地址，且不能包含凭据、查询参数或片段')
  return url.toString().replace(/\/+$/, '')
}
export function accountBaseUrl(
  region: Region,
  provider: Provider = 'kimi',
  baseUrl?: string
): string {
  if (provider === 'custom') return normalizeCustomBaseUrl(baseUrl)
  if (provider === 'minimax')
    return region === 'global' ? 'https://api.minimax.io/v1' : 'https://api.minimaxi.com/v1'
  if (provider === 'commandcode-goat') return 'https://api.commandcode.ai/provider/v1'
  if (provider === 'codex') return 'https://chatgpt.com/backend-api/codex'
  if (provider === 'opencode-go') return 'https://opencode.ai/zen/go/v1'
  return provider === 'deepseek' ? 'https://api.deepseek.com/v1' : kimiBaseUrl(region)
}
export function upstreamUrl(
  region: Region,
  provider: Provider = 'kimi',
  route: string,
  baseUrl?: string
): string {
  if (provider === 'minimax' && route.startsWith('/v1/messages'))
    return `${accountBaseUrl(region, provider).slice(0, -3)}/anthropic${route}`
  if (provider === 'deepseek' && route === '/v1/messages')
    return 'https://api.deepseek.com/anthropic/v1/messages'
  return `${accountBaseUrl(region, provider, baseUrl)}${route.slice(3)}`
}
export function kimiBaseUrl(region: Region): string {
  return region === 'global' ? 'https://api.kimi.ai/coding/v1' : 'https://api.kimi.com/coding/v1'
}
export interface AccountRuntime {
  active: number
  requests: number
  successes: number
  failures: number
  cooldownUntil: number
  authFailed: boolean
  lastError: string
  lastUsed: number
  latencyMs: number
}
export interface GroupInput {
  id?: string
  name: string
  enabled: boolean
  strategy: Strategy
  stickySeconds: number
}
export interface GroupView extends GroupInput {
  id: string
}
export interface GatewaySettings {
  flowIdleMinutes?: number
  lanSharing?: boolean
  stickySeconds?: number
  port: number
  autoStart: boolean
  timeoutSeconds: number
  maxAttempts: number
  cooldownSeconds: number
}
export interface RequestRecord {
  sessionId?: string
  provider?: Provider
  interruption?:
    | 'client_disconnect'
    | 'timeout'
    | 'upstream_disconnect'
    | 'upstream_error'
    | 'gateway_shutdown'
    | null
  streamDurationMs?: number | null
  accountId?: string
  protocol?: import('./usage').UsageProtocol
  inboundRoute?: string
  /** 最后一次调度实际发出的接口；null 表示未转发，undefined 表示旧记录。 */
  upstreamRoute?: string | null
  /** 最后一次转发使用的模型 ID；旧记录缺省时使用 model。 */
  upstreamModel?: string
  usage?: import('./usage').TokenUsage | null
  upstreamRequestId?: string | null
  reasoningEffort?: string | null
  id: string
  time: number
  group: string
  account: string
  model: string
  status: number
  attempts: number
  durationMs: number
  firstTokenMs: number | null
}
export interface ModelPrice {
  catalogMatch?: { provider: string; model: string }
  provider: Provider
  model: string
  currency: 'CNY' | 'USD'
  /** 每百万 token 单价；null 表示未设置。 */
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export interface DefaultModelPrice extends ModelPrice {
  tiered: boolean
}
export interface RegistryModelCapabilities {
  reasoning?: boolean
  tool_call?: boolean
  support_efforts?: string[]
  default_effort?: string
  modalities?: { input?: string[]; output?: string[] }
}
export interface CatalogPrice extends Omit<DefaultModelPrice, 'provider'> {
  provider: string
  name: string
  providerName: string
  limit?: { context?: number; output?: number }
  capabilities?: RegistryModelCapabilities
}
export interface ModelPriceCatalogSnapshot {
  entries: CatalogPrice[]
  prices: DefaultModelPrice[]
  updatedAt: number | null
  error: string
}
export type GatewayUpdate = Omit<GatewaySnapshot, 'modelPriceCatalog'> & {
  catalogVersion: number
  modelPriceCatalog?: ModelPriceCatalogSnapshot
}
export interface GatewaySnapshot {
  liveFlows?: import('./live-flow').LiveFlow[]
  lanBaseUrls: string[]
  quotaCardOrder: string[]
  modelPriceCatalog: ModelPriceCatalogSnapshot
  modelPrices: ModelPrice[]
  activeRequestCount: number
  settings: GatewaySettings
  groups: GroupView[]
  accounts: AccountView[]
  running: boolean
  baseUrl: string
  error: string
  requests: RequestRecord[]
}

export interface RequestHistoryPage {
  records: RequestRecord[]
  nextCursor: number | null
  total: number
}

export const IPC = {
  windowVisibility: 'window:visibility',
  migrationChooseDirectory: 'migration:choose-directory',
  migrationProgress: 'migration:progress',
  zcodeScan: 'zcode:scan',
  zcodeMigrate: 'zcode:migrate',
  kimiDesktopGet: 'kimi-desktop:get',
  kimiDesktopSave: 'kimi-desktop:save',
  kimiDesktopReapply: 'kimi-desktop:reapply',
  dashboardGet: 'dashboard:get',
  dashboardSave: 'dashboard:save',
  dashboardRotate: 'dashboard:rotate',
  dashboardCopyCode: 'dashboard:copy-code',
  dashboardCopyUrl: 'dashboard:copy-url',
  dashboardCheckPublic: 'dashboard:check-public',
  dashboardOpen: 'dashboard:open',
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateOpenRelease: 'update:open-release',
  appInfo: 'app:info',
  appOpenIssues: 'app:open-issues',
  appOpenProject: 'app:open-project',
  settingsGet: 'settings:get',
  sleepProtectionGet: 'sleep-protection:get',
  settingsSave: 'settings:save',
  gatewayGet: 'gateway:get',
  requestHistory: 'gateway:request-history',
  quotaCycles: 'gateway:quota-cycles',
  quotaCycleExclude: 'gateway:quota-cycle-exclude',
  usageStats: 'gateway:usage-stats',
  accountImportKimi: 'account:import-kimi',
  accountImportCodex: 'account:import-codex',
  accountSave: 'account:save',
  accountInspect: 'account:inspect',
  accountModelTest: 'account:model-test',
  accountRefresh: 'account:refresh',
  accountDelete: 'account:delete',
  accountReset: 'account:reset',
  groupSave: 'group:save',
  groupDelete: 'group:delete',
  modelPriceRefresh: 'model-price:refresh',
  quotaCardOrderSave: 'quota-card-order:save',
  modelPriceSave: 'model-price:save',
  gatewaySave: 'gateway:save',
  gatewayRunning: 'gateway:running',
  connectionCopy: 'connection:copy',
  kimiModelConfigCopy: 'model:copy-kimi-config',
  connectionRotate: 'connection:rotate'
} as const
