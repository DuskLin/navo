import { startVisiblePolling } from './visible-polling'
import { useEffect, useId, useState } from 'react'
import { Activity, ArrowDown, ArrowUp, CircleSlash, DollarSign, Sparkles, Zap } from 'lucide-react'
import type { UsageStats, UsageTotals } from '../../shared/usage'
import { formatUsageCost, heatmapRange } from '../../shared/usage'
import { UsageHeatmap } from './UsageHeatmap'
import { RollingNumber } from './RollingNumber'

const compact = (n: number | null | undefined) =>
  n == null
    ? 'N/A'
    : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const exact = (n: number | null | undefined) => (n == null ? 'N/A' : n.toLocaleString('zh-CN'))
const money = (n: number | null | undefined) => (n == null ? 'N/A' : `$${n.toFixed(4)}`)
const series = [
  { key: 'cost', label: '成本（USD）', color: '#f66c8c' },
  { key: 'cacheRead', label: '缓存命中', color: '#a56bff' },
  { key: 'input', label: '新增输入', color: '#76b3ff' },
  { key: 'output', label: '输出', color: '#55b8c6' }
] as const

// 单调三次插值：穿过原始点，峰谷处收平，避免曲线过冲或出现负用量。
function smoothPath(points: { x: number; y: number }[]): string {
  if (!points.length) return ''
  const slopes = points.slice(1).map((p, i) => (p.y - points[i].y) / (p.x - points[i].x))
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0] ?? 0
    if (i === points.length - 1) return slopes[i - 1]
    const before = slopes[i - 1],
      after = slopes[i]
    return before * after <= 0 ? 0 : 2 / (1 / before + 1 / after)
  })
  return points.reduce((path, p, i) => {
    if (i === 0) return `M${p.x},${p.y}`
    const prev = points[i - 1]
    const dx = (p.x - prev.x) / 3
    return `${path} C${prev.x + dx},${prev.y + dx * tangents[i - 1]} ${p.x - dx},${p.y - dx * tangents[i]} ${p.x},${p.y}`
  }, '')
}

