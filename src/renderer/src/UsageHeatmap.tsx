import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { formatUsageCost, heatmapLevel, localDayKey, type UsageStats } from '../../shared/usage'

import { RollingNumber } from './RollingNumber'

const tokens = (value: number | null) => (value == null ? '未知' : value.toLocaleString('zh-CN'))
const compactTokens = (value: number) =>
  new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const tooltipDate = (time: number) =>
  new Date(time).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

export function UsageHeatmap({
  data,
  loading = true
}: {
  data: UsageStats | undefined
  loading?: boolean
}) {
  const [mode, setMode] = useState<'daily' | 'weekly' | 'cumulative'>('daily')
  const scroll = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const tooltipId = useId()
  const [hover, setHover] = useState<{ key: string; text: string; x: number; y: number }>()
  const showTooltip = (element: HTMLElement, key: string, text: string, column = false) => {
    const bounds = element.getBoundingClientRect()
    const container = panel.current!.getBoundingClientRect()
    const top = column ? scroll.current!.getBoundingClientRect().top + 6 : bounds.top
    setHover({
      key,
      text,
      x: bounds.left + bounds.width / 2 - container.left,
      y: top - container.top
    })
  }
  useLayoutEffect(() => {
    if (!hover || !tooltip.current || !panel.current) return
    const width = tooltip.current.offsetWidth
    tooltip.current.style.left = `${Math.max(8, Math.min(hover.x - width / 2, panel.current.clientWidth - width - 8))}px`
    tooltip.current.style.top = `${hover.y - tooltip.current.offsetHeight - 8}px`
  }, [hover])
  useEffect(() => {
    const hide = () => setHover(undefined)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])
  const [selected, setSelected] = useState<number>()
  const [detail, setDetail] = useState<UsageStats>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (selected === undefined) return
    let active = true
    setError('')
    const end = new Date(selected)
    end.setDate(end.getDate() + 1)
    void window.navo
      .getUsageStats({ start: selected, end: end.getTime(), bucketMs: 3600000 })
      .then((result) => {
        if (active) setDetail(result)
      })
      .catch(() => {
        if (active) setError('当日明细读取失败，请重新选择日期')
      })
    return () => {
      active = false
    }
  }, [selected, data])
  const days = data?.points ?? []
  useEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth
  }, [days.length])
  const offset = days.length ? (new Date(days[0].time).getDay() + 6) % 7 : 0
  const maximum = days.reduce((max, day) => Math.max(max, day.totalTokens ?? 0), 1)
  const weeks: { time: number; end: number; tokens: number; unknown: boolean }[] = []
  days.forEach((day, index) => {
    const column = Math.floor((index + offset) / 7)
    const week = (weeks[column] ??= { time: day.time, end: day.time, tokens: 0, unknown: false })
    week.end = day.time
    week.tokens += day.totalTokens ?? 0
    week.unknown ||= day.requests > day.reported
  })
  let cumulative = 0
  let incomplete = false
  const bars = weeks.map((week) => {
    cumulative += week.tokens
    incomplete ||= week.unknown
    return {
      ...week,
      tokens: mode === 'cumulative' ? cumulative : week.tokens,
      unknown: mode === 'cumulative' ? incomplete : week.unknown
    }
  })
  const barMax = bars.reduce((max, bar) => Math.max(max, bar.tokens), 1)
  const today = localDayKey(Date.now())
  const months = new Map<number, string>()
  days.forEach((day, index) => {
    const date = new Date(day.time)
    if (index === 0 || date.getDate() === 1)
      months.set(
        Math.floor((index + offset) / 7) + 1,
        index === 0 || date.getMonth() === 0
          ? `${date.getFullYear()}/${date.getMonth() + 1}`
          : `${date.getMonth() + 1}月`
      )
  })
  return (
    <section
      className="usage-heatmap"
      aria-label="每日消耗热力图"
      ref={panel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setHover(undefined)
      }}
    >
      <div className="activity-summary" aria-label="历史活动统计">
        {[
          {
            label: '累计 Token 数',
            value: data?.activity ? compactTokens(data.activity.totalTokens) : '—',
            hint: '全部历史模型请求的输入、输出及缓存 token 总和，未报告用量按 0 计'
          },
          {
            label: '峰值 Token 数',
            value: data?.activity ? compactTokens(data.activity.peakTokens) : '—',
            hint: '本地自然日内最高的 token 总量'
          },
          {
            label: '最长聊天时长',
            value: data?.activity ? formatChatDuration(data.activity.longestChatMs) : '—',
            hint: '按同一会话 ID 的首次请求开始至最后一次请求结束计算，不受粘性窗口、账号或模型切换影响；旧记录或未提供会话 ID 的请求不参与此项统计'
          },
          {
            label: '当前连续天数',
            value: data?.activity ? `${data.activity.currentStreak} 天` : '—',
            hint: '连续有模型请求的本地日期；今天尚未使用时从昨天起算'
          },
          {
            label: '最长连续天数',
            value: data?.activity ? `${data.activity.longestStreak} 天` : '—',
            hint: '全部历史中连续有模型请求的最长天数'
          }
        ].map((item) => (
          <div key={item.label} title={item.hint}>
            <strong>
              <RollingNumber value={item.value} />
            </strong>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      <div className="usage-trend-heading">
        <h3>Token 活动</h3>
        <div className="heatmap-modes" role="group" aria-label="Token 活动统计方式">
          {(['daily', 'weekly', 'cumulative'] as const).map((value, index) => (
            <button
              key={value}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value)
                setHover(undefined)
              }}
            >
              {['每日', '每周', '累计'][index]}
            </button>
          ))}
        </div>
      </div>
      <div className="heatmap-scroll" ref={scroll}>
        <div
          className="heatmap-grid"
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, weeks.length)}, minmax(10px, 1fr))`
          }}
        >
          {[...months].map(([column, label]) => (
            <span className="heatmap-month" key={column} style={{ gridColumn: column, gridRow: 8 }}>
              {label}
            </span>
          ))}
          {mode === 'daily'
            ? days.map((day, index) => {
                const key = localDayKey(day.time)
                const col = Math.floor((index + offset) / 7) + 1,
                  row = ((index + offset) % 7) + 1
                const unknown = day.requests > 0 && day.totalTokens === null
                const bubble = `${tooltipDate(day.time)} ${unknown ? '用量未知' : `使用了 ${compactTokens(day.totalTokens ?? 0)} 个 Token`}${day.reported < day.requests && !unknown ? '（部分用量未知）' : ''}`
                const title = `${key}\n${day.requests} 次请求 · ${tokens(day.totalTokens ?? (day.requests === 0 ? 0 : null))} tokens\n已报告用量 ${day.reported}/${day.requests} · 成本 ${formatUsageCost(day)}\n中断 ${day.interruptedRequests} 次`
                return (
                  <div className="heatmap-day-wrapper" key={key}>
                    <button
                      className={`heatmap-day heatmap-level-${heatmapLevel(day.totalTokens, maximum)} ${unknown ? 'is-unknown' : ''} ${key === today ? 'is-today' : ''} ${hover?.key === key ? 'is-hovered' : ''}`}
                      style={{ gridColumn: col, gridRow: row }}
                      onMouseEnter={(event) => showTooltip(event.currentTarget, key, bubble)}
                      onMouseLeave={() => setHover(undefined)}
                      onFocus={(event) => showTooltip(event.currentTarget, key, bubble)}
                      onBlur={() => setHover(undefined)}
                      aria-describedby={hover?.key === key ? tooltipId : undefined}
                      aria-label={title.replace(/\n/g, '，')}
                      aria-pressed={selected === day.time}
                      onClick={() => {
                        setDetail(undefined)
                        setSelected((value) => (value === day.time ? undefined : day.time))
                      }}
                    />
                  </div>
                )
              })
            : bars.flatMap((bar, column) => {
                const height =
                  bar.tokens > 0 ? Math.max(1, Math.ceil((bar.tokens / barMax) * 7)) : 0
                const title = `${mode === 'cumulative' ? `截至 ${tooltipDate(bar.end)} 累计` : `${tooltipDate(bar.end)} 当周：`} ${compactTokens(bar.tokens)} 个 Token${bar.unknown ? '（部分用量未知）' : ''}`
                return Array.from({ length: 7 }, (_, row) => (
                  <span
                    key={`${column}-${row}`}
                    role="img"
                    tabIndex={row === 6 ? 0 : undefined}
                    aria-label={title}
                    aria-describedby={hover?.key === `week-${column}` ? tooltipId : undefined}
                    onMouseEnter={(event) =>
                      showTooltip(event.currentTarget, `week-${column}`, title, true)
                    }
                    onMouseLeave={() => setHover(undefined)}
                    onFocus={(event) =>
                      showTooltip(event.currentTarget, `week-${column}`, title, true)
                    }
                    onBlur={() => setHover(undefined)}
                    className={`heatmap-day heatmap-level-${row >= 7 - height ? 3 : 0} ${bar.unknown && height === 0 && row === 6 ? 'is-unknown' : ''} ${hover?.key === `week-${column}` ? 'is-hovered' : ''}`}
                    style={{ gridColumn: column + 1, gridRow: row + 1 }}
                  />
                ))
              })}
        </div>
      </div>
      {hover && (
        <div ref={tooltip} id={tooltipId} role="tooltip" className="heatmap-tooltip">
          {hover.text}
        </div>
      )}
      {!data && (
        <p className="muted">{loading ? '正在加载消耗记录…' : '消耗记录暂不可用，请重试'}</p>
      )}
      {selected !== undefined && mode === 'daily' && (
        <div className="heatmap-detail">
          {
            <>
              <div className="usage-trend-heading">
                <strong>{localDayKey(selected)} 明细</strong>
                <button className="text-button" onClick={() => setSelected(undefined)}>
                  收起
                </button>
              </div>
              {error ? (
                <p role="alert" className="form-error">
                  {error}
                </p>
              ) : !detail ? (
                <p className="muted">正在加载…</p>
              ) : (
                <>
                  <p className="heatmap-day-summary">
                    {detail.summary.requests} 次请求 ·{' '}
                    {tokens(
                      detail.summary.totalTokens ?? (detail.summary.requests === 0 ? 0 : null)
                    )}{' '}
                    tokens · 成本 {formatUsageCost(detail.summary)} · 中断{' '}
                    {detail.summary.interruptedRequests} 次
                  </p>
                  {detail.byModel.length > 0 && (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>模型</th>
                            <th>请求数</th>
                            <th>Tokens</th>
                            <th>平均生成速度</th>
                            <th>中断请求</th>
                            <th>成本</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.byModel.map((model) => (
                            <tr key={model.model}>
                              <td>{model.model}</td>
                              <td>{model.requests}</td>
                              <td>{tokens(model.totalTokens)}</td>
                              <td>
                                {model.averageTokensPerSecond == null
                                  ? '—'
                                  : `${model.averageTokensPerSecond.toFixed(1)} tokens/s`}
                              </td>
                              <td>{model.interruptedRequests}</td>
                              <td>{formatUsageCost(model)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          }
        </div>
      )}
    </section>
  )
}

function formatChatDuration(ms: number | null): string {
  if (ms === null) return '暂无会话数据'
  if (ms <= 0) return '0 分钟'
  if (ms < 60000) return '不足 1 分钟'
  const minutes = Math.floor(ms / 60000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`
}
