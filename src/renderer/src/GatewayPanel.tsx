import { autoMatchCatalog } from '../../shared/catalog-match'
import { hasQuotaDisplay, hasQuotaWindow } from '../../shared/quota-display'
import { requiresKimiUserAgent } from '../../shared/kimi-client-policy'
import codexLogo from './assets/models/openai.svg'
import { Modal } from './Modal'
import { ModelListModal } from './ModelListModal'
import { ModelLogo } from './ModelLogo'
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { SettingsToggle } from './SettingsToggle'
import { DashboardSettings } from './DashboardSettings'
import { KimiDesktopSettings } from './KimiDesktopSettings'
import { createPortal } from 'react-dom'
import {
  Globe,
  FlaskConical,
  CircleHelp,
  List,
  PanelsTopLeft,
  Wrench,
  Activity,
  Coins,
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  X
} from 'lucide-react'
import type {
  AccountModelTestResult,
  ModelProtocol,
  ModelPrice,
  ModelPriceCatalogSnapshot,
  AccountCapabilities,
  AccountQuota,
  QuotaWindow,
  AccountInput,
  AccountView,
  GatewaySettings,
  GatewaySnapshot,
  RequestRecord,
  RequestHistoryPage
} from '../../shared/contracts'

import { DEFAULT_ACCOUNT_CONCURRENCY, accountBaseUrl } from '../../shared/contracts'
import {
  matchedModelPrice,
  resolveModelPrice,
  searchCatalogPrices
} from '../../shared/model-pricing'
import { useQuotaCardDrag } from './useQuotaCardDrag'
import { requestCost, requestCostDetails } from '../../shared/request-cost'
import type { QuotaCostCycle, QuotaCycleQuery } from '../../shared/quota-cost'
import { hasCommandCodeExtraCredits, remainingRatio } from '../../shared/kimi-quota'
import { MODEL_PROTOCOLS, supportedModelProtocols } from '../../shared/model-protocols'
import { validateModelMappings } from '../../shared/model-mapping'
import { ModelMappingEditor } from './ModelMappingEditor'

import { KimiLogo } from './KimiLogo'
import minimaxLogo from './assets/models/minimax.svg'
import commandcodeLogo from './assets/models/commandcode-light.svg'
import deepseekLogo from './assets/models/deepseek.svg'
import { LiveFlowPanel } from './LiveFlowPanel'
import { UsageDashboard } from './UsageDashboard'
import type { UsageStats } from '../../shared/usage'
import { performanceHistoryRange } from '../../shared/usage'

const api = window.navo
// Keep the persisted key so existing Navo display preferences survive the rename.
const cardDisplayKey = 'kimi-helper.card-display'
function readCardDisplay(): {
  estimates: boolean
  performance: boolean
  tokenActivity: boolean
  usageTrend: boolean
} {
  try {
    const saved = JSON.parse(localStorage.getItem(cardDisplayKey) ?? '{}')
    return {
      estimates: saved?.estimates !== false,
      performance: saved?.performance !== false,
      tokenActivity: saved?.tokenActivity !== false,
      usageTrend: saved?.usageTrend !== false
    }
  } catch {
    return { estimates: true, performance: true, tokenActivity: true, usageTrend: true }
  }
}
const peakPeriodHint =
  '北京时间：周一至周五 09:00–12:00、14:00–18:00 为峰期，其余为谷期；按请求开始时间归类'