function Trend({ points, hourly }: { points: UsageStats['points']; hourly: boolean }) {
  const gradient = useId().replace(/:/g, '')
  const [hover, setHover] = useState<number | null>(null)
  const [hidden, setHidden] = useState<string[]>([])
  const width = 960,
    height = 210,
    left = 48,
    right = 68,
    top = 12,
    bottom = 34
  const maxToken = Math.max(
    1,
    ...points.flatMap((p) =>
      series.filter((s) => s.key !== 'cost' && !hidden.includes(s.key)).map((s) => p[s.key] ?? 0)
    )
  )
  const step = 10 ** Math.floor(Math.log10(maxToken))
  const ceiling = Math.ceil(maxToken / step) * step
  const maxCost = Math.max(0.0001, ...points.map((p) => p.cost ?? 0))
  const hasCost = points.some((p) => p.cost !== null)
  const x = (i: number) => left + (i / Math.max(1, points.length - 1)) * (width - left - right)
  const y = (value: number, cost: boolean) =>
    height - bottom - (value / (cost ? maxCost : ceiling)) * (height - top - bottom)
  const label = (time: number) =>
    new Date(time).toLocaleString(
      'zh-CN',
      hourly
        ? { hour: '2-digit', minute: '2-digit', hour12: false }
        : { month: '2-digit', day: '2-digit' }
    )
  const selected = hover == null ? undefined : points[hover]
  return (
    <>
      <div
        className="usage-chart"
        tabIndex={0}
        role="group"
        aria-label="用量趋势图，左右方向键查看时间点"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            setHover((i) =>
              Math.max(0, Math.min(points.length - 1, (i ?? 0) + (e.key === 'ArrowRight' ? 1 : -1)))
            )
          }
        }}
        onMouseMove={(e) => {
          const bounds = e.currentTarget.getBoundingClientRect()
          const at = ((e.clientX - bounds.left) / bounds.width) * width
          setHover(
            Math.max(
              0,
              Math.min(
                points.length - 1,
                Math.round(((at - left) / (width - left - right)) * (points.length - 1))
              )
            )
          )
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Tokens 与成本随时间变化">
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a56bff" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#a56bff" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => {
            const at = top + (i / 4) * (height - top - bottom)
            return (
              <g key={i}>
                <line x1={left} x2={width - right} y1={at} y2={at} className="usage-grid-line" />
                <text x={left - 8} y={at + 4} textAnchor="end">
                  {compact(ceiling * (1 - i / 4))}
                </text>
                <text x={width - right + 9} y={at + 4}>
                  {hasCost ? money(maxCost * (1 - i / 4)) : i === 0 ? '成本 N/A' : ''}
                </text>
              </g>
            )
          })}
          {series
            .filter((s) => !hidden.includes(s.key) && (s.key !== 'cost' || hasCost))
            .map((s) => {
              const runs: { x: number; y: number }[][] = []
              let run: { x: number; y: number }[] = []
              points.forEach((p, i) => {
                const value = p[s.key] ?? (p.requests === 0 ? 0 : null)
                if (value === null) {
                  if (run.length) runs.push(run)
                  run = []
                } else run.push({ x: x(i), y: y(value, s.key === 'cost') })
              })
              if (run.length) runs.push(run)
              return (
                <g key={s.key}>
                  {runs.map((r, i) => {
                    const path = smoothPath(r)
                    return (
                      <g key={i}>
                        {s.key === 'cacheRead' && (
                          <path
                            d={`${path} L${r.at(-1)!.x},${height - bottom} L${r[0].x},${height - bottom} Z`}
                            fill={`url(#${gradient})`}
                          />
                        )}
                        <path
                          d={path}
                          fill="none"
                          stroke={s.color}
                          strokeWidth="2"
                          strokeDasharray={s.key === 'cost' ? '4 4' : undefined}
                        />
                        {r.length === 1 && <circle cx={r[0].x} cy={r[0].y} r="2" fill={s.color} />}
                      </g>
                    )
                  })}
                </g>
              )
            })}
          {points.map((p, i) =>
            i % Math.max(1, Math.ceil(points.length / 7)) === 0 || i === points.length - 1 ? (
              <text key={p.time} x={x(i)} y={height - 9} textAnchor="middle">
                {label(p.time)}
              </text>
            ) : null
          )}
          {selected && (
            <line
              x1={x(hover!)}
              x2={x(hover!)}
              y1={top}
              y2={height - bottom}
              stroke="var(--muted)"
              strokeDasharray="3 3"
            />
          )}
        </svg>
        {selected && (
          <div className="usage-tooltip">
            <strong>
              {new Date(selected.time).toLocaleString()} · {selected.requests} 次请求
            </strong>
            {series.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                {s.label}
                <b>{s.key === 'cost' ? formatUsageCost(selected) : exact(selected[s.key])}</b>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="usage-legend">
        {series.map((s) => (
          <button
            key={s.key}
            aria-pressed={!hidden.includes(s.key)}
            onClick={() =>
              setHidden((keys) =>
                keys.includes(s.key) ? keys.filter((k) => k !== s.key) : [...keys, s.key]
              )
            }
          >
            <i style={{ background: s.color }} />
            {s.label}
          </button>
        ))}
      </div>
    </>
  )
}

export function UsageDashboard({
  interval,
  onAccountStats,
  showTokenActivity,
  showUsageTrend
}: {
  interval: number
  onAccountStats: (stats: UsageStats['byAccount']) => void
  showTokenActivity: boolean
  showUsageTrend: boolean
}) {
  const cacheTooltipId = useId()
  const [data, setData] = useState<UsageStats>()
  const [calendar, setCalendar] = useState<UsageStats>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const load = async () => {
      if (active) setLoading(true)
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      try {
        const [result, daily] = await Promise.all([
          window.navo.getUsageStats({
            start: start.getTime(),
            end: end.getTime(),
            bucketMs: 3600000
          }),
          showTokenActivity
            ? window.navo.getUsageStats({
                ...heatmapRange(),
                bucketMs: 86400000,
                allHistory: true
              })
            : undefined
        ])
        if (active) {
          setData(result)
          onAccountStats(result.byAccount)
          setCalendar(daily)
          setError('')
        }
      } catch (e) {
        if (active)
          setError(
            `使用统计读取失败：${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '未知错误'}。可点击重试。`
          )
      } finally {
        if (active) setLoading(false)
      }
    }
    const stopPolling = startVisiblePolling(load, interval)
    return () => {
      active = false
      stopPolling()
    }
  }, [interval, onAccountStats, retry, showTokenActivity])
  const s = data?.summary
  const metrics: {
    label: string
    key: keyof Pick<UsageTotals, 'input' | 'output' | 'cacheWrite' | 'cacheRead'>
    icon: typeof Activity
  }[] = [
    { label: '新增输入', key: 'input', icon: ArrowDown },
    { label: '输出', key: 'output', icon: ArrowUp }
  ]
  // 账号卡片仍依赖当天性能统计，隐藏面板时保持数据刷新。
  if (!showTokenActivity && !showUsageTrend) return null
  return (
    <section className="usage-dashboard" aria-label="使用统计">
      {error && (
        <p className="form-error" role="alert">
          {error}
          <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
      {showTokenActivity && <UsageHeatmap data={calendar} loading={loading} />}
      {showUsageTrend && (
        <>
          <div className="usage-hero">
            <div className="usage-total">
              <div>
                <small>
                  <Zap size={13} />
                  真实消耗 Tokens
                </small>
                <strong title={exact(s?.totalTokens ?? 0)}>
                  <RollingNumber value={!data && loading ? '…' : exact(s?.totalTokens ?? 0)} />
                </strong>
              </div>
            </div>
            <div className="usage-metrics">
              {metrics.map(({ label, key, icon: Icon }) => (
                <div key={key} title={exact(s?.[key] ?? 0)}>
                  <small>
                    <Icon size={13} />
                    {label}
                  </small>
                  <strong>
                    <RollingNumber value={compact(s?.[key] ?? 0)} />
                  </strong>
                </div>
              ))}
              <div className="cache-hit-metric">
                <small>
                  <Sparkles size={13} />
                  缓存命中
                </small>
                <div className="cache-hit-amount">
                  <div
                    className="cache-hit-ring"
                    tabIndex={0}
                    aria-describedby={cacheTooltipId}
                    role="progressbar"
                    aria-label="缓存命中率"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={s?.cacheHitRate == null ? undefined : s.cacheHitRate * 100}
                    aria-valuetext={
                      s?.cacheHitRate == null ? '未知' : `${(s.cacheHitRate * 100).toFixed(1)}%`
                    }
                  >
                    <svg viewBox="0 0 48 48" aria-hidden="true">
                      <circle
                        cx="24"
                        cy="24"
                        r="20"
                        fill="none"
                        stroke="var(--border)"
                        strokeWidth="4"
                      />
                      <circle
                        cx="24"
                        cy="24"
                        r="20"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="4"
                        pathLength="100"
                        strokeDasharray={`${Math.min(100, Math.max(0, (s?.cacheHitRate ?? 0) * 100))} 100`}
                        transform="rotate(-90 24 24)"
                      />
                    </svg>
                    <span id={cacheTooltipId} role="tooltip" className="cache-hit-tooltip">
                      {s?.cacheHitRate == null
                        ? '命中率未知'
                        : `命中率 ${(s.cacheHitRate * 100).toFixed(1)}%`}
                    </span>
                  </div>
                  <strong
                    title={
                      s?.cacheRead == null ? '缓存命中 -' : `缓存命中 ${exact(s.cacheRead)} tokens`
                    }
                  >
                    <RollingNumber value={s?.cacheRead == null ? '-' : compact(s.cacheRead)} />
                  </strong>
                </div>
              </div>
              <div>
                <small>
                  <Activity size={13} />
                  总请求数
                </small>
                <strong>
                  <RollingNumber value={s?.requests ?? '—'} />
                </strong>
              </div>
              <div title="上游报告费用优先，否则按当前模型单价计算；缺失价格与用量按 0 计，不同币种分别汇总">
                <small>
                  <DollarSign size={13} />
                  总成本
                </small>
                <strong className="usage-cost-value">
                  <RollingNumber value={s ? formatUsageCost(s) : '—'} />
                </strong>
              </div>
              <div
                tabIndex={0}
                title={`按网关检测到的中断事件统计：客户端 ${s?.interruptionCounts.client ?? 0} · 超时 ${s?.interruptionCounts.timeout ?? 0} · 上游 ${s?.interruptionCounts.upstream ?? 0} · 退出 ${s?.interruptionCounts.shutdown ?? 0}\n已报告用量 ${s?.interruptedReported ?? 0} / ${s?.interruptedRequests ?? 0} · ${exact(s?.interruptedTokens)} tokens · ${s ? formatUsageCost({ cost: s.interruptedCost, costAmounts: s.interruptedCostAmounts }) : '未知'}\n用量仅包含中断前已报告的部分`}
              >
                <small>
                  <CircleSlash size={13} />
                  中断请求
                </small>
                <strong>
                  <RollingNumber value={`${s?.interruptedRequests ?? 0} 次`} />
                </strong>
              </div>
            </div>
          </div>
          <div className="usage-trend">
            <div className="usage-trend-heading">
              <h3>使用趋势</h3>
              <small>当天</small>
            </div>
            {data ? (
              <Trend points={data.points.filter((point) => point.time <= Date.now())} hourly />
            ) : (
              <div className="usage-chart-placeholder">
                {loading ? '正在加载…' : '暂无统计数据'}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
