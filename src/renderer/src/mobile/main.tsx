import { hasQuotaWindow } from '../../../shared/quota-display'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Database,
  FlaskConical,
  Layers3,
  Moon,
  PieChart,
  RefreshCw,
  Server,
  ShieldCheck,
  Sun,
  Wifi,
  WifiOff,
  Zap
} from 'lucide-react'
import type { QuotaWindow } from '../../../shared/contracts'
import {
  accounts as demoAccounts,
  countdown,
  formatTokens,
  percent,
  providerName,
  DASHBOARD_PROVIDERS,
  type DashboardAccount,
  type Provider
} from './data'
import logo from '../assets/navo-logo.png'
import kimi from '../assets/kimi.svg'
import minimax from '../assets/models/minimax.svg'
import deepseek from '../assets/deepseek.svg'
import openai from '../assets/models/openai.svg'
import go from '../assets/models/opencode.svg'
import './mobile.css'
import type { DashboardSnapshot } from '../../../shared/dashboard'

type Page = 'quota' | 'usage' | 'status'
const tabs = [
  { id: 'quota', name: '额度', icon: PieChart },
  { id: 'usage', name: '用量', icon: BarChart3 },
  { id: 'status', name: '状态', icon: Activity }
] as const

const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false })

function Badge({ low = false, children }: { low?: boolean; children: React.ReactNode }) {
  return <span className={`badge ${low ? 'warning' : ''}`}>{children}</span>
}
function Identity({ account }: { account: DashboardAccount }) {
  return (
    <div className="identity">
      <span className={`provider-logo ${account.provider.toLowerCase()}`}>
        {account.provider === '自定义供应商' ? (
          <span>AI</span>
        ) : (
          <img
            src={
              { Kimi: kimi, DeepSeek: deepseek, Go: go, MiniMax: minimax, Codex: openai }[
                account.provider
              ]
            }
            alt=""
          />
        )}
      </span>
      <div>
        <h3>{account.name}</h3>
        <p>{providerName(account.provider)}</p>
      </div>
    </div>
  )
}
function Meter({
  value,
  label,
  now
}: {
  value: QuotaWindow | null | undefined
  label: string
  now: number
}) {
  if (!hasQuotaWindow(value)) return null
  const remaining = percent(value)
  return (
    <div className={`meter ${remaining !== null && remaining < 15 ? 'low' : ''}`}>
      <div className="meter-title">
        <span>{label}</span>
        <strong>
          {remaining ?? '—'}
          {remaining !== null && <small>%</small>}
        </strong>
      </div>
      <div
        className="track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining ?? undefined}
      >
        <span style={{ width: `${remaining ?? 0}%` }} />
      </div>
      <p>
        <Clock3 size={12} />
        {countdown(value, now)}
      </p>
    </div>
  )
}
function Chart({
  multiplier = 1,
  points
}: {
  multiplier?: number
  points?: DashboardSnapshot['points']
}) {
  const sampleValues = [
    20, 26, 22, 31, 27, 37, 34, 50, 60, 73, 64, 86, 92, 78, 82, 63, 57, 48, 54, 43, 35, 40, 29, 24
  ]
  const values = points
    ? points.map((p) => ((p.tokens ?? 0) / Math.max(1, ...points.map((v) => v.tokens ?? 0))) * 92)
    : sampleValues
  const [selected, setSelected] = useState<number | null>(null)
  const heights = values.map((value) => 125 - value)
  const slopes = heights.slice(1).map((y, i) => (y - heights[i]) / 20)
  // Monotone cubic interpolation rounds the joins without inventing new extrema.
  const tangents = heights.map((_, i) => {
    if (i === 0) return slopes[0]
    if (i === heights.length - 1) return slopes[i - 1]
    const left = slopes[i - 1],
      right = slopes[i]
    return left * right <= 0 ? 0 : (2 * left * right) / (left + right)
  })
  const curve = heights
    .slice(1)
    .reduce(
      (path, y, i) =>
        `${path} C ${i * 20 + 20 / 3},${heights[i] + (tangents[i] * 20) / 3} ${(i + 1) * 20 - 20 / 3},${y - (tangents[i + 1] * 20) / 3} ${(i + 1) * 20},${y}`,
      `M 0,${heights[0]}`
    )
  return (
    <div className="chart">
      <div className="chart-caption">
        <span>Token / 小时</span>
        <span>
          {selected === null
            ? '近 24 小时'
            : `${23 - selected} 小时前 · ${Math.round(points ? (points[selected]?.tokens ?? 0) : values[selected] * 820 * multiplier).toLocaleString()} Token`}
        </span>
      </div>
      <div className="chart-plot">
        <svg
          viewBox="0 0 460 150"
          preserveAspectRatio="none"
          role="img"
          aria-label={points ? '近 24 小时 Token 用量趋势' : '示例：近 24 小时 Token 用量趋势'}
        >
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2873ff" stopOpacity=".22" />
              <stop offset="100%" stopColor="#2873ff" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[25, 65, 105, 145].map((y) => (
            <line
              key={y}
              x1="0"
              y1={y}
              x2="460"
              y2={y}
              className="grid-line"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={`${curve} L 460,150 L 0,150 Z`} fill="url(#chart-fill)" />
          <path
            className="chart-curve"
            d={curve}
            fill="none"
            stroke="#2873ff"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        {selected !== null && (
          <span
            className="chart-point"
            aria-hidden="true"
            style={{
              left: `${(selected / (values.length - 1)) * 100}%`,
              top: `${(heights[selected] / 150) * 100}%`
            }}
          />
        )}
        <div className="chart-touch">
          {values.map((_, i) => (
            <button
              key={i}
              aria-label={`查看 ${23 - i} 小时前用量`}
              onMouseEnter={() => setSelected(i)}
              onFocus={() => setSelected(i)}
              onClick={() => setSelected(i)}
            />
          ))}
        </div>
      </div>
      <div className="chart-axis">
        <span>24 小时前</span>
        <span>18 小时前</span>
        <span>12 小时前</span>
        <span>6 小时前</span>
        <span>现在</span>
      </div>
    </div>
  )
}
function App({
  snapshot,
  reload,
  logout,
  connectionError = false
}: {
  snapshot?: DashboardSnapshot
  reload?: () => Promise<void>
  logout?: () => void
  connectionError?: boolean
}) {
  const accounts = snapshot?.accounts ?? demoAccounts
  const sum = (key: 'requests' | 'tokens' | 'active') => accounts.reduce((n, a) => n + a[key], 0)
  const label = (a: DashboardAccount) =>
    a.status && a.status !== 'available'
      ? { disabled: '已停用', error: '认证异常', stale: '数据过期', exhausted: '额度耗尽' }[
          a.status
        ]
      : (percent(a.quota?.fiveHour) ?? 100) < 15
        ? '额度偏低'
        : '可用'

  const [route, setRoute] = useState(location.hash.slice(1) || 'quota')
  const [filter, setFilter] = useState<Provider | '全部'>('全部')
  const [dark, setDark] = useState(() => localStorage.getItem('navo.mobile.theme') === 'dark')
  const [demoConnected, setConnected] = useState(true)
  const connected = snapshot ? !connectionError : demoConnected
  const [updated, setUpdated] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    const changed = () => {
      setRoute(location.hash.slice(1) || 'quota')
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('navo.mobile.theme', dark ? 'dark' : 'light')
  }, [dark])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (snapshot) setUpdated(snapshot.generatedAt)
  }, [snapshot])
  useEffect(() => {
    if (!connected || snapshot) return
    const timer = window.setInterval(() => setUpdated(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [connected, snapshot])
  useEffect(() => {
    if (!refreshing) return
    if (reload) {
      void reload().finally(() => setRefreshing(false))
      return
    }
    const timer = window.setTimeout(() => {
      if (connected) setUpdated(Date.now())
      setRefreshing(false)
    }, 550)
    return () => clearTimeout(timer)
  }, [refreshing, connected, reload])
  const account = route.startsWith('account/')
    ? accounts.find((a) => a.id === route.split('/')[1])
    : undefined
  const page: Page = route === 'usage' || route === 'status' ? route : 'quota'
  const stale = !connected || now - updated > 120000
  const visible = accounts.filter((a) => filter === '全部' || a.provider === filter)
  const refresh = (
    <button
      className={`icon-button ${refreshing ? 'refreshing' : ''}`}
      onClick={() => setRefreshing(true)}
      disabled={refreshing || (!snapshot && !connected)}
      aria-label={snapshot ? '刷新额度' : '刷新示例数据'}
    >
      <RefreshCw size={19} />
    </button>
  )
  const navigation = (
    <>
      {tabs.map(({ id, name, icon: Icon }) => (
        <a
          key={id}
          href={`#${id}`}
          className={page === id ? 'selected' : ''}
          aria-current={page === id ? 'page' : undefined}
        >
          <Icon size={21} />
          <span>{name}</span>
        </a>
      ))}
    </>
  )
  return (
    <div
      className={`dashboard ${!account ? 'dashboard-overview' : ''} ${page === 'quota' && !account ? 'quota-overview' : ''}`}
    >
      <header className="topbar">
        <div className="topbar-identity">
          <a href="#quota" className="brand">
            <img src={logo} alt="" />
            <span>Navo{account && <span className="brand-description">额度仪表盘</span>}</span>
          </a>
          {!account && (
            <h1 className="topbar-title">
              {{ quota: '额度概览', usage: '用量分析', status: '连接状态' }[page]}
            </h1>
          )}
        </div>
        <nav className="desktop-nav" aria-label="主导航">
          {navigation}
        </nav>
        <div className="top-actions">
          {!account && (
            <>
              <div
                className={`sync-status topbar-sync ${stale ? 'stale' : ''}`}
                role="status"
                title={`更新于 ${time(updated)} · 每 30 秒自动刷新`}
              >
                <span className="status-dot" />
                <span>
                  {stale ? '连接中断 · 数据可能已过期' : snapshot ? '实时连接' : '示例数据'}
                </span>
              </div>
              {refresh}
            </>
          )}
          <span className="preview-tag">
            <FlaskConical size={13} />
            {snapshot ? '只读访问' : '交互预览'}
          </span>
          <button
            className="icon-button theme-toggle"
            onClick={() => setDark(!dark)}
            aria-label={dark ? '切换浅色模式' : '切换深色模式'}
          >
            {dark ? <Sun size={19} /> : <Moon size={19} />}
          </button>
        </div>
      </header>
      <main>
        {account && (
          <div className="heading">
            <div>
              <div className="detail-heading">
                <a href="#quota" className="icon-button" aria-label="返回额度概览">
                  <ArrowLeft size={22} />
                </a>
                <h1>账号详情</h1>
              </div>
              <div className={`sync-status ${stale ? 'stale' : ''}`} role="status">
                <span className="status-dot" />
                <span>
                  {stale ? '连接中断 · 数据可能已过期' : snapshot ? '实时连接' : '示例数据'}
                </span>
                <span className="sync-time">更新于 {time(updated)}</span>
              </div>
            </div>
            <div className="heading-actions">
              <span className="auto-refresh">每 30 秒刷新</span>
              {refresh}
            </div>
          </div>
        )}
        {account ? (
          <>
            <div className="detail-identity">
              <Identity account={account} />
              <Badge low={label(account) !== '可用'}>{label(account)}</Badge>
            </div>
            <div className="detail-grid">
              {(hasQuotaWindow(account.quota?.fiveHour) || !!account.balance?.balances.length) && (
                <section className="panel quota-hero">
                  <div className="section-title">
                    <h2>{!account.balance?.balances.length ? '5 小时额度' : '账户余额'}</h2>
                    <span className="subtle">
                      {!account.balance?.balances.length ? '当前窗口' : '按量付费'}
                    </span>
                  </div>
                  {!account.balance?.balances.length ? (
                    <>
                      <div
                        className={`quota-ring ${(percent(account.quota?.fiveHour) ?? 100) < 15 ? 'low' : ''}`}
                        style={
                          {
                            '--remaining': `${(percent(account.quota?.fiveHour) ?? 0) * 3.6}deg`
                          } as React.CSSProperties
                        }
                      >
                        <div>
                          <strong>
                            {percent(account.quota?.fiveHour) ?? '—'}
                            <small>%</small>
                          </strong>
                          <span>剩余额度</span>
                        </div>
                      </div>
                      <div className="reset-row">
                        <span>下次重置</span>
                        <div>
                          <strong>
                            {account.quota?.fiveHour?.resetAt
                              ? new Date(account.quota?.fiveHour.resetAt).toLocaleString('zh-CN', {
                                  month: 'numeric',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })
                              : '未知'}
                          </strong>
                          <p>{countdown(account.quota?.fiveHour, now)}</p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="balance-hero">
                      <span>可用余额</span>
                      {account.balance?.balances.length ? (
                        account.balance.balances.map((balance) => (
                          <strong key={balance.currency}>
                            {balance.currency} {balance.balance.toFixed(2)}
                          </strong>
                        ))
                      ) : (
                        <strong>—</strong>
                      )}
                      <p>各币种独立展示，不进行汇率换算</p>
                    </div>
                  )}
                </section>
              )}
              <div className="detail-secondary">
                {(hasQuotaWindow(account.quota?.weekly) ||
                  hasQuotaWindow(account.quota?.monthly)) && (
                  <section className="panel window-panel">
                    <Meter value={account.quota?.weekly} label="本周剩余额度" now={now} />
                    {account.quota?.monthly && (
                      <Meter value={account.quota.monthly} label="本月剩余额度" now={now} />
                    )}
                  </section>
                )}
                <div className="mini-stats">
                  <div className="panel">
                    <span>今日请求</span>
                    <strong>{account.requests}</strong>
                  </div>
                  <div className="panel">
                    <span>今日 Token</span>
                    <strong>{formatTokens(account.tokens)}</strong>
                  </div>
                </div>
                <section className="panel">
                  <div className="section-title">
                    <h2>用量趋势</h2>
                    <BarChart3 size={17} />
                  </div>
                  <Chart
                    points={snapshot?.points}
                    multiplier={account.tokens / Math.max(1, sum('tokens'))}
                  />
                </section>
              </div>
            </div>
          </>
        ) : page === 'quota' ? (
          <>
            <section className="summary" aria-label="账户汇总">
              <div>
                <span>
                  <Layers3 size={16} />
                  可用账号
                </span>
                <strong>
                  {accounts.filter((a) => !a.status || a.status === 'available').length}{' '}
                  <small>/ {accounts.length}</small>
                </strong>
              </div>
              <div>
                <span>
                  <Zap size={16} />
                  进行中请求
                </span>
                <strong>
                  {snapshot?.totals.active ?? sum('active')}
                  <span className="live-bars">
                    <i />
                    <i />
                    <i />
                  </span>
                </strong>
              </div>
              <div>
                <span>
                  <BarChart3 size={16} />
                  今日 Token
                </span>
                <strong>{formatTokens(snapshot?.totals.tokens ?? sum('tokens'))}</strong>
              </div>
              <div>
                <span>
                  <Activity size={16} />
                  今日请求
                </span>
                <strong>
                  {snapshot?.totals.requests ?? sum('requests')}
                  <small> 次</small>
                </strong>
              </div>
            </section>
            <div className="list-toolbar">
              <div className="filters" aria-label="按供应商筛选">
                {(['全部', ...DASHBOARD_PROVIDERS] as const).map((value) => (
                  <button
                    key={value}
                    className={filter === value ? 'active' : ''}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value}
                    {value === '全部' && <span>{accounts.length}</span>}
                  </button>
                ))}
              </div>
              <span className="account-count">{visible.length} 个账号</span>
            </div>
            <div className="account-grid">
              {!visible.length && (
                <section className="panel">暂无账号，请在桌面 App 中添加账号。</section>
              )}
              {visible.map((a) => (
                <a
                  href={`#account/${a.id}`}
                  className="account-card panel"
                  key={a.id}
                  aria-label={`查看${a.name}详情`}
                >
                  <div className="card-heading">
                    <Identity account={a} />
                    <div className="card-badges">
                      {a.active > 0 && (
                        <span className="active-requests" aria-label={`${a.active} 个请求进行中`}>
                          <Zap size={12} />
                          {a.active}
                        </span>
                      )}
                      <Badge low={label(a) !== '可用'}>{label(a)}</Badge>
                      <ChevronRight size={17} />
                    </div>
                  </div>
                  {!a.balance?.balances.length ? (
                    <div className="quota-columns">
                      <Meter label="5 小时剩余" value={a.quota?.fiveHour} now={now} />
                      <Meter label="本周剩余" value={a.quota?.weekly} now={now} />
                      {a.quota?.monthly && (
                        <div className="monthly">
                          <span>本月剩余</span>
                          <strong>{percent(a.quota?.monthly)}%</strong>
                          <span>{countdown(a.quota?.monthly, now)}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="balance">
                      <span>账户余额</span>
                      {!a.balance?.balances.length && <strong>—</strong>}
                      {a.balance?.balances.map((b) => (
                        <strong key={b.currency}>
                          <small>{b.currency}</small> {b.balance.toFixed(2)}
                        </strong>
                      ))}
                      <p>按实际用量计费</p>
                    </div>
                  )}
                </a>
              ))}
            </div>
            <section className="panel overview-trend">
              <div className="section-title">
                <div>
                  <h2>用量趋势</h2>
                  <p>所有账号 · 近 24 小时</p>
                </div>
                <a href="#usage">
                  查看分析
                  <ArrowUpRight size={15} />
                </a>
              </div>
              <Chart points={snapshot?.points} />
            </section>
          </>
        ) : page === 'usage' ? (
          <>
            <section className="usage-stats">
              <div className="panel">
                <span>今日 Token</span>
                <strong>{formatTokens(snapshot?.totals.tokens ?? sum('tokens'))}</strong>
                <small>
                  <ArrowUpRight size={14} />
                  所有账号合计
                </small>
              </div>
              <div className="panel">
                <span>今日请求</span>
                <strong>{snapshot?.totals.requests ?? sum('requests')}</strong>
                <small>
                  <ArrowDownLeft size={14} />
                  包含已完成和进行中请求
                </small>
              </div>
            </section>
            <div className="usage-grid">
              <section className="panel">
                <div className="section-title">
                  <h2>用量趋势</h2>
                  <Badge>近 24 小时</Badge>
                </div>
                <Chart points={snapshot?.points} />
              </section>
              <section className="panel">
                <div className="section-title">
                  <h2>账号用量分布</h2>
                  <span className="subtle">今日 Token</span>
                </div>
                <div className="distribution">
                  {[...accounts]
                    .sort((a, b) => b.tokens - a.tokens)
                    .map((a) => (
                      <a key={a.id} href={`#account/${a.id}`}>
                        <div>
                          <Identity account={a} />
                          <strong>{formatTokens(a.tokens)}</strong>
                        </div>
                        <div className="track">
                          <span
                            style={{ width: `${(a.tokens / Math.max(1, sum('tokens'))) * 100}%` }}
                          />
                        </div>
                      </a>
                    ))}
                </div>
              </section>
            </div>
          </>
        ) : (
          <div className="status-grid">
            <section className="panel connection-panel">
              <div className={`connection-icon ${stale ? 'offline' : ''}`}>
                {connected ? <Wifi size={30} /> : <WifiOff size={30} />}
              </div>
              <h2>{connected ? (snapshot ? '实时连接正常' : '连接演示正常') : '连接已中断'}</h2>
              <p>
                {connected
                  ? snapshot
                    ? '额度由桌面 App 定期同步，页面自动获取最新数据。'
                    : '当前使用示例数据，可模拟断线查看页面状态。'
                  : '保留最后一次数据，恢复连接后继续刷新。'}
              </p>
              <div className="connection-path">
                <span>
                  <Server />
                  本地应用
                </span>
                <ChevronRight size={16} />
                <span>
                  <Cloud />
                  远程访问
                </span>
                <ChevronRight size={16} />
                <span>
                  <PieChart />
                  仪表盘
                </span>
              </div>
              <button
                className="secondary-button"
                onClick={() => {
                  if (snapshot) {
                    logout?.()
                    return
                  }
                  setConnected(!connected)
                  if (!connected) setUpdated(Date.now())
                }}
              >
                {snapshot ? '退出登录' : connected ? '模拟连接中断' : '恢复演示连接'}
              </button>
            </section>
            <section className="panel status-details">
              <h2>同步信息</h2>
              <dl>
                <div>
                  <dt>
                    <Database size={16} />
                    数据来源
                  </dt>
                  <dd>{snapshot ? '桌面 App 实时数据' : '本地示例数据'}</dd>
                </div>
                <div>
                  <dt>
                    <Clock3 size={16} />
                    刷新间隔
                  </dt>
                  <dd>30 秒</dd>
                </div>
                <div>
                  <dt>
                    <RefreshCw size={16} />
                    最后刷新
                  </dt>
                  <dd>{time(updated)}</dd>
                </div>
                <div>
                  <dt>
                    <Cloud size={16} />
                    Cloudflare Tunnel
                  </dt>
                  <dd>
                    {snapshot
                      ? {
                          off: '关闭',
                          connecting: '连接中',
                          connected: '已连接',
                          error: '连接异常'
                        }[snapshot.tunnel]
                      : '尚未接入'}
                  </dd>
                </div>
                <div>
                  <dt>
                    <ShieldCheck size={16} />
                    访问方式
                  </dt>
                  <dd>{snapshot ? 'HTTPS · 只读访问' : '只读预览'}</dd>
                </div>
              </dl>
              <div className="status-note">
                <Check size={17} />
                <span>此页面不包含账号密钥或管理操作。</span>
              </div>
            </section>
          </div>
        )}
        <footer className="page-footer">
          <FlaskConical size={13} />
          {snapshot ? '实时数据 · 只读访问' : '示例数据 · 仅用于体验预览'}
          <span>最后更新 {time(updated)}</span>
        </footer>
      </main>
      <nav className="bottom-nav" aria-label="移动端导航">
        {navigation}
      </nav>
    </div>
  )
}

function LiveApp() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>()
  const [needLogin, setNeedLogin] = useState(false)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const active = useRef<AbortController | null>(null)
  const reload = useCallback(async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const account = location.hash.startsWith('#account/') ? location.hash.slice(9) : ''
      const response = await fetch(
        `/api/snapshot${account ? `?account=${encodeURIComponent(account)}` : ''}`,
        { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }
      )
      if (response.status === 401) {
        setNeedLogin(true)
        setSnapshot(undefined)
        return
      }
      if (!response.ok) throw new Error()
      const data = (await response.json()) as DashboardSnapshot
      if (active.current !== controller) return
      setSnapshot(data)
      setNeedLogin(false)
      setFailed(false)
      setMessage('')
    } catch {
      if (active.current === controller) {
        setFailed(true)
        setMessage('连接暂时不可用，请检查桌面 App 是否正在运行。')
      }
    } finally {
      clearTimeout(timeout)
    }
  }, [])
  useEffect(() => {
    void reload()
    const interval = setInterval(() => {
      if (!document.hidden) void reload()
    }, 30000)
    const changed = () => {
      void reload()
    }
    window.addEventListener('hashchange', changed)
    document.addEventListener('visibilitychange', changed)
    return () => {
      active.current?.abort()
      clearInterval(interval)
      window.removeEventListener('hashchange', changed)
      document.removeEventListener('visibilitychange', changed)
    }
  }, [reload])
  async function login(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15000)
      })
      setCode('')
      if (!response.ok) {
        setMessage(
          response.status === 429 ? '尝试过多，请 15 分钟后重试。' : '访问码不正确或已过期。'
        )
        return
      }
      await reload()
    } catch {
      setMessage('无法连接，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }
  async function logout() {
    try {
      const response = await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15000)
      })
      if (!response.ok && response.status !== 401) throw new Error()
      setSnapshot(undefined)
      setNeedLogin(true)
    } catch {
      setFailed(true)
    }
  }
  if (snapshot && !needLogin)
    return (
      <App
        snapshot={snapshot}
        reload={reload}
        logout={() => void logout()}
        connectionError={failed}
      />
    )
  return (
    <main className="login-page">
      <form className="panel login-panel" onSubmit={login}>
        <img src={logo} alt="Navo" />
        <h1>{needLogin ? '登录额度仪表盘' : '正在连接'}</h1>
        <p>只读访问 · 安全查看账号额度</p>
        {needLogin && (
          <>
            <label htmlFor="access-code">访问码</label>
            <input
              id="access-code"
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="从桌面 App 复制访问码"
            />
            <button className="secondary-button" disabled={busy}>
              {busy ? '正在验证…' : '登录'}
            </button>
            <p>在桌面 App「远程仪表盘」中复制访问码。登录有效期为 8 小时。</p>
          </>
        )}
        {message && <p role="alert">{message}</p>}
        {!needLogin && failed && (
          <button type="button" className="secondary-button" onClick={() => void reload()}>
            重新连接
          </button>
        )}
      </form>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(import.meta.env.DEV ? <App /> : <LiveApp />)