function AccountPerformance({
  stats,
  account
}: {
  stats: UsageStats['byAccount']
  account: Pick<AccountView, 'id' | 'name'>
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const models = [
    ...new Set(
      stats
        .filter((item) => item.averageFirstTokenMs != null || item.averageTokensPerSecond != null)
        .map((item) => item.model)
    )
  ]
  return (
    <section className="account-performance" aria-label="按模型峰谷性能">
      <div className="account-performance-heading">
        <span className="performance-title">
          模型表现
          <button
            className="icon-button performance-list-button"
            type="button"
            title="近 30 天模型表现"
            aria-label={`查看 ${account.name} 近 30 天模型表现`}
            onClick={() => setHistoryOpen(true)}
          >
            <List size={12} />
          </button>
        </span>
        <span title={peakPeriodHint}>今日 · 峰谷分时</span>
      </div>
      {models.length ? (
        models.map((model) => (
          <div className="model-performance" key={model}>
            <div className="model-performance-name" title={model}>
              {model}
            </div>
            <table className="model-performance-table" aria-label={`${model} 峰谷表现`}>
              <thead>
                <tr>
                  <th scope="col">指标</th>
                  <th scope="col" title={peakPeriodHint}>
                    谷期
                  </th>
                  <th scope="col" title={peakPeriodHint}>
                    峰期
                  </th>
                </tr>
              </thead>
              <tbody>
                {(['firstToken', 'speed'] as const).map((metric) => (
                  <tr key={metric}>
                    <th scope="row">{metric === 'firstToken' ? '平均首 token' : '平均生成速度'}</th>
                    {(['off-peak', 'peak'] as const).map((period) => {
                      const sample = stats.find(
                        (item) => item.model === model && item.period === period
                      )
                      const value =
                        metric === 'firstToken'
                          ? sample?.averageFirstTokenMs
                          : sample?.averageTokensPerSecond
                      const count =
                        metric === 'firstToken' ? sample?.firstTokenSamples : sample?.speedSamples
                      const formula =
                        metric === 'firstToken'
                          ? '成功且未中断请求的首 token 耗时算术平均，包含重试等待'
                          : '总输出 token ÷ 总上游流式时长（含首字等待）'
                      return (
                        <td
                          key={period}
                          title={`${period === 'peak' ? '峰期' : '谷期'} · ${count ?? 0} 个有效请求；${formula}`}
                        >
                          {value == null
                            ? '—'
                            : metric === 'firstToken'
                              ? formatLatency(value)
                              : `${value.toFixed(1)} tokens/s`}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      ) : (
        <p className="model-performance-empty">
          平均首 token / 生成速度 <span>—</span>
        </p>
      )}
      {historyOpen && <PerformanceHistory account={account} close={() => setHistoryOpen(false)} />}
    </section>
  )
}
function PerformanceHistory({
  account,
  close
}: {
  account: Pick<AccountView, 'id' | 'name'>
  close: () => void
}) {
  const [result, setResult] = useState<{
    rows: UsageStats['byAccount']
    days: string[]
    start: number
    end: number
  }>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    const { start, end, days } = performanceHistoryRange()
    setLoading(true)
    setError('')
    api
      .getUsageStats({
        accountId: account.id,
        start,
        end,
        bucketMs: 86400000,
        performanceByDay: true
      })
      .then(
        (stats) => {
          if (active)
            setResult({
              rows: stats.byAccount.filter((row) => row.accountId === account.id),
              days,
              start,
              end
            })
        },
        (e) => {
          if (active) setError(errorText(e))
        }
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [account.id, reload])
  return (
    <Modal title={`${account.name} · 近 30 天模型表现`} close={close}>
      <div className="performance-history-toolbar">
        <div className="performance-history-summary">
          <span title="按北京时间自然日统计，包含今天，共 30 天">北京时间 · 每日</span>
          {result && (
            <span
              title={`截至 ${new Date(result.end).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`}
            >
              {result.days.at(-1)} — {result.days[0]}
            </span>
          )}
          <span
            className="performance-history-hint"
            title={peakPeriodHint}
            tabIndex={0}
            aria-label={peakPeriodHint}
          >
            峰谷分时 <CircleHelp size={12} />
          </span>
        </div>
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          刷新
        </button>
      </div>
      {error && (
        <p role="alert" className="panel-error">
          {error}
        </p>
      )}
      {loading ? (
        <p className="muted">正在加载…</p>
      ) : (
        !error &&
        result && (
          <div className="table-scroll">
            <table className="performance-history-table" aria-label="近 30 天模型表现列表">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>时段</th>
                  <th>平均首 token</th>
                  <th>平均生成速度</th>
                </tr>
              </thead>
              {result.days.map((day) => (
                <tbody key={day} data-performance-day={day}>
                  <tr className="performance-day-heading">
                    <th colSpan={4} scope="rowgroup">
                      {day}
                      {day === result.days[0] ? ' · 今天' : ''}
                    </th>
                  </tr>
                  {!result.rows.some((row) => row.day === day) && (
                    <tr>
                      <td colSpan={4} className="muted">
                        暂无记录
                      </td>
                    </tr>
                  )}
                  {result.rows
                    .filter((row) => row.day === day)
                    .map((row) => (
                      <tr key={`${row.model}:${row.period}`}>
                        <td>{row.model}</td>
                        <td>{row.period === 'peak' ? '峰期' : '谷期'}</td>
                        <td title="成功且未中断请求的首 token 耗时算术平均，包含重试等待">
                          {row.averageFirstTokenMs == null
                            ? '—'
                            : formatLatency(row.averageFirstTokenMs)}
                          <small>{row.firstTokenSamples} 个有效请求</small>
                        </td>
                        <td title="总输出 token ÷ 总上游流式时长（含首字等待）">
                          {row.averageTokensPerSecond == null
                            ? '—'
                            : `${row.averageTokensPerSecond.toFixed(1)} tokens/s`}
                          <small>{row.speedSamples} 个有效请求</small>
                        </td>
                      </tr>
                    ))}
                </tbody>
              ))}
            </table>
          </div>
        )
      )}
    </Modal>
  )
}
function ProviderLogo({ provider }: { provider?: AccountInput['provider'] }) {
  if (provider === 'commandcode-goat')
    return (
      <img
        className="commandcode-logo"
        src={commandcodeLogo}
        width={24}
        height={24}
        alt="Command Code"
      />
    )
  if (provider === 'custom') return <span aria-label="自定义供应商">AI</span>
  if (provider === 'codex')
    return <img className="openai-logo" src={codexLogo} width={20} height={20} alt="Codex" />
  if (provider === 'minimax')
    return <img className="minimax-logo" src={minimaxLogo} alt="MiniMax" />
  if (provider === 'opencode-go')
    return (
      <svg
        className="opencode-go-logo"
        width={23}
        height={23}
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        role="img"
        aria-label="OpenCode Go"
      >
        <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
      </svg>
    )
  return provider === 'deepseek' ? (
    <img className="deepseek-logo" src={deepseekLogo} alt="DeepSeek" />
  ) : (
    <KimiLogo />
  )
}
function BalanceDetails({
  capabilities,
  loading = false,
  compact = false
}: {
  capabilities?: AccountCapabilities | null
  loading?: boolean
  compact?: boolean
}) {
  if (compact) {
    return (
      <>
        <span>按量付费余额</span>
        {capabilities?.balance ? (
          capabilities.balance.balances.map((entry, index) => (
            <small key={`${entry.currency}-${index}`}>
              {entry.currency} {entry.balance.toLocaleString('zh-CN', { maximumFractionDigits: 8 })}
            </small>
          ))
        ) : (
          <small>暂未获取余额</small>
        )}
      </>
    )
  }
  return (
    <div className="quota-details" aria-label="DeepSeek 余额">
      <strong>按量付费余额</strong>
      {loading ? (
        <p>正在获取…</p>
      ) : capabilities?.balance ? (
        <>
          {capabilities.balance.balances.map((entry, index) => (
            <p key={`${entry.currency}-${index}`}>
              {entry.currency} {entry.balance.toLocaleString('zh-CN', { maximumFractionDigits: 8 })}
            </p>
          ))}
          {!capabilities.balance.available && <p className="warning">余额不足，暂不可调度</p>}
        </>
      ) : (
        <p className="muted">暂未获取余额</p>
      )}
    </div>
  )
}
const formatLatency = (ms: number | null | undefined): string =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
function RequestLatency({ record }: { record: RequestRecord }) {
  const metrics = [
    { label: '首字', ms: record.firstTokenMs, warning: 3000, slow: 10000 },
    { label: '耗时', ms: record.durationMs, warning: 15000, slow: 60000 }
  ]
  return (
    <div className="request-latency">
      {metrics.map(({ label, ms, warning, slow }) => {
        const tone =
          ms == null ? 'unknown' : ms >= slow ? 'slow' : ms >= warning ? 'warning' : 'fast'
        const value =
          ms == null
            ? '—'
            : ms >= 60000
              ? `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
              : formatLatency(ms)
        return (
          <div className={`request-latency-row latency-${tone}`} key={label}>
            <span
              className="latency-label"
              title={
                label === '首字'
                  ? '从网关收到请求到首个文本、思考或工具调用输出，包含重试等待；非流式或未收到输出时为 —'
                  : '从网关收到请求到请求结束的总耗时'
              }
            >
              {label}
            </span>
            <span className="latency-value" title={ms == null ? '暂无数据' : `${ms}ms`}>
              {value}
            </span>
          </div>
        )
      })}
    </div>
  )
}
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : '操作失败，请稍后重试'
function accountStatus(a: AccountView): { text: string; className: string } {
  if (!a.hasCredential) return { text: '待填写 API Key', className: 'warning' }
  if (!a.enabled) return { text: '已停用', className: 'muted' }
  if (!a.capabilities) return { text: '待同步上游', className: 'warning' }
  if (!a.models.length) return { text: '上游暂无模型', className: 'warning' }
  if (a.capabilities.balance?.available === false) return { text: '余额不足', className: 'warning' }
  if (a.runtime.authFailed) return { text: '需重新认证', className: 'danger' }
  if (a.runtime.cooldownUntil > Date.now())
    return {
      text: `冷却 ${Math.ceil((a.runtime.cooldownUntil - Date.now()) / 1000)}s`,
      className: 'warning'
    }
  if (a.runtime.active >= a.maxConcurrency) return { text: '满载', className: 'warning' }
  if (
    [
      a.capabilities.quota?.fiveHour,
      a.capabilities.quota?.weekly,
      a.capabilities.quota?.monthly
    ].some((window) => remainingRatio(window, a.capabilities!.checkedAt, Date.now()) === 0) &&
    !hasCommandCodeExtraCredits(
      a.provider,
      a.capabilities.quota,
      a.capabilities.checkedAt,
      Date.now()
    )
  )
    return { text: '额度耗尽', className: 'warning' }
  return { text: a.runtime.active ? '处理中' : '可调度', className: 'healthy' }
}
function quotaRemaining(
  window: QuotaWindow | null | undefined,
  unit?: AccountQuota['unit']
): string {
  const format = (value: number | null | undefined) =>
    value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  if (unit === 'USD')
    return `USD ${format(window?.remaining)}${window?.limit == null ? '' : ` / ${format(window.limit)}`}`
  return unit === 'percent'
    ? `${format(window?.remaining)}%`
    : `${format(window?.remaining)} / ${format(window?.limit)}`
}
function quotaMoney(currency: string, value: number): string {
  return `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2 })}`
}
function quotaCycleDateTime(value: number): string {
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
function compactReset(value: string): string {
  const date = new Date(value)
  return date.toLocaleString('zh-CN', {
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}
function capabilityWarning(
  capabilities: AccountCapabilities | null | undefined,
  override?: number | null
): string {
  const warning = capabilities?.warning ?? ''
  return override == null
    ? warning
    : warning.replace(/使用默认 \d+ 个并发调度/g, `使用手动设置的 ${override} 个并发调度`)
}
function QuotaDetails({
  quota,
  loading,
  overview = false,
  estimates,
  showEstimates = true,
  account,
  onSnapshot
}: {
  quota: AccountQuota | null | undefined
  loading: boolean
  overview?: boolean
  estimates?: AccountView['quotaEstimates']
  showEstimates?: boolean
  account?: Pick<AccountView, 'id' | 'name'>
  onSnapshot?: (snapshot: GatewaySnapshot) => void
}) {
  const [managing, setManaging] = useState<QuotaCycleQuery['window']>()
  const hasWindows = [quota?.fiveHour, quota?.weekly, quota?.monthly].some(hasQuotaWindow)
  if (!hasWindows && (overview || (!loading && !quota?.total && !quota?.totalUnlimited)))
    return null
  return (
    <section className="quota-details" aria-label="账号额度">
      {!overview && (
        <div className="quota-title">
          账号额度 <small>{loading ? '正在同步…' : '来自上游用量接口'}</small>
        </div>
      )}
      <div className="form-grid">
        {(
          [
            [overview ? '5h 剩余额度' : '5 小时额度', quota?.fiveHour, estimates?.fiveHour],
            [overview ? '7D 剩余额度' : '7 天额度', quota?.weekly, estimates?.weekly],
            ...(quota?.monthly !== undefined
              ? [[overview ? '月 剩余额度' : '月额度', quota.monthly, undefined] as const]
              : [])
          ] as const
        ).map(([label, window, estimate], index) => {
          if (!hasQuotaWindow(window)) return null
          const amount = overview ? window?.remaining : window?.used
          const percent =
            window?.limit && amount != null
              ? Math.min(100, Math.max(0, (amount / window.limit) * 100))
              : null
          return (
            <div className="quota-window" key={label}>
              <strong className="quota-window-label">
                {overview ? label.split(' ')[0] : label}
                {overview && showEstimates && account && index < 2 && (
                  <button
                    type="button"
                    className="icon-button quota-cycle-tool"
                    aria-label={`管理 ${account.name} ${index === 0 ? '5H' : '7D'} 统计周期`}
                    title="管理统计周期"
                    onClick={() => setManaging(index === 0 ? 'fiveHour' : 'weekly')}
                  >
                    <Wrench size={11} />
                  </button>
                )}
              </strong>
              {overview && (
                <b
                  className="remaining-percent"
                  title={`剩余 ${quotaRemaining(window, quota?.unit)}`}
                >
                  {percent === null
                    ? quota?.unit === 'USD'
                      ? quotaRemaining(window, quota.unit)
                      : '—'
                    : `${Number(percent.toFixed(1))}%`}
                </b>
              )}
              {!overview && <span>剩余 {quotaRemaining(window, quota?.unit)}</span>}
              {percent !== null && (
                <progress
                  aria-label={`${label}${overview ? '比例' : '已用比例'}`}
                  max={100}
                  value={percent}
                />
              )}
              <small
                title={window?.resetAt ? new Date(window.resetAt).toLocaleString() : undefined}
              >
                {window?.resetAt
                  ? `${overview ? compactReset(window.resetAt) : new Date(window.resetAt).toLocaleString()} 重置`
                  : window
                    ? '未提供重置时间'
                    : '暂无额度数据'}
              </small>
              {showEstimates && estimate && (
                <div
                  className="quota-cost-estimate"
                  title="按本周期截至额度同步时的本地请求费用 ÷ 已用比例估算。费用优先采用上游报告，否则按当前模型价格计算；外部用量、缺失记录和百分比精度会影响结果，不代表官方余额。"
                >
                  {estimate.amounts.length ? (
                    estimate.amounts.map((amount) => {
                      const money = (value: number) => quotaMoney(amount.currency, value)
                      return (
                        <div key={amount.currency}>
                          <span>
                            估算总额 <b>{money(amount.total)}</b>
                          </span>
                          <span>
                            估算可用 <b>{money(amount.remaining)}</b>
                          </span>
                        </div>
                      )
                    })
                  ) : estimate.reason !== '待产生用量' ? (
                    <small>金额估算：{estimate.reason}</small>
                  ) : null}
                  {estimate.averages?.length ? (
                    estimate.averages.map((average) => (
                      <span
                        key={average.currency}
                        title={`本账号 ${label.split(' ')[0]} 的 ${average.cycles} 个有效周期的估算总额算术平均；当前周期有有效估算时也计入，每周期只取最后一次有效估算，币种分别统计。从启用此功能起积累，历史周期保留当时价格。`}
                      >
                        估算均值 <b>{quotaMoney(average.currency, average.total)}</b>
                      </span>
                    ))
                  ) : (
                    <span title="从当前周期开始积累，每周期保存最后一次有效估算">
                      估算均值 <b>—</b>
                    </span>
                  )}
                  <span title="本周期截至额度同步时的本地请求：缓存读取 token ÷（未缓存输入 + 缓存读取 + 缓存写入 token）。按 token 总量汇总，不含输出；跳过未报告输入或缓存读取的请求。无有效输入时显示 —。">
                    缓存命中率{' '}
                    <b>
                      {estimate.cacheHitRate == null
                        ? '—'
                        : `${Number((estimate.cacheHitRate * 100).toFixed(1))}%`}
                    </b>
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {managing && account && (
        <QuotaCycleManager
          account={account}
          window={managing}
          close={() => setManaging(undefined)}
          onSnapshot={onSnapshot}
        />
      )}
      {quota?.extraCredits !== undefined && (
        <small>充值 / 免费额度：USD {quota.extraCredits.toFixed(2)}</small>
      )}
      {!overview && quota?.unit === 'USD' && quota.total?.used != null && (
        <small>本账期花费：USD {quota.total.used.toFixed(2)}</small>
      )}
      {!overview && (quota?.total || quota?.totalUnlimited) && (
        <small>
          总额度：
          {quota.totalUnlimited
            ? '无总额度限制'
            : `剩余 ${quotaRemaining(quota.total, quota.unit)}`}
        </small>
      )}
    </section>
  )
}
function QuotaCycleManager({
  account,
  window: quotaWindow,
  close,
  onSnapshot
}: {
  account: Pick<AccountView, 'id' | 'name'>
  window: QuotaCycleQuery['window']
  close: () => void
  onSnapshot?: (snapshot: GatewaySnapshot) => void
}) {
  const [cycles, setCycles] = useState<QuotaCostCycle[]>()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setError('')
    setCycles(undefined)
    api.getQuotaCycles({ accountId: account.id, window: quotaWindow }).then(
      (rows) => {
        if (active) setCycles(rows)
      },
      (e) => {
        if (active) setError(errorText(e))
      }
    )
    return () => {
      active = false
    }
  }, [account.id, quotaWindow, reload])
  async function toggle(cycle: QuotaCostCycle) {
    setSaving(true)
    setError('')
    try {
      const snapshot = await api.setQuotaCycleExcluded({
        accountId: account.id,
        window: quotaWindow,
        resetAt: cycle.resetAt,
        excluded: !cycle.excluded
      })
      onSnapshot?.(snapshot)
      setCycles((rows) =>
        rows?.map((row) =>
          row.resetAt === cycle.resetAt ? { ...row, excluded: !cycle.excluded } : row
        )
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  const duration = quotaWindow === 'fiveHour' ? 5 * 3600000 : 7 * 86400000
  return (
    <Modal
      title={`${account.name} · ${quotaWindow === 'fiveHour' ? '5H' : '7D'} 统计周期`}
      close={close}
    >
      <p className="muted">
        排除的周期不参与估算均值，可随时恢复。原始请求记录和当前额度不受影响。
      </p>
      {error && (
        <div role="alert" className="panel-error">
          {error}
          <button
            className="text-button"
            disabled={saving}
            onClick={() => setReload((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      )}
      {!cycles ? (
        !error && <p className="muted">正在加载…</p>
      ) : !cycles.length ? (
        <p className="muted">暂无有效周期记录，产生有效估算后会自动记录。</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table quota-cycle-table" aria-label="额度统计周期">
            <thead>
              <tr>
                <th>周期</th>
                <th>估算总额</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((cycle) => (
                <tr key={cycle.resetAt}>
                  <td>
                    <div>起：{quotaCycleDateTime(Date.parse(cycle.resetAt) - duration)}</div>
                    <div>止：{quotaCycleDateTime(Date.parse(cycle.resetAt))}</div>
                  </td>
                  <td title={`最后有效估算：${new Date(cycle.checkedAt).toLocaleString()}`}>
                    {cycle.amounts.map((amount) => (
                      <div key={amount.currency}>{quotaMoney(amount.currency, amount.total)}</div>
                    ))}
                  </td>
                  <td>{cycle.excluded ? '已排除' : '参与均值'}</td>
                  <td>
                    <button
                      className="text-button"
                      type="button"
                      disabled={saving}
                      onClick={() => void toggle(cycle)}
                    >
                      {cycle.excluded ? '恢复统计' : '排除统计'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const hintId = useId()
  return (
    <label className="field">
      <span>{label}</span>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            'aria-label': label,
            'aria-describedby': hint ? hintId : undefined
          })
        : children}
      {hint && <small id={hintId}>{hint}</small>}
    </label>
  )
}

export interface GatewayStatus {
  running: boolean
  port: number
  error: string
}

export type GatewayPage = 'overview' | 'settings' | 'flow'

export function GatewayPanel({
  onStatusChange,
  page,
  setPage
}: {
  page: GatewayPage
  setPage: (page: GatewayPage) => void
  onStatusChange: (status: GatewayStatus | undefined) => void
}) {
  const [snapshot, setSnapshot] = useState<GatewaySnapshot>()
  const [modelListOpen, setModelListOpen] = useState(false)
  const [cardDisplay, setCardDisplay] = useState(readCardDisplay)
  const [settingsSection, setSettingsSection] = useState<
    'display' | 'accounts' | 'gateway' | 'dashboard' | 'kimi-desktop'
  >('display')
  const [accountSpeeds, setAccountSpeeds] = useState<UsageStats['byAccount']>([])
  const [usageRefreshInterval, setUsageRefreshInterval] = useState(5000)
  const [tab, setTab] = useState<'accounts' | 'activity' | 'pricing'>('accounts')
  const [history, setHistory] = useState<RequestHistoryPage>()
  const [historyCursors, setHistoryCursors] = useState<(number | undefined)[]>([undefined])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const historyCursor = historyCursors.at(-1)
  useEffect(() => {
    if (page !== 'settings' || settingsSection !== 'accounts' || tab !== 'activity') return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    setHistoryLoading(true)
    const refresh = async () => {
      try {
        const result = await api.getRequestHistory(historyCursor)
        if (active) {
          setHistory(result)
          setHistoryError('')
        }
      } catch (e) {
        if (active) setHistoryError(errorText(e))
      } finally {
        if (active) setHistoryLoading(false)
      }
      if (active && historyCursor === undefined) timer = setTimeout(() => void refresh(), 1500)
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [page, settingsSection, tab, historyCursor])
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [accountEdit, setAccountEdit] = useState<
    AccountInput & { capabilities?: AccountCapabilities | null }
  >()
  const [rotatingKey, setRotatingKey] = useState(false)
  const [kimiImport, setKimiImport] = useState(false)
  const [kimiImportRegion, setKimiImportRegion] = useState<AccountInput['region']>('mainland-cn')
  const [confirmCodexImport, setConfirmCodexImport] = useState(false)
  const [deleting, setDeleting] = useState<{
    type: 'account'
    id: string
    name: string
  }>()
  useEffect(() => {
    onStatusChange(
      snapshot
        ? { running: snapshot.running, port: snapshot.settings.port, error: connectionError }
        : connectionError
          ? { running: false, port: 0, error: connectionError }
          : undefined
    )
  }, [snapshot?.running, snapshot?.settings.port, connectionError, onStatusChange])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data = await api.getGateway()
        if (active) {
          setConnectionError('')
          if (!busyRef.current) setSnapshot(data)
        }
      } catch (e) {
        if (active) {
          const message = errorText(e)
          setConnectionError(
            message.includes("No handler registered for 'gateway:get'") ||
              message.includes('api.getGateway is not a function')
              ? '界面已更新，但后台仍是旧版本。请完整退出并重新打开应用；开发时重新运行 npm run dev。仅刷新窗口无法更新后台。'
              : message
          )
        }
      }
      if (active) timer = setTimeout(() => void refresh(), 1500)
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])
  async function action(
    work: () => Promise<GatewaySnapshot | void>,
    message?: string
  ): Promise<boolean> {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const data = await work()
      if (data) setSnapshot(data)
      if (message) setNotice(message)
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const savedCardOrder = new Map((snapshot?.quotaCardOrder ?? []).map((id, index) => [id, index]))
  const cardIds = (snapshot?.accounts ?? [])
    .filter((account) => account.hasCredential && hasQuotaDisplay(account.capabilities))
    .sort((a, b) => (savedCardOrder.get(a.id) ?? Infinity) - (savedCardOrder.get(b.id) ?? Infinity))
    .map((account) => account.id)
  const cardDrag = useQuotaCardDrag(
    cardIds,
    (ids) => action(() => api.saveQuotaCardOrder(ids), '卡片顺序已保存'),
    busy
  )
  if (!snapshot)
    return (
      <div className="loading-state" role={connectionError ? 'alert' : 'status'}>
        {connectionError ? (
          <>
            <h2>网关服务尚未就绪</h2>
            <p>{connectionError}</p>
          </>
        ) : (
          '正在加载本地网关…'
        )}
      </div>
    )
  const group = snapshot.groups.find((g) => g.id === 'default') ?? snapshot.groups[0]
  const accounts = snapshot.accounts
  const newAccount = (): AccountInput => ({
    name: '',
    kind: 'api-key',
    region: 'mainland-cn',
    enabled: true,
    memberships: [{ groupId: group.id, priority: 0, weight: 1 }],
    secret: ''
  })
  const copy = (format: 'url' | 'key' | 'registry', lanAddress?: string) =>
    void action(
      () => api.copyConnection({ groupId: group.id, format, lanAddress }),
      '已复制到剪贴板'
    )
  const order = new Map(cardDrag.order.map((id, index) => [id, index]))
  const linkedAccounts = snapshot.accounts
    .filter((account) => account.hasCredential && hasQuotaDisplay(account.capabilities))
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
  const moveCard = (from: string, to: string) => {
    const ids = linkedAccounts.map((account) => account.id)
    const source = ids.indexOf(from),
      destination = ids.indexOf(to)
    if (source < 0 || destination < 0 || source === destination || busy) return
    ids.splice(source, 1)
    ids.splice(destination, 0, from)
    void action(() => api.saveQuotaCardOrder(ids), '卡片顺序已保存')
  }
  const stopBlocked = snapshot.running && snapshot.activeRequestCount > 0
  return (
    <div className={`gateway-workspace ${page === 'flow' ? 'flow-workspace' : ''}`}>
      {page !== 'flow' && (
        <div className="gateway-actions">
          {page === 'settings' && (
            <button className="button back-to-overview" onClick={() => setPage('overview')}>
              <ArrowLeft size={15} />
              返回概览
            </button>
          )}
          {page === 'overview' && (
            <div className="toolbar">
              {page === 'overview' && (
                <button
                  className="usage-refresh"
                  aria-label="切换自动刷新间隔"
                  title={`每 ${usageRefreshInterval / 1000} 秒自动刷新，点击切换为 ${usageRefreshInterval === 5000 ? 15 : usageRefreshInterval === 15000 ? 30 : 5} 秒`}
                  onClick={() =>
                    setUsageRefreshInterval((value) =>
                      value === 5000 ? 15000 : value === 15000 ? 30000 : 5000
                    )
                  }
                >
                  <RotateCcw size={14} />
                  <span>{usageRefreshInterval / 1000}s</span>
                </button>
              )}
              <button className="button" aria-pressed={false} onClick={() => setPage('settings')}>
                <Settings2 size={15} />
                设置
              </button>
              <button
                className="button"
                aria-haspopup="dialog"
                onClick={() => setModelListOpen(true)}
              >
                <List size={15} />
                可用模型
              </button>
              <span
                className={`gateway-toggle ${stopBlocked ? 'is-in-use' : ''}`}
                title={stopBlocked ? '网关使用中，请在请求结束后重试' : undefined}
              >
                <button
                  className={`button ${snapshot.running ? '' : 'primary'}`}
                  disabled={busy || stopBlocked}
                  aria-description={stopBlocked ? '网关使用中，请在请求结束后重试' : undefined}
                  onClick={() => void action(() => api.setGatewayRunning(!snapshot.running))}
                >
                  {snapshot.running ? <Square size={14} /> : <Play size={14} />}
                  {snapshot.running ? '停止网关' : '启动网关'}
                </button>
              </span>
            </div>
          )}
        </div>
      )}
      {(error || connectionError || snapshot.error) && (
        <div className="panel-error" role="alert">
          {error || connectionError || snapshot.error}
          <button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {page === 'flow' && (
        <LiveFlowPanel
          flows={snapshot.liveFlows ?? []}
          idleMinutes={snapshot.settings.flowIdleMinutes ?? 5}
          idleDisabled={busy || !!connectionError}
          onIdleMinutesChange={(minutes) =>
            action(() => api.saveGateway({ ...snapshot.settings, flowIdleMinutes: minutes }))
          }
          running={snapshot.running}
          stale={!!connectionError}
        />
      )}
      {page === 'overview' && (
        <section className="overview-quotas" aria-label="已关联账号额度">
          {!linkedAccounts.length ? (
            <div className="quota-overview-empty">
              <Users size={24} />
              <p>暂无可展示的额度或余额，账号仍可在账号管理中使用。</p>
              <button
                className="text-button"
                onClick={() => {
                  setSettingsSection('accounts')
                  setPage('settings')
                }}
              >
                前往账号管理
                <ArrowUpRight size={14} />
              </button>
            </div>
          ) : (
            <div className="overview-quota-grid" ref={cardDrag.grid}>
              {linkedAccounts.map((account) => {
                const status = accountStatus(account)
                const speeds = accountSpeeds.filter((item) => item.accountId === account.id)
                return (
                  <article
                    key={account.id}
                    data-quota-id={account.id}
                    className={`overview-account-card${cardDrag.dragging === account.id ? ' is-dragging' : ''}`}
                    aria-label={`${account.name} 额度`}
                  >
                    <div className="overview-account-heading">
                      <div className="account-name">
                        <button
                          type="button"
                          className="account-avatar quota-logo-handle"
                          draggable={false}
                          disabled={busy}
                          aria-label={`长按 ${account.name} Logo 拖动排序`}
                          title="长按 Logo 拖动排序；也可使用方向键移动"
                          onMouseDown={(event) => cardDrag.pointerDown(event, account.id)}
                          onContextMenu={(event) => event.preventDefault()}
                          onDragStart={(event) => event.preventDefault()}
                          onKeyDown={(event) => {
                            const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key)
                              ? -1
                              : ['ArrowRight', 'ArrowDown'].includes(event.key)
                                ? 1
                                : 0
                            if (delta) {
                              event.preventDefault()
                              const target =
                                linkedAccounts[
                                  linkedAccounts.findIndex((a) => a.id === account.id) + delta
                                ]
                              if (target) moveCard(account.id, target.id)
                            }
                          }}
                        >
                          <ProviderLogo provider={account.provider} />
                        </button>
                        <div>
                          <strong>{account.name}</strong>
                        </div>
                      </div>
                      <div className="overview-account-status">
                        <span
                          className="account-concurrency"
                          aria-label={`已占用并发数 ${account.runtime.active} / 并发上限 ${account.maxConcurrency}`}
                          title="已占用并发数 / 并发上限"
                        >
                          <Activity size={13} aria-hidden="true" />
                          <span>
                            {account.runtime.active} / {account.maxConcurrency}
                          </span>
                        </span>
                        <span className={`badge ${status.className}`}>{status.text}</span>
                        <button
                          className="icon-button"
                          aria-label={`刷新 ${account.name} 额度`}
                          title={
                            account.capabilities?.checkedAt
                              ? `刷新额度 · 更新于 ${new Date(account.capabilities.checkedAt).toLocaleString()}`
                              : '刷新额度'
                          }
                          disabled={busy}
                          onClick={() =>
                            void action(() => api.refreshAccount(account.id), '账号额度已刷新')
                          }
                        >
                          <RotateCcw size={13} />
                        </button>
                      </div>
                    </div>
                    {account.provider === 'deepseek' ? (
                      <BalanceDetails capabilities={account.capabilities} />
                    ) : (
                      <QuotaDetails
                        account={account}
                        onSnapshot={setSnapshot}
                        quota={account.capabilities?.quota}
                        estimates={account.quotaEstimates}
                        showEstimates={cardDisplay.estimates}
                        loading={false}
                        overview
                      />
                    )}
                    {cardDisplay.performance && (
                      <AccountPerformance stats={speeds} account={account} />
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </section>
      )}
      {page === 'overview' && (
        <UsageDashboard
          interval={usageRefreshInterval}
          onAccountStats={setAccountSpeeds}
          showTokenActivity={cardDisplay.tokenActivity}
          showUsageTrend={cardDisplay.usageTrend}
        />
      )}
      {page === 'settings' && (
        <div className="settings-layout">
          <nav className="settings-sidebar" aria-label="设置分类">
            <h1>设置</h1>
            {(
              [
                ['display', '卡片管理', PanelsTopLeft],
                ['accounts', '账号管理', Users],
                ['gateway', '网关设置', Settings2],
                ['dashboard', '远程仪表盘', Globe],
                ['kimi-desktop', '实验性功能', FlaskConical]
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                className={settingsSection === id ? 'selected' : ''}
                aria-current={settingsSection === id ? 'page' : undefined}
                onClick={() => setSettingsSection(id)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            <section
              hidden={settingsSection !== 'display'}
              aria-label="卡片管理"
              className="settings-pane"
            >
              <h2>卡片管理</h2>
              <p className="settings-description">
                选择概览中显示的模块，修改后立即生效并自动保存。
              </p>
              <div className="card-display-options">
                {(
                  [
                    ['estimates', '额度估算', '包含估算总额、估算可用、估算均值和缓存命中率'],
                    ['performance', '模型表现', '显示各模型的首 token 时间和生成速度'],
                    [
                      'tokenActivity',
                      'Token 活动',
                      '显示累计 Token、聊天时长、连续天数和活动热力图'
                    ],
                    [
                      'usageTrend',
                      '用量统计与趋势',
                      '显示当天的 Token 消耗、请求数、成本汇总和趋势图'
                    ]
                  ] as const
                ).map(([key, label, hint]) => (
                  <SettingsToggle
                    key={key}
                    label={label}
                    hint={hint}
                    checked={cardDisplay[key]}
                    onChange={(checked) => {
                      const next = { ...cardDisplay, [key]: checked }
                      try {
                        localStorage.setItem(cardDisplayKey, JSON.stringify(next))
                        setCardDisplay(next)
                      } catch {
                        setError('卡片管理设置保存失败，请重试。')
                      }
                    }}
                  />
                ))}
              </div>
            </section>
            <section
              hidden={settingsSection !== 'accounts'}
              aria-label="账号管理"
              className="settings-pane settings-accounts"
            >
              <h2>账号管理</h2>
              <p className="settings-description">管理账号、查看请求记录与模型费用。</p>
              <div className="content-panel">
                <div className="panel-tabs" role="tablist" aria-label="网关管理">
                  {(
                    [
                      ['accounts', '账号池', Users],
                      ['activity', '请求记录', Activity],
                      ['pricing', '费用管理', Coins]
                    ] as const
                  ).map(([id, name, Icon]) => (
                    <button
                      role="tab"
                      aria-selected={tab === id}
                      key={id}
                      onClick={() => setTab(id)}
                    >
                      <Icon size={15} />
                      {name}
                      {id === 'accounts' && (
                        <span className="count">{snapshot.accounts.length}</span>
                      )}
                    </button>
                  ))}
                </div>
                {tab === 'accounts' && (
                  <>
                    <div className="section-toolbar">
                      <span className="badge">并发与额度均衡 · 粘性会话优先</span>
                      <button
                        className="button primary"
                        onClick={() => setAccountEdit(newAccount())}
                      >
                        <Plus size={15} />
                        添加账号
                      </button>
                    </div>
                    <div className="connection-strip">
                      <div>
                        <span className={`status-dot ${group.enabled ? 'on' : ''}`} />
                        <code>{snapshot.baseUrl}/v1</code>
                      </div>
                      <div className="toolbar">
                        <button className="text-button" onClick={() => copy('url')}>
                          <Copy size={13} />
                          地址
                        </button>
                        <button className="text-button" onClick={() => copy('registry')}>
                          <Copy size={13} />
                          复制 api.json 链接
                        </button>
                      </div>
                    </div>
                    {(snapshot.lanBaseUrls ?? []).map((baseUrl) => (
                      <div className="connection-strip" key={baseUrl} aria-label="局域网连接">
                        <div>
                          <span
                            className={`status-dot ${snapshot.running && group.enabled ? 'on' : ''}`}
                          />
                          <code>{baseUrl}/v1</code>
                        </div>
                        <div className="toolbar">
                          <button
                            className="text-button"
                            onClick={() => copy('url', new URL(baseUrl).hostname)}
                          >
                            <Copy size={13} />
                            地址
                          </button>
                          <button className="text-button" onClick={() => copy('key')}>
                            <Copy size={13} />
                            密钥
                          </button>
                          <button
                            className="text-button"
                            onClick={() => copy('registry', new URL(baseUrl).hostname)}
                          >
                            <Copy size={13} />
                            复制 api.json 链接
                          </button>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => setRotatingKey(true)}
                          >
                            <RotateCcw size={13} />
                            轮换密钥
                          </button>
                        </div>
                      </div>
                    ))}
                    {snapshot.settings.lanSharing && !snapshot.lanBaseUrls?.length && (
                      <p className="muted">未检测到局域网 IPv4 地址，请连接 Wi-Fi 或有线网络。</p>
                    )}
                    <details className="connection-help">
                      <summary>如何接入客户端</summary>
                      <p>
                        Kimi Code：启动网关，复制「api.json 链接」，在「添加供应商 →
                        注册表」中粘贴到 「注册表
                        URL」。本机连接无需密钥；局域网连接需点击「密钥」复制并填入「API Key」。
                        模型来自已启用且同步成功的账号；同一 URL 重复导入可刷新模型列表。
                      </p>
                      <p>
                        本机客户端无需密钥（客户端要求填写时可填任意占位值），局域网客户端使用上方地址与网关密钥；Anthropic
                        Base URL 去掉末尾 /v1。Kimi 默认模型为 kimi-for-coding；使用 DeepSeek
                        时请将客户端模型改为同步列表中的 DeepSeek 模型。
                      </p>
                    </details>
                    {!accounts.length ? (
                      <div className="empty-state">
                        <div className="empty-icon">
                          <Users size={26} />
                        </div>
                        <h2>添加第一个账号</h2>
                        <p>
                          填写 Kimi Code、DeepSeek、MiniMax 或 OpenCode Go API Key 即可接入。
                          <br />
                          添加多个账号后，网关将自动均衡分配请求。
                        </p>
                        <button className="button" onClick={() => setAccountEdit(newAccount())}>
                          <Plus size={15} />
                          添加第一个账号
                        </button>
                      </div>
                    ) : (
                      <div className="table-scroll">
                        <table className="account-table">
                          <thead>
                            <tr>
                              <th>账号</th>
                              <th>状态</th>
                              <th>并发</th>
                              <th>额度 / 余额</th>
                              <th>成功 / 失败</th>
                              <th className="align-right">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {accounts.map((account) => {
                              const status = accountStatus(account)
                              return (
                                <tr key={account.id}>
                                  <td>
                                    <div className="account-name">
                                      <span className="account-avatar">
                                        <ProviderLogo provider={account.provider} />
                                      </span>
                                      <div>
                                        <strong>{account.name}</strong>
                                        <small>
                                          {account.provider === 'codex'
                                            ? 'Codex · 本地认证'
                                            : account.provider === 'custom'
                                              ? '自定义供应商'
                                              : account.provider === 'commandcode-goat'
                                                ? 'Command Code · GOAT Plan'
                                                : account.provider === 'minimax'
                                                  ? `MiniMax · Token Plan · ${account.region === 'global' ? '国际区' : '中国区'}`
                                                  : account.provider === 'opencode-go'
                                                    ? 'OpenCode Go · 订阅'
                                                    : account.provider === 'deepseek'
                                                      ? 'DeepSeek · 按量付费'
                                                      : `Kimi · ${account.region === 'global' ? '国际区' : '中国区'}`}
                                        </small>
                                      </div>
                                    </div>
                                  </td>
                                  <td>
                                    <span
                                      className={`badge ${status.className}`}
                                      title={account.runtime.lastError}
                                    >
                                      {status.text}
                                    </span>
                                  </td>
                                  <td>
                                    <div>
                                      {account.runtime.active}{' '}
                                      <span
                                        className="muted"
                                        title={capabilityWarning(
                                          account.capabilities,
                                          account.concurrencyOverride
                                        )}
                                      >
                                        / {account.maxConcurrency}
                                        {account.concurrencyOverride != null
                                          ? '（手动）'
                                          : account.capabilities?.maxConcurrency == null
                                            ? '（默认）'
                                            : ''}
                                      </span>
                                    </div>
                                    <div className="load-track">
                                      <i
                                        style={{
                                          width: `${Math.min(account.runtime.active / Math.max(account.maxConcurrency, 1), 1) * 100}%`
                                        }}
                                      />
                                    </div>
                                  </td>
                                  <td
                                    className="quota-summary"
                                    title={
                                      account.capabilities?.checkedAt
                                        ? `更新于 ${new Date(account.capabilities.checkedAt).toLocaleString()}`
                                        : '尚未同步'
                                    }
                                  >
                                    {account.provider === 'deepseek' ? (
                                      <BalanceDetails capabilities={account.capabilities} compact />
                                    ) : (
                                      <>
                                        <span>
                                          5 小时{' '}
                                          {quotaRemaining(
                                            account.capabilities?.quota?.fiveHour,
                                            account.capabilities?.quota?.unit
                                          )}
                                        </span>
                                        <small>
                                          7 天{' '}
                                          {quotaRemaining(
                                            account.capabilities?.quota?.weekly,
                                            account.capabilities?.quota?.unit
                                          )}
                                        </small>
                                        {account.capabilities?.quota?.monthly !== undefined && (
                                          <small>
                                            月{' '}
                                            {quotaRemaining(
                                              account.capabilities?.quota?.monthly,
                                              account.capabilities?.quota?.unit
                                            )}
                                          </small>
                                        )}
                                      </>
                                    )}
                                  </td>
                                  <td>
                                    {account.runtime.successes}{' '}
                                    <span className="muted">/ {account.runtime.failures}</span>
                                  </td>
                                  <td>
                                    <div className="row-actions">
                                      <button
                                        className="icon-button"
                                        title="同步上游信息"
                                        aria-label={`同步 ${account.name}`}
                                        disabled={busy || !account.hasCredential}
                                        onClick={() =>
                                          void action(
                                            () => api.refreshAccount(account.id),
                                            '上游信息已同步'
                                          )
                                        }
                                      >
                                        <RotateCcw size={14} />
                                      </button>
                                      <button
                                        className="text-button"
                                        disabled={busy}
                                        onClick={() =>
                                          void action(() =>
                                            api.saveAccount({
                                              ...account,
                                              enabled: !account.enabled
                                            })
                                          )
                                        }
                                      >
                                        {account.enabled ? '停用' : '启用'}
                                      </button>
                                      <button
                                        className="text-button"
                                        onClick={() => setAccountEdit({ ...account, secret: '' })}
                                      >
                                        编辑
                                      </button>
                                      {(account.runtime.authFailed ||
                                        account.runtime.cooldownUntil > Date.now()) && (
                                        <button
                                          className="icon-button"
                                          title="恢复调度"
                                          aria-label={`恢复 ${account.name}`}
                                          disabled={busy}
                                          onClick={() =>
                                            void action(() => api.resetAccount(account.id))
                                          }
                                        >
                                          <RotateCcw size={14} />
                                        </button>
                                      )}
                                      <button
                                        className="icon-button danger"
                                        aria-label={`删除 ${account.name}`}
                                        onClick={() =>
                                          setDeleting({
                                            type: 'account',
                                            id: account.id,
                                            name: account.name
                                          })
                                        }
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="panel-footnote">
                      <ShieldCheck size={13} />
                      凭据加密保存 · 粘性会话优先 · 新会话按并发与剩余额度分配
                    </div>
                  </>
                )}
                {tab === 'pricing' && <ModelPricing snapshot={snapshot} saved={setSnapshot} />}
                {tab === 'activity' && (
                  <>
                    <div className="section-toolbar">
                      <div>
                        <h2>请求记录</h2>
                        <p className="muted">
                          仅在本机保留最近 90 天的记录，每页 10 条；不记录提示词、回复或密钥。
                        </p>
                      </div>
                      <span className="badge">
                        共 {history?.total ?? snapshot.requests.length} 条
                      </span>
                    </div>
                    {historyError && (
                      <p className="form-error" role="alert">
                        {historyError}
                      </p>
                    )}
                    {!(history?.records.length ?? snapshot.requests.length) ? (
                      <div className="empty-state">
                        <Activity size={30} />
                        <h2>等待第一个请求</h2>
                        <p>启动网关，将客户端接入网关地址后，请求记录会显示在这里。</p>
                      </div>
                    ) : (
                      <div className="table-scroll">
                        <table className="request-history-table">
                          <thead>
                            <tr>
                              <th>时间</th>
                              <th>账号</th>
                              <th>模型</th>
                              <th>协议转换</th>
                              <th title="客户端请求中指定的思考强度；未指定或旧记录显示 —">
                                思考强度
                              </th>
                              <th>状态</th>
                              <th>耗时</th>
                              <th>费用</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(history?.records ?? snapshot.requests).map((r) => (
                              <tr key={r.id}>
                                <td>{new Date(r.time).toLocaleString()}</td>
                                <td>
                                  {r.account || '未分配'}
                                  {r.group === '模型测试' && (
                                    <span className="badge">模型测试</span>
                                  )}
                                </td>
                                <td className="model-cell">
                                  <span className="request-model-badge">
                                    <ModelLogo model={r.model || ''} />
                                    <span>{r.model || '模型列表'}</span>
                                  </span>
                                  {r.upstreamModel && r.upstreamModel !== r.model && (
                                    <div className="muted">→ {r.upstreamModel}</div>
                                  )}
                                </td>
                                <td className="protocol-conversion-cell">
                                  <div>
                                    <span className="muted">入站：</span>
                                    <code>
                                      {r.inboundRoute ??
                                        MODEL_PROTOCOLS.find((p) => p.value === r.protocol)
                                          ?.route ??
                                        '—'}
                                    </code>
                                  </div>
                                  <div>
                                    <span className="muted">转发：</span>
                                    <code>
                                      {r.upstreamRoute === null
                                        ? '未转发'
                                        : (r.upstreamRoute ?? '—')}
                                    </code>
                                  </div>
                                </td>
                                <td>{r.reasoningEffort ?? '—'}</td>
                                <td>
                                  <span
                                    className={`badge ${r.status < 400 ? 'healthy' : 'danger'}`}
                                  >
                                    {r.status}
                                  </span>
                                </td>
                                <td>
                                  <RequestLatency record={r} />
                                </td>
                                <td>
                                  <RequestCostCell record={r} snapshot={snapshot} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="section-toolbar">
                      <button
                        className="button"
                        disabled={historyLoading || historyCursors.length === 1}
                        onClick={() => setHistoryCursors((c) => c.slice(0, -1))}
                      >
                        上一页
                      </button>
                      <span className="muted">第 {historyCursors.length} 页</span>
                      <button
                        className="button"
                        disabled={historyLoading || !history?.nextCursor}
                        onClick={() => setHistoryCursors((c) => [...c, history!.nextCursor!])}
                      >
                        下一页
                      </button>
                    </div>
                  </>
                )}
              </div>
              <p className="workspace-note">
                {snapshot.settings.lanSharing ? '局域网共享已开启' : '仅监听本机'} · OpenAI /
                Anthropic 兼容 · 关闭窗口后 macOS 仍可保持网关运行，退出应用时停止
              </p>
            </section>
            <section
              hidden={settingsSection !== 'gateway'}
              aria-label="网关设置"
              className="settings-pane"
            >
              <h2>网关设置</h2>
              <p className="settings-description">配置连接方式与请求策略，保存后生效。</p>
              <SettingsEditor
                input={snapshot.settings}
                running={snapshot.running}
                saved={(data) => {
                  setSnapshot(data)
                  setNotice('网关设置已保存')
                }}
              />
            </section>
            <section
              hidden={settingsSection !== 'dashboard'}
              aria-label="远程仪表盘"
              className="settings-pane"
            >
              <DashboardSettings />
            </section>
            <section
              hidden={settingsSection !== 'kimi-desktop'}
              aria-label="实验性功能"
              className="settings-pane experiments-pane"
            >
              <KimiDesktopSettings>
                <section className="lab-card" aria-label="Codex 本地认证">
                  <header className="lab-card-heading">
                    <span className="lab-icon">
                      <ProviderLogo provider="codex" />
                    </span>
                    <div className="lab-heading-copy">
                      <h3>Codex 本地认证</h3>
                      <p>导入本机已登录的 ChatGPT 账号，通过本地网关使用 Codex 模型。</p>
                    </div>
                    <span className="lab-badge">实验性</span>
                  </header>
                  <footer className="lab-card-footer">
                    <span className="muted">导入后可在「账号管理」中查看和管理。</span>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => {
                        setError('')
                        setConfirmCodexImport(true)
                      }}
                    >
                      导入本地 Codex 认证
                    </button>
                  </footer>
                </section>
              </KimiDesktopSettings>
            </section>
          </div>
        </div>
      )}
      {modelListOpen && (
        <ModelListModal accounts={snapshot.accounts} close={() => setModelListOpen(false)} />
      )}
      {kimiImport && (
        <Modal
          title="导入本地 Kimi 登录态（仅 macOS）"
          close={() => {
            if (!busy) setKimiImport(false)
          }}
        >
          <p>
            读取本机 Kimi Code
            登录凭据，加密保存到网关，并同步模型和额度。同一账号重复导入会更新认证。
          </p>
          <p className="muted">当前仅支持 macOS，其他渠道导入将在优化后开放。</p>
          <Field label="登录账号区域">
            <select
              disabled={busy}
              value={kimiImportRegion}
              onChange={(e) => setKimiImportRegion(e.target.value as AccountInput['region'])}
            >
              <option value="mainland-cn">中国区 · kimi.com</option>
              <option value="global">国际区 · kimi.ai</option>
            </select>
          </Field>
          <p className="muted">
            请先在 Kimi Code 中登录。与 Kimi Code
            共用登录态时，令牌刷新可能相互影响；若登录失效，请重新登录后导入。
          </p>
          {error && <p role="alert">{error}</p>}
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              if (await action(() => api.importKimiAccount(kimiImportRegion), 'Kimi 登录态已导入'))
                setKimiImport(false)
            }}
          >
            {busy ? '正在导入…' : '导入登录态'}
          </button>
        </Modal>
      )}
      {confirmCodexImport && (
        <Modal
          title="导入 Codex 认证风险提醒"
          close={() => {
            if (!busyRef.current) setConfirmCodexImport(false)
          }}
        >
          <p>此功能为实验性功能。继续前，请了解以下风险：</p>
          <ul>
            <li>
              将 ChatGPT
              订阅用于本地网关或其他客户端可能存在合规风险，并可能触发服务商风控、限流或账号限制。请自行确认用途符合服务商要求。
            </li>
            <li>
              导入会读取本机 Codex 登录凭据，并加密保存在 Navo
              中。通过网关发起的请求会使用该账号的权限与额度；开启局域网共享后，持有网关密钥的设备也可使用。
            </li>
            <li>
              本机 Codex
              与网关共用认证时，令牌刷新可能相互影响，导致登录失效；届时需要重新登录并导入。
            </li>
          </ul>
          <p className="muted">请仅导入你有权使用的账号，并在了解上述风险后继续。</p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setConfirmCodexImport(false)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void action(
                  () => api.importCodexAccount(),
                  'Codex 认证已导入，可前往账号管理查看'
                ).then((ok) => {
                  if (ok) setConfirmCodexImport(false)
                })
              }
            >
              {busy ? '正在导入…' : '我已了解，继续导入'}
            </button>
          </div>
        </Modal>
      )}
      {accountEdit && (
        <AccountEditor
          input={accountEdit}
          importKimi={(region) => {
            setAccountEdit(undefined)
            setError('')
            setKimiImportRegion(region)
            setKimiImport(true)
          }}
          close={() => setAccountEdit(undefined)}
          saved={(data) => {
            setSnapshot(data)
            setAccountEdit(undefined)
            setNotice('账号已保存')
          }}
        />
      )}
      {rotatingKey && (
        <Modal
          title="轮换网关密钥？"
          close={() => {
            if (!busy) setRotatingKey(false)
          }}
        >
          <p>网关密钥在重启后保持不变，仅在手动轮换时更新。</p>
          <p>
            确认后将生成并保存新密钥，旧密钥立即无法发起新请求。局域网客户端需要更新密钥，本机连接无需密钥，已在处理的请求不受影响。
          </p>
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setRotatingKey(false)}>
              取消
            </button>
            <button
              className="button destructive"
              disabled={busy}
              onClick={() =>
                void action(
                  () => api.rotateGatewayKey(group.id),
                  '密钥已轮换，请点击「密钥」复制新密钥并更新客户端。'
                ).then((ok) => {
                  if (ok) setRotatingKey(false)
                })
              }
            >
              {busy ? '正在轮换…' : '确认轮换'}
            </button>
          </div>
          {error && (
            <p className="danger" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
      {deleting && (
        <Modal title="删除账号" close={() => setDeleting(undefined)}>
          <p>确定删除「{deleting.name}」？ 本地凭据会被移除，历史请求记录保留。</p>
          <div className="modal-actions">
            <button className="button" onClick={() => setDeleting(undefined)}>
              取消
            </button>
            <button
              className="button destructive"
              disabled={busy}
              onClick={() =>
                void action(() => api.deleteAccount(deleting.id)).then((ok) => {
                  if (ok) setDeleting(undefined)
                })
              }
            >
              确认删除
            </button>
          </div>
          {error && (
            <p className="danger" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </div>
  )
}

function ModelTestCell({
  draft,
  model
}: {
  draft: AccountInput & { capabilities?: AccountCapabilities | null }
  model: string
}) {
  const protocols = supportedModelProtocols(draft, model)
  const [chosen, setChosen] = useState<ModelProtocol | ''>('')
  const protocol = protocols.includes(chosen as ModelProtocol)
    ? (chosen as ModelProtocol)
    : protocols[0]
  const [result, setResult] = useState<AccountModelTestResult | null>(null)
  const [failure, setFailure] = useState('')
  const [testing, setTesting] = useState(false)
  const version = useRef(0)
  const pending = useRef(false)
  useEffect(() => {
    version.current++
    setResult(null)
    setFailure('')
    return () => {
      version.current++
    }
    // Parent snapshots and quota refreshes recreate draft objects. Only invalidate
    // a probe when its actual target or credentials change, not on every render.
  }, [draft.id, draft.provider, draft.baseUrl, draft.region, draft.secret, model, protocol])
  async function testModel() {
    if (pending.current || !protocol) return
    pending.current = true
    const current = ++version.current
    setTesting(true)
    setResult(null)
    setFailure('')
    try {
      const response = await api.testAccountModel({
        name: draft.name,
        id: draft.id,
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        region: draft.region,
        secret: draft.secret,
        model,
        protocol
      })
      if (current === version.current) setResult(response)
    } catch (error) {
      if (current === version.current) setFailure(errorText(error))
    } finally {
      pending.current = false
      setTesting(false)
    }
  }
  return (
    <td className="model-test-cell">
      <div className="model-test-controls">
        <select
          aria-label={`${model} 测试协议`}
          value={protocol ?? ''}
          disabled={testing || !protocol}
          onChange={(event) => setChosen(event.target.value as ModelProtocol)}
        >
          {MODEL_PROTOCOLS.filter((p) => protocols.includes(p.value)).map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button"
          disabled={
            testing ||
            !protocol ||
            (!draft.id && !draft.secret?.trim()) ||
            requiresKimiUserAgent(draft)
          }
          title={
            requiresKimiUserAgent(draft) ? '仅允许 Kimi UA 调用，请使用 Kimi 客户端测试' : undefined
          }
          onClick={() => void testModel()}
          aria-label={`测试模型 ${model}`}
        >
          {testing ? '测试中…' : '测试'}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {result && (
          <details className="model-test-result">
            <summary>成功 · {formatLatency(result.durationMs)}</summary>
            <p>{result.text}</p>
          </details>
        )}
        {failure && (
          <details className="model-test-result danger" open>
            <summary>测试失败</summary>
            <p>{failure}</p>
          </details>
        )}
      </div>
    </td>
  )
}

function AccountEditor({
  input,
  importKimi,
  close,
  saved
}: {
  input: AccountInput & { capabilities?: AccountCapabilities | null }
  importKimi: (region: AccountInput['region']) => void
  close: () => void
  saved: (data: GatewaySnapshot) => void
}) {
  const [draft, setDraft] = useState(input)
  const [confirmNonKimi, setConfirmNonKimi] = useState(false)
  const [modelMappings, setModelMappings] = useState<[string, string][]>(
    Object.entries(input.modelMappings ?? {})
  )
  const [manualModel, setManualModel] = useState('')
  const [manualModelError, setManualModelError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [capabilities, setCapabilities] = useState<AccountCapabilities | null>(
    input.capabilities ?? null
  )
  const [reading, setReading] = useState(false)
  const [probeError, setProbeError] = useState('')
  const probeVersion = useRef(0)
  const lock = useRef(false)
  const change = <K extends keyof AccountInput>(key: K, value: AccountInput[K]) => {
    if (key === 'provider') setModelMappings([])
    if (
      key === 'secret' ||
      key === 'region' ||
      key === 'provider' ||
      key === 'baseUrl' ||
      key === 'modelSource'
    ) {
      probeVersion.current++
      setCapabilities(null)
      setReading(false)
      setProbeError('')
    }
    setDraft((d) => ({
      ...d,
      ...(key === 'provider'
        ? {
            secret: '',
            baseUrl: '',
            modelSource: 'automatic' as const,
            modelProtocols: {},
            modelMappings: {},
            excludedModels: [],
            manualModels: []
          }
        : {}),
      [key]: value
    }))
  }
  const visibleModels = [
    ...new Set([
      ...(draft.provider === 'custom' && draft.modelSource === 'manual'
        ? []
        : (capabilities?.models ?? [])),
      ...(draft.manualModels ?? [])
    ])
  ].filter((model) => !draft.excludedModels?.includes(model))
  function addManualModel() {
    const models = [
      ...new Set(
        manualModel
          .split(/[\n,，]+/)
          .map((id) => id.trim())
          .filter(Boolean)
      )
    ]
    if (
      !models.length ||
      models.some((model) => model.length > 200 || /[\s\x00-\x1f\x7f]/.test(model))
    ) {
      setManualModelError('请输入有效的模型 ID，每个最多 200 个字符，不能包含空格或控制字符。')
      return
    }
    const combined = [...new Set([...(draft.manualModels ?? []), ...models])]
    if (combined.length > 2000) {
      setManualModelError('手动模型最多添加 2000 个。')
      return
    }
    setDraft((current) => ({
      ...current,
      manualModels: combined,
      excludedModels: current.excludedModels?.filter((id) => !models.includes(id))
    }))
    setManualModel('')
    setManualModelError('')
  }
  async function inspect() {
    const version = ++probeVersion.current
    setReading(true)
    setProbeError('')
    try {
      const result = await api.inspectAccount({
        id: draft.id,
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        region: draft.region,
        secret: draft.secret
      })
      if (version === probeVersion.current) setCapabilities(result)
    } catch (error) {
      if (version === probeVersion.current) setProbeError(errorText(error))
    } finally {
      if (version === probeVersion.current) setReading(false)
    }
  }
  useEffect(() => {
    if (input.id && !(input.provider === 'custom' && input.modelSource === 'manual')) void inspect()
    return () => {
      probeVersion.current++
    }
  }, [])
  async function save() {
    if (lock.current || confirmNonKimi) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      if (new Set(modelMappings.map(([from]) => from.trim())).size !== modelMappings.length)
        throw new Error('请求模型 ID 不能重复')
      saved(
        await api.saveAccount({
          ...draft,
          modelMappings: validateModelMappings(Object.fromEntries(modelMappings))
        })
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <Modal
        title={input.id ? '编辑账号' : '添加账号'}
        close={close}
        className="account-editor-modal"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={busy}>
            <Field label="账号名称">
              <input
                required
                maxLength={120}
                value={draft.name}
                placeholder="例如：日常开发账号"
                onChange={(e) => change('name', e.target.value)}
                autoFocus
              />
            </Field>
            <Field
              label="供应商"
              hint={
                !input.id ? '本地登录态导入仅支持 macOS，其他渠道导入将在优化后开放。' : undefined
              }
            >
              <select
                disabled={input.kind === 'oauth'}
                value={
                  draft.provider === 'kimi' && draft.kind === 'oauth'
                    ? 'kimi-local'
                    : (draft.provider ?? 'kimi')
                }
                onChange={(e) => {
                  if (e.target.value === 'kimi-local') importKimi(draft.region)
                  else change('provider', e.target.value as AccountInput['provider'])
                }}
              >
                {input.provider === 'codex' && <option value="codex">Codex · 本地认证</option>}
                <option value="kimi">Kimi Code · API Key</option>
                {(!input.id || (input.provider === 'kimi' && input.kind === 'oauth')) && (
                  <option value="kimi-local">Kimi Code · 本地登录态（仅 macOS）</option>
                )}
                <option value="commandcode-goat">Command Code · GOAT Plan</option>
                <option value="minimax">MiniMax · Token Plan</option>
                <option value="deepseek">DeepSeek · 按量付费</option>
                <option value="opencode-go">OpenCode Go · 订阅</option>
                <option value="custom">自定义供应商 · API Key</option>
              </select>
            </Field>
            {((draft.provider ?? 'kimi') === 'kimi' || draft.provider === 'minimax') && (
              <Field label="账号区域">
                <select
                  disabled={input.kind === 'oauth'}
                  value={draft.region}
                  onChange={(e) => change('region', e.target.value as AccountInput['region'])}
                >
                  <option value="mainland-cn">
                    中国区 · {draft.provider === 'minimax' ? 'minimaxi.com' : 'kimi.com'}
                  </option>
                  <option value="global">
                    国际区 · {draft.provider === 'minimax' ? 'minimax.io' : 'kimi.ai'}
                  </option>
                </select>
              </Field>
            )}
            {draft.kind !== 'oauth' && (
              <Field
                label="API Key"
                hint={
                  input.id
                    ? '留空保留现有密钥；尚未配置的账号须先填写密钥。'
                    : draft.provider === 'commandcode-goat'
                      ? '填写 Command Code Studio 生成的 API Key，需订阅 GOAT 或更高套餐。'
                      : draft.provider === 'minimax'
                        ? '填写 MiniMax Token Plan 的 Subscription Key（套餐密钥）。'
                        : draft.provider === 'opencode-go'
                          ? '填写已订阅 Go 的 OpenCode API Key。'
                          : draft.provider === 'deepseek'
                            ? '填写 DeepSeek 开放平台生成的密钥。'
                            : draft.provider === 'custom'
                              ? '填写自定义供应商的 API Key。'
                              : '填写 Kimi Code 控制台生成的密钥。'
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={draft.secret ?? ''}
                  required={!input.id || (draft.provider ?? 'kimi') !== (input.provider ?? 'kimi')}
                  placeholder={input.id ? '留空保留现有密钥' : 'sk-…'}
                  onChange={(e) => change('secret', e.target.value)}
                  onBlur={() => {
                    if (
                      draft.secret?.trim() &&
                      !(
                        draft.provider === 'custom' &&
                        (draft.modelSource === 'manual' || !draft.baseUrl?.trim())
                      )
                    )
                      void inspect()
                  }}
                />
              </Field>
            )}
            {draft.provider === 'kimi' && draft.kind === 'oauth' && (
              <p className="muted">
                认证来自本地 Kimi Code；更新登录态请在「添加账号」中选择「Kimi Code · 本地登录态」。
              </p>
            )}
            {draft.provider === 'codex' && (
              <p className="muted">
                认证来自本地 Codex，更新凭据请前往「实验性功能 → 导入本地 Codex 认证」。
              </p>
            )}
            {draft.provider === 'kimi' && draft.kind === 'oauth' && (
              <Field
                label="允许非 Kimi UA 调度"
                hint="默认关闭，仅调度 Kimi UA 请求。开启需确认风险，不会修改请求的 User-Agent。"
              >
                <input
                  type="checkbox"
                  role="switch"
                  className="account-policy-switch"
                  checked={draft.kimiOAuthOnly === false}
                  onChange={(event) => {
                    if (event.target.checked) setConfirmNonKimi(true)
                    else change('kimiOAuthOnly', true)
                  }}
                />
              </Field>
            )}
            <Field
              label="上游 Base URL"
              hint={
                draft.provider === 'custom'
                  ? '填写完整 API 基础地址（包含 /v1 等前缀），例如 https://api.example.com/v1。支持 OpenAI 兼容接口。'
                  : '由供应商和区域自动确定，转发时按协议选择端点。'
              }
            >
              <input
                type="url"
                required
                readOnly={draft.provider !== 'custom'}
                value={
                  draft.provider === 'custom'
                    ? (draft.baseUrl ?? '')
                    : accountBaseUrl(draft.region, draft.provider)
                }
                placeholder="https://api.example.com/v1"
                onChange={(e) => change('baseUrl', e.target.value)}
                onBlur={() => {
                  if (
                    draft.provider === 'custom' &&
                    draft.modelSource !== 'manual' &&
                    draft.baseUrl?.trim() &&
                    (draft.secret?.trim() || draft.id)
                  )
                    void inspect()
                }}
              />
            </Field>
            {draft.provider === 'custom' && (
              <Field
                label="模型列表来源"
                hint="自动模式读取 Base URL 下的 /models；服务不支持时可选择仅手动配置。"
              >
                <select
                  value={draft.modelSource ?? 'automatic'}
                  onChange={(e) => change('modelSource', e.target.value as 'automatic' | 'manual')}
                >
                  <option value="automatic">自动获取（可手动补充）</option>
                  <option value="manual">仅手动配置</option>
                </select>
              </Field>
            )}
            <div className="form-grid">
              <Field
                label="账号并发上限"
                hint={
                  draft.concurrencyOverride != null
                    ? '手动设置优先，刷新上游不会覆盖。有效范围 1–1000。'
                    : `自动模式：优先采用上游值，未获取到时默认 ${DEFAULT_ACCOUNT_CONCURRENCY}。`
                }
              >
                <input
                  type="number"
                  required
                  min={draft.concurrencyOverride == null ? 0 : 1}
                  max={draft.concurrencyOverride == null ? 100000 : 1000}
                  value={
                    Number.isNaN(draft.concurrencyOverride)
                      ? ''
                      : (draft.concurrencyOverride ??
                        capabilities?.maxConcurrency ??
                        DEFAULT_ACCOUNT_CONCURRENCY)
                  }
                  onChange={(event) => change('concurrencyOverride', event.target.valueAsNumber)}
                />
              </Field>
            </div>
            <div className="concurrency-mode">
              <small>
                {draft.concurrencyOverride == null
                  ? '当前使用自动并发上限'
                  : `自动值：${capabilities?.maxConcurrency ?? `${DEFAULT_ACCOUNT_CONCURRENCY}（默认）`}`}
              </small>
              {draft.concurrencyOverride != null && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => change('concurrencyOverride', null)}
                >
                  恢复自动
                </button>
              )}
            </div>
            <div className="capability-sync">
              <button
                className="button"
                type="button"
                disabled={
                  busy ||
                  reading ||
                  (draft.provider === 'custom' &&
                    (draft.modelSource === 'manual' || !draft.baseUrl?.trim())) ||
                  (!input.id && !draft.secret?.trim())
                }
                onClick={() => void inspect()}
              >
                <RotateCcw size={14} />
                {reading
                  ? '正在获取…'
                  : draft.provider === 'custom'
                    ? '获取模型列表'
                    : '获取上游信息'}
              </button>
              {capabilities && (
                <small>已同步 {new Date(capabilities.checkedAt).toLocaleTimeString()}</small>
              )}
            </div>
            <section className="model-protocols">
              <div className="model-protocols-heading">
                <strong>可用模型</strong>
                {!!draft.excludedModels?.length && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => change('excludedModels', [])}
                  >
                    恢复已删除模型（{draft.excludedModels.length}）
                  </button>
                )}
                {!!Object.keys(draft.modelProtocols ?? {}).length && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => change('modelProtocols', {})}
                  >
                    恢复默认协议
                  </button>
                )}
              </div>
              <p className="model-protocols-hint">
                勾选模型在此账号上原生支持的
                API，至少选择一项。优先同协议调用，其他入口自动转换；刷新不会覆盖选择。
                删除仅作用于此账号，保存后生效，上游同步不会恢复已删除模型。
                测试使用当前填写的账号配置和所选协议发送简短请求，无需保存，会消耗少量额度。
              </p>
              <div className="manual-model-entry">
                <label htmlFor="manual-model-id">手动添加模型</label>
                <div className="manual-model-controls">
                  <textarea
                    id="manual-model-id"
                    rows={3}
                    value={manualModel}
                    maxLength={402000}
                    placeholder="每行一个模型 ID，或用逗号分隔"
                    onChange={(event) => {
                      setManualModel(event.target.value)
                      setManualModelError('')
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        (event.ctrlKey || event.metaKey) &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault()
                        addManualModel()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="button"
                    disabled={!manualModel.trim()}
                    onClick={addManualModel}
                  >
                    添加模型
                  </button>
                </div>
                <p className="model-protocols-hint">
                  用于补充上游未列出的模型，保存账号后生效；刷新时保留，实际可用性取决于上游账号权限。
                </p>
                {manualModelError && (
                  <p className="form-error" role="alert">
                    {manualModelError}
                  </p>
                )}
              </div>
              {reading ? (
                <p className="muted" role="status">
                  正在获取…
                </p>
              ) : visibleModels.length ? (
                <div className="model-protocol-list">
                  <table aria-label="可用模型">
                    <thead>
                      <tr>
                        <th scope="col">模型名</th>
                        {MODEL_PROTOCOLS.map((p) => (
                          <th scope="col" key={p.value}>
                            {p.label}
                          </th>
                        ))}
                        <th scope="col" className="model-test-heading">
                          测试
                        </th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleModels.map((model) => {
                        const selected = supportedModelProtocols({ ...draft, capabilities }, model)
                        return (
                          <tr key={model}>
                            <th scope="row" title={model}>
                              {model}
                              {draft.manualModels?.includes(model) && (
                                <span className="badge">手动</span>
                              )}
                            </th>
                            {MODEL_PROTOCOLS.map((p) => (
                              <td key={p.value}>
                                <input
                                  type="checkbox"
                                  aria-label={`${model} ${p.label}`}
                                  disabled={draft.provider === 'codex'}
                                  checked={selected.includes(p.value)}
                                  onChange={(event) => {
                                    const next = event.target.checked
                                      ? [...selected, p.value]
                                      : selected.filter((value) => value !== p.value)
                                    change('modelProtocols', {
                                      ...draft.modelProtocols,
                                      [model]: next
                                    })
                                  }}
                                />
                              </td>
                            ))}
                            <ModelTestCell draft={{ ...draft, capabilities }} model={model} />
                            <td>
                              <button
                                type="button"
                                className="icon-button danger"
                                aria-label={`删除模型 ${model}`}
                                title={`删除模型 ${model}`}
                                onClick={() =>
                                  change('excludedModels', [...(draft.excludedModels ?? []), model])
                                }
                              >
                                <Trash2 size={14} />
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">
                  {capabilities
                    ? draft.excludedModels?.length
                      ? '暂无可用模型，可恢复已删除模型'
                      : '上游暂无可用模型'
                    : '填写 API Key 后自动获取'}
                </p>
              )}
            </section>
            <ModelMappingEditor
              rows={modelMappings}
              models={visibleModels}
              onChange={(rows) => {
                setModelMappings(rows)
                setError('')
              }}
            />
            {draft.provider === 'deepseek' ? (
              <BalanceDetails capabilities={capabilities} loading={reading} />
            ) : (
              <QuotaDetails quota={capabilities?.quota} loading={reading} />
            )}
            {capabilities?.warning && (
              <p className="metadata-warning">
                {capabilityWarning(capabilities, draft.concurrencyOverride)}
              </p>
            )}
            {probeError && (
              <p className="form-error" role="alert">
                {probeError}
              </p>
            )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => change('enabled', e.target.checked)}
              />
              启用账号，参与调度
            </label>
          </fieldset>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button className="button" type="button" onClick={close}>
              取消
            </button>
            <button className="button primary" disabled={busy} type="submit">
              {busy ? '正在保存…' : '保存账号'}
            </button>
          </div>
        </form>
      </Modal>
      {confirmNonKimi && (
        <Modal title="允许非 Kimi UA 调度？" close={() => setConfirmNonKimi(false)}>
          <p>
            开启后，非 Kimi 客户端也可使用此 OAuth 账号，可能不符合 Kimi Code
            的使用规范，并可能导致服务受限。
          </p>
          <p>
            请勿伪造或篡改客户端身份、转售账号或 API
            访问权限，也请勿进行非个人交互式使用。开启此选项不会修改请求的
            User-Agent，也不代表上游允许这些请求。
          </p>
          <p className="muted">确认后需保存账号才会生效。</p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setConfirmNonKimi(false)}>
              保持关闭
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                change('kimiOAuthOnly', false)
                setConfirmNonKimi(false)
              }}
            >
              我已了解风险，允许调度
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

function SettingsEditor({
  input,
  running,
  saved
}: {
  input: GatewaySettings
  running: boolean
  saved: (data: GatewaySnapshot) => void
}) {
  const [draft, setDraft] = useState(input)
  const [manualModel, setManualModel] = useState('')
  const [manualModelError, setManualModelError] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [confirmLanSharing, setConfirmLanSharing] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || confirmLanSharing) return
    setBusy(true)
    setError('')
    try {
      saved(await api.saveGateway(draft))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy}>
          <section className="settings-group">
            <h3>连接与访问</h3>
            <Field
              label="监听端口"
              hint={
                running
                  ? '更改端口前请先停止网关。'
                  : '默认仅本机可用；开启局域网共享后，同一网络的设备也可使用网关密钥接入。'
              }
            >
              <input
                type="number"
                min={1024}
                max={65535}
                required
                disabled={running}
                value={draft.port}
                onChange={(e) => setDraft({ ...draft, port: e.target.valueAsNumber })}
              />
            </Field>
            <SettingsToggle
              label="局域网共享"
              hint={
                running
                  ? '切换共享前请先停止网关，保存后重新启动。'
                  : '同一网络的设备可通过网关密钥接入。'
              }
              checked={draft.lanSharing ?? false}
              disabled={running}
              onChange={(checked) => {
                if (checked) setConfirmLanSharing(true)
                else setDraft({ ...draft, lanSharing: false })
              }}
            />
          </section>
          <section className="settings-group">
            <h3>请求策略</h3>
            <div className="form-grid">
              <Field label="请求总超时（秒）">
                <input
                  type="number"
                  min={5}
                  max={1800}
                  required
                  value={draft.timeoutSeconds}
                  onChange={(e) => setDraft({ ...draft, timeoutSeconds: e.target.valueAsNumber })}
                />
              </Field>
              <Field label="最大尝试次数" hint="包含首次请求；同一请求不重复尝试同一账号。">
                <input
                  type="number"
                  min={1}
                  max={10}
                  required
                  value={draft.maxAttempts}
                  onChange={(e) => setDraft({ ...draft, maxAttempts: e.target.valueAsNumber })}
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field
                label="会话保持（秒）"
                hint="默认 300 秒；0 表示关闭。优先复用同一账号以保留缓存命中。"
              >
                <input
                  type="number"
                  min={0}
                  max={86400}
                  required
                  value={draft.stickySeconds ?? 300}
                  onChange={(e) => setDraft({ ...draft, stickySeconds: e.target.valueAsNumber })}
                />
              </Field>
              <Field
                label="失败冷却（秒）"
                hint="限流时尊重上游更长的 Retry-After；401/403 暂停账号，需更新凭据或手动恢复。"
              >
                <input
                  type="number"
                  min={1}
                  max={3600}
                  required
                  value={draft.cooldownSeconds}
                  onChange={(e) => setDraft({ ...draft, cooldownSeconds: e.target.valueAsNumber })}
                />
              </Field>
            </div>
          </section>
          <section className="settings-group">
            <h3>启动行为</h3>
            <SettingsToggle
              label="打开应用时自动启动网关"
              hint="启动 Navo 后自动恢复网关服务。"
              checked={draft.autoStart}
              onChange={(checked) => setDraft({ ...draft, autoStart: checked })}
            />
          </section>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(input)
              setError('')
            }}
          >
            重置修改
          </button>
          <button className="button primary" disabled={busy}>
            保存设置
          </button>
        </div>
      </form>
      {confirmLanSharing && (
        <Modal title="开启局域网共享？" close={() => setConfirmLanSharing(false)}>
          <p>
            开启局域网共享后，同一网络内的其他设备可通过网关密钥使用你的账号。共享使用可能触发部分厂商的风控措施，是否确认开启？
          </p>
          <div className="modal-actions">
            <button className="button" type="button" onClick={() => setConfirmLanSharing(false)}>
              取消
            </button>
            <button
              className="button primary"
              type="button"
              onClick={() => {
                setDraft((value) => ({ ...value, lanSharing: true }))
                setConfirmLanSharing(false)
              }}
            >
              确认开启
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

const priceFields = [
  ['input', '输入单价'],
  ['output', '输出单价'],
  ['cacheRead', '缓存读取'],
  ['cacheWrite', '缓存写入']
] as const
const providerNames = {
  custom: '自定义供应商',
  codex: 'Codex',
  kimi: 'Kimi Code',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  'commandcode-goat': 'Command Code',
  'opencode-go': 'OpenCode Go'
}

function ModelPricing({
  snapshot,
  saved
}: {
  snapshot: GatewaySnapshot
  saved: (data: GatewaySnapshot) => void
}) {
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<ModelPrice>()
  const [notice, setNotice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const refreshLock = useRef(false)
  const mounted = useRef(false)
  async function refresh(force = false) {
    if (refreshLock.current) return
    refreshLock.current = true
    setRefreshing(true)
    setRefreshError('')
    try {
      const data = await api.refreshModelPrices(force)
      if (mounted.current) saved(data)
    } catch (e) {
      if (mounted.current) setRefreshError(errorText(e))
    } finally {
      refreshLock.current = false
      if (mounted.current) setRefreshing(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), 60 * 60 * 1000)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [])
  const catalog = snapshot.modelPriceCatalog
  const fallbackFor = (price: ModelPrice) => matchedModelPrice(price, catalog)
  const models = new Map<string, ModelPrice>()
  for (const account of snapshot.accounts) {
    const provider = account.provider ?? 'kimi'
    for (const model of account.models) {
      const key = JSON.stringify([provider, model])
      if (!models.has(key))
        models.set(
          key,
          snapshot.modelPrices?.find((p) => p.provider === provider && p.model === model) ?? {
            provider,
            model,
            currency: catalog?.prices.some((p) => p.provider === provider && p.model === model)
              ? 'USD'
              : 'CNY',
            input: null,
            output: null,
            cacheRead: null,
            cacheWrite: null
          }
        )
    }
  }
  const rows = [...models.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
  )
  const filtered = rows.filter((p) =>
    `${providerNames[p.provider]} ${p.model}`.toLowerCase().includes(search.trim().toLowerCase())
  )
  return (
    <>
      <div className="section-toolbar pricing-toolbar">
        <div>
          <strong>模型单价</strong>
          <p className="muted">
            每百万 token · 手动值优先，留空使用 API 默认值；没有价格时按 0 计费。
          </p>
        </div>
        <div className="toolbar">
          <input
            aria-label="搜索模型或供应商"
            placeholder="搜索模型或供应商"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="button" disabled={refreshing} onClick={() => void refresh(true)}>
            <RotateCcw size={14} />
            {refreshing ? '正在获取…' : '刷新默认价格'}
          </button>
        </div>
      </div>
      <p className="pricing-footnote muted">
        来源：Models.dev · USD / 百万 token ·{' '}
        {catalog?.updatedAt
          ? `上次更新 ${new Date(catalog.updatedAt).toLocaleString()}`
          : '尚未获取默认价格'}{' '}
        · 缓存 24 小时
      </p>
      {(refreshError || catalog?.error) && (
        <p className="pricing-notice form-error" role="alert">
          {refreshError || catalog?.error}
        </p>
      )}
      {notice && (
        <p className="pricing-notice" role="status">
          {notice}
        </p>
      )}
      {!filtered.length ? (
        <div className="empty-state">
          <Coins size={26} />
          <h3>{rows.length ? '没有匹配的模型' : '暂无已支持模型'}</h3>
          <p>
            {rows.length
              ? '请尝试其他模型名或供应商。'
              : '添加账号并获取上游信息后，模型会自动出现在这里。'}
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="pricing-table" aria-label="模型单价">
            <thead>
              <tr>
                <th>供应商</th>
                <th>模型</th>
                {priceFields.map(([key, label]) => (
                  <th key={key}>{label}</th>
                ))}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((price) => {
                const fallback = fallbackFor(price)
                return (
                  <tr key={JSON.stringify([price.provider, price.model])}>
                    <td>{providerNames[price.provider]}</td>
                    <td className="model-cell">
                      {price.model}
                      {fallback?.tiered && (
                        <small className="pricing-source">API 为基础档价格</small>
                      )}
                    </td>
                    {priceFields.map(([key]) => {
                      const value = resolveModelPrice(price, fallback, key)
                      return (
                        <td key={key}>
                          {value ? (
                            <>
                              {value.amount}
                              <small className="pricing-source">
                                {value.currency} ·{' '}
                                {value.source === 'manual'
                                  ? '手动'
                                  : value.source === 'api'
                                    ? 'API 默认'
                                    : '默认 0'}
                              </small>
                            </>
                          ) : (
                            <span className="muted">未设置</span>
                          )}
                        </td>
                      )
                    })}
                    <td>
                      <button
                        className="text-button"
                        aria-label={`编辑 ${providerNames[price.provider]} ${price.model} 单价`}
                        onClick={() => {
                          setNotice('')
                          setEditing(price)
                        }}
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="pricing-footnote muted">
        共 {rows.length} 个模型 · 手动填写 0
        也会覆盖默认值；不同币种分别标注，不自动换算。订阅模型价格仅作参考，不代表订阅费用；阶梯计价模型仅展示基础档。
      </p>
      {editing && (
        <ModelPriceEditor
          input={editing}
          catalog={catalog}
          close={() => setEditing(undefined)}
          saved={(data) => {
            saved(data)
            setEditing(undefined)
            setNotice('模型单价已保存')
          }}
        />
      )}
    </>
  )
}

function ModelPriceEditor({
  input,
  catalog,
  close,
  saved
}: {
  input: ModelPrice
  catalog: ModelPriceCatalogSnapshot | undefined
  close: () => void
  saved: (data: GatewaySnapshot) => void
}) {
  const [catalogMatch, setCatalogMatch] = useState(input.catalogMatch)
  const [query, setQuery] = useState(input.catalogMatch?.model ?? input.model)
  const [searchOpen, setSearchOpen] = useState(false)
  const automaticMatch = autoMatchCatalog(catalog?.entries ?? [], input.model, input.provider)
  const fallback = matchedModelPrice({ ...input, catalogMatch }, catalog)
  const results = searchOpen ? searchCatalogPrices(catalog?.entries ?? [], query) : []
  const [currency, setCurrency] = useState(input.currency)
  const [amounts, setAmounts] = useState(() =>
    Object.fromEntries(
      priceFields.map(([key]) => [key, input[key] === null ? '' : String(input[key])])
    )
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const values = Object.fromEntries(
        priceFields.map(([key]) => [key, amounts[key].trim() === '' ? null : Number(amounts[key])])
      ) as Pick<ModelPrice, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
      saved(await api.saveModelPrice({ ...input, ...values, currency, catalogMatch }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <Modal
      title="编辑模型单价"
      close={() => {
        if (!lock.current) close()
      }}
    >
      <form onSubmit={(e) => void submit(e)}>
        <p>
          <strong>{input.model}</strong>
          <br />
          <span className="muted">{providerNames[input.provider]} · 每百万 token</span>
        </p>
        <fieldset disabled={busy}>
          <section className="price-match-picker">
            <div className="model-protocols-heading">
              <strong>匹配 Models.dev 价格</strong>
              <button
                type="button"
                className="text-button"
                onClick={() => setSearchOpen(!searchOpen)}
              >
                {searchOpen ? '收起搜索' : '搜索并匹配模型'}
              </button>
            </div>
            <p className="muted">
              {catalogMatch
                ? `已匹配：${catalogMatch.provider} / ${catalogMatch.model}`
                : automaticMatch
                  ? `自动匹配：${automaticMatch.providerName} / ${automaticMatch.model}`
                  : '尚未找到对应模型，可搜索并选择目录条目。'}
            </p>
            {catalogMatch && (
              <button
                type="button"
                className="text-button"
                onClick={() => setCatalogMatch(undefined)}
              >
                取消匹配，恢复自动识别
              </button>
            )}
            {searchOpen && (
              <>
                <Field
                  label="搜索 Models.dev 模型"
                  hint="支持模型 ID、名称和供应商，忽略前缀、大小写和分隔符。同名条目优先选择有价格的来源；不同供应商价格可能不同。"
                >
                  <input
                    type="search"
                    value={query}
                    placeholder="例如 kimi k3、DeepSeek、Claude"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </Field>
                {!results.length ? (
                  <p className="muted" role="status">
                    {catalog?.entries?.length
                      ? '没有找到相关模型，可更换关键词，或在下方直接输入价格。'
                      : '价格目录尚不可用，请返回列表刷新默认价格，或直接输入价格。'}
                  </p>
                ) : (
                  <>
                    <p className="muted">
                      找到 {results.length} 项
                      {results.length > 40 ? '，显示前 40 项，请缩小搜索范围' : ''} · USD / 百万
                      token
                    </p>
                    <div className="price-match-results">
                      {results.slice(0, 40).map((entry) => (
                        <div
                          className="price-match-result"
                          key={JSON.stringify([entry.provider, entry.model])}
                        >
                          <div>
                            <strong>{entry.name}</strong>
                            <small>
                              {entry.providerName} · {entry.provider} / {entry.model}
                            </small>
                            <small>
                              {priceFields
                                .map(([key, label]) => `${label} ${entry[key] ?? '未提供'}`)
                                .join(' · ')}
                              {entry.tiered ? ' · 基础档价格' : ''}
                            </small>
                          </div>
                          <button
                            type="button"
                            className="button"
                            aria-label={`应用 ${entry.provider} / ${entry.model} 价格`}
                            onClick={() => {
                              setCatalogMatch({ provider: entry.provider, model: entry.model })
                              setCurrency('USD')
                              setAmounts(Object.fromEntries(priceFields.map(([key]) => [key, ''])))
                              setSearchOpen(false)
                            }}
                          >
                            应用价格
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <p className="muted">
                  应用后将清空当前手动值，使用所选模型的默认价格并跟随更新；点击「保存单价」后生效。
                </p>
              </>
            )}
          </section>
          <Field label="币种" hint="切换币种只修改标记，不会换算已填单价。">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as ModelPrice['currency'])}
            >
              <option value="CNY">人民币（CNY）</option>
              <option value="USD">美元（USD）</option>
            </select>
          </Field>
          <div className="form-grid">
            {priceFields.map(([key, label]) => (
              <Field
                key={key}
                label={`${label}（${currency} / 百万 token）`}
                hint={
                  fallback?.[key] != null
                    ? `留空使用 API 默认：${fallback[key]} USD / 百万 token`
                    : 'API 未提供此单价，留空按 0 计费'
                }
              >
                <input
                  type="number"
                  min="0"
                  max="1000000000"
                  step="any"
                  placeholder={
                    fallback?.[key] != null ? `API 默认：${fallback[key]} USD` : '默认：0'
                  }
                  value={amounts[key]}
                  onChange={(e) => setAmounts((old) => ({ ...old, [key]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
          <p className="muted">
            输入单价指未命中缓存的输入；只填写要覆盖的值，留空使用 API 默认值，0 表示免费。
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setAmounts(Object.fromEntries(priceFields.map(([key]) => [key, ''])))
              if (fallback) setCurrency(fallback.currency)
            }}
          >
            恢复 API 默认值
          </button>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? '正在保存…' : '保存单价'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function formatRequestMoney(value: number) {
  return value > 0 && value < 0.000001
    ? '<0.000001'
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

function RequestCostCell({
  record,
  snapshot
}: {
  record: RequestRecord
  snapshot: GatewaySnapshot
}) {
  const cost = requestCost(record, snapshot)
  const details = requestCostDetails(record, snapshot)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number }>()
  const show = () => {
    clearTimeout(timer.current)
    const bounds = button.current?.getBoundingClientRect()
    if (!bounds) return
    setPosition({
      left: Math.max(12, Math.min(bounds.right - 500, window.innerWidth - 512)),
      ...(bounds.top > 300
        ? { bottom: window.innerHeight - bounds.top + 8 }
        : { top: bounds.bottom + 8 })
    })
  }
  const hide = () => {
    timer.current = setTimeout(() => setPosition(undefined), 120)
  }
  useEffect(() => {
    const close = () => setPosition(undefined)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      clearTimeout(timer.current)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [])
  return (
    <span className="request-cost">
      <span>
        {cost.amounts.length
          ? cost.amounts.map(({ currency, value }) => (
              <span className="request-cost-amount" key={currency}>
                {currency} {formatRequestMoney(value)}
              </span>
            ))
          : '—'}
      </span>
      <button
        ref={button}
        type="button"
        className="request-cost-help"
        aria-label="查看请求费用明细"
        aria-describedby={position ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={() => setPosition(undefined)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPosition(undefined)
        }}
      >
        <CircleHelp size={14} />
      </button>
      {position &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="request-cost-tooltip"
            style={position}
            onMouseEnter={() => clearTimeout(timer.current)}
            onMouseLeave={hide}
          >
            <strong>请求费用明细</strong>
            <p className="muted">{record.upstreamModel ?? record.model} · 单价按每百万 token 计</p>
            <table>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>Token 数</th>
                  <th>单价</th>
                  <th>费用</th>
                </tr>
              </thead>
              <tbody>
                {details.map(({ field, tokens, price, subtotal }) => (
                  <tr key={field}>
                    <th>{priceFields.find(([key]) => key === field)![1].replace('单价', '')}</th>
                    <td>{tokens.toLocaleString('en-US')}</td>
                    <td>{price ? `${price.currency} ${price.amount}` : '0'}</td>
                    <td>
                      {subtotal === null
                        ? '—'
                        : `${price!.currency} ${formatRequestMoney(subtotal)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="request-cost-total">
              {cost.source === 'reported' ? '上游报告总费用' : '合计'}：
              {cost.amounts.length
                ? cost.amounts
                    .map((p) => `${p.currency} ${formatRequestMoney(p.value)}`)
                    .join(' + ')
                : '—'}
            </p>
            <p className="muted">
              {cost.source === 'reported'
                ? '总费用由上游报告；分项费用按当前配置单价计算，可能与上游账单不同。'
                : cost.note.replaceAll('估算', '计算')}
            </p>
          </div>,
          document.body
        )}
    </span>
  )
}
