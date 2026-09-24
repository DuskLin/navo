import { formatUsageCost, type UsageStats, type UsageTotals } from './usage'

export type ReceiptDays = 1 | 7 | 30
export type ReceiptMode = 'cost' | 'tokens'
export interface UsageReceipt {
  start: number
  end: number
  generatedAt: number
  days: ReceiptDays
  summary: UsageTotals
  details: NonNullable<UsageStats['receipt']>
}
export const RECEIPT_BACKGROUNDS = [
  { name: '霞光', from: '#d75285', to: '#65c4d5' },
  { name: '珊瑚', from: '#ed7278', to: '#f7be98' },
  { name: '海湾', from: '#20506d', to: '#78cbbd' },
  { name: '薄荷', from: '#50d6b6', to: '#b7edd2' },
  { name: '薰衣草', from: '#9692e6', to: '#e8b8d9' },
  { name: '午夜', from: '#526577', to: '#20263c' },
  { name: '暖阳', from: '#ffe27c', to: '#f5a348' },
  { name: '陶土', from: '#b88d88', to: '#82696d' },
  { name: '青柠', from: '#e2ed9b', to: '#a6dcc0' },
  { name: '晴空', from: '#627fee', to: '#65dbe3' },
  { name: '森林', from: '#184d48', to: '#92bda4' },
  { name: '素纸', from: '#e9e6df', to: '#d1d6d7' }
] as const

export function receiptRange(days: ReceiptDays, now = Date.now()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - days + 1)
  return { start: +start, end: now + 1, bucketMs: 86400000, receipt: true }
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!
  )
const number = (value: number | null) => (value === null ? '—' : value.toLocaleString('zh-CN'))
const compact = (value: number | null) =>
  value === null
    ? '—'
    : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(
        value
      )
const date = (time: number) =>
  new Date(time).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })

// Deterministic wrapping keeps long model names inside both the preview and PNG.
function wrap(value: string, width: number): string[] {
  const lines: string[] = []
  let line = '',
    used = 0
  for (const char of value) {
    const size = /[^\x00-\x7f]/.test(char) ? 2 : 1
    if (used + size > width) {
      lines.push(line)
      line = ''
      used = 0
    }
    line += char
    used += size
  }
  if (line) lines.push(line)
  return lines
}

/** A self-contained SVG is the single template used for paper, preview and export. */
export function renderUsageReceipt(receipt: UsageReceipt, mode: ReceiptMode, background?: number) {
  const width = 520,
    inset = 36,
    right = width - inset
  let y = 43
  const parts: string[] = []
  const text = (
    value: string,
    x: number,
    at: number,
    size = 14,
    weight = 400,
    anchor = 'start',
    fill = '#292723'
  ) =>
    parts.push(
      `<text x="${x}" y="${at}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${escape(value)}</text>`
    )
  const rule = () => {
    y += 20
    parts.push(`<path d="M${inset} ${y}H${right}" stroke="#b5afa2" stroke-dasharray="5 5"/>`)
    y += 25
  }
  const row = (label: string, value: string) => {
    text(label, inset, y)
    text(value, right, y, 14, 600, 'end')
    y += 25
  }
  text('N A V O  /  用 量 留 存', width / 2, y, 11, 600, 'middle', '#777166')
  y += 42
  text('AI 用量小票', width / 2, y, 29, 800, 'middle')
  y += 26
  text('每一次创造，都值得记录。', width / 2, y, 12, 400, 'middle', '#777166')
  rule()
  row(
    '统计范围',
    receipt.days === 1 ? date(receipt.start) : `${date(receipt.start)} — ${date(receipt.end - 1)}`
  )
  row('生成时间', new Date(receipt.generatedAt).toLocaleString('zh-CN', { hour12: false }))
  rule()
  text(mode === 'cost' ? '参 考 费 用' : '总 T O K E N', width / 2, y, 12, 600, 'middle')
  y += 45
  const headline =
    mode === 'cost'
      ? formatUsageCost(receipt.summary).split(' + ')
      : [compact(receipt.summary.totalTokens)]
  for (const line of headline) {
    text(line, width / 2, y, line.length > 16 ? 28 : 38, 800, 'middle')
    y += 43
  }
  y -= 15
  text(
    mode === 'cost' ? '上游报告优先 · 其余按当前价格估算' : '新增输入 + 缓存读取 / 写入 + 输出',
    width / 2,
    y,
    11,
    400,
    'middle',
    '#777166'
  )
  rule()
  text('客户端 / 模型', inset, y, 12, 400, 'start', '#777166')
  text(mode === 'cost' ? '参考费用' : 'Token', right, y, 12, 400, 'end', '#777166')
  y += 29
  const groups = new Map<string, typeof receipt.details.byHarnessModel>()
  for (const detail of receipt.details.byHarnessModel) {
    const items = groups.get(detail.harness) ?? []
    items.push(detail)
    groups.set(detail.harness, items)
  }
  if (!groups.size) {
    text('此期间暂无已报告用量', width / 2, y + 8, 14, 400, 'middle', '#777166')
    y += 38
  }
  for (const [harness, items] of groups) {
    text(harness, inset, y, 15, 700)
    const currencies = new Map<'USD' | 'CNY', number>()
    for (const item of items) {
      for (const amount of item.costAmounts ??
        (item.cost === null ? [] : [{ currency: 'USD' as const, value: item.cost }])) {
        currencies.set(amount.currency, (currencies.get(amount.currency) ?? 0) + amount.value)
      }
    }
    const subtotal =
      mode === 'cost'
        ? formatUsageCost({
            cost: null,
            costAmounts: [...currencies].map(([currency, value]) => ({ currency, value }))
          }).split(' + ')
        : [
            number(
              items.some((item) => item.totalTokens !== null)
                ? items.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0)
                : null
            )
          ]
    for (const line of subtotal) {
      text(line, right, y, 13, 700, 'end')
      y += 20
    }
    y += 6
    for (const item of items) {
      const lines = wrap(item.model, 30)
      const values =
        mode === 'cost' ? formatUsageCost(item).split(' + ') : [number(item.totalTokens)]
      for (let i = 0; i < Math.max(lines.length, values.length); i++) {
        if (lines[i]) text(lines[i], inset + 12, y, 12)
        if (values[i]) text(values[i], right, y, 12, 500, 'end')
        y += 20
      }
      y += 9
    }
    y += 5
  }
  rule()
  const s = receipt.summary
  row('总 Token', number(s.totalTokens))
  row('新增输入', number(s.input))
  row('缓存读取', number(s.cacheRead))
  row('缓存写入', number(s.cacheWrite))
  row('输出', number(s.output))
  row('缓存命中率', s.cacheHitRate === null ? '—' : `${(s.cacheHitRate * 100).toFixed(1)}%`)
  row('已报告用量请求', number(s.requests))
  row('已识别会话', number(receipt.details.sessionCount))
  if (receipt.details.unidentifiedSessionRequests) {
    text(
      `${receipt.details.unidentifiedSessionRequests} 次请求缺少会话标识，未计入会话数`,
      inset,
      y,
      11,
      400,
      'start',
      '#777166'
    )
    y += 21
  }
  rule()
  for (const note of [
    '仅含 Navo 网关已记录且已报告用量的请求。',
    '费用仅供参考，非实际账单；不同币种分别汇总。',
    '缺失价格 / 用量按 0 计，可能低估费用。'
  ]) {
    text(note, width / 2, y, 10, 400, 'middle', '#777166')
    y += 19
  }
  y += 15
  text('继续创造，留下凭证。', width / 2, y, 13, 600, 'middle')
  y += 25
  text('—  N A V O  —', width / 2, y, 11, 500, 'middle', '#777166')
  const height = y + 31
  const teeth = Array.from(
    { length: width / 10 },
    (_, i) => `${width - i * 10 - 5},${height} ${width - i * 10 - 10},${height - 5}`
  ).join(' ')
  const paper = `<path d="M0 0H${width}V${height - 5}L${teeth}V0Z" fill="#f8f5ed"/><rect width="${width}" height="${height - 5}" fill="url(#grain)"/>${parts.join('')}`
  const margin = background === undefined ? 0 : 64
  const fullWidth = width + margin * 2,
    fullHeight = height + margin * 2
  const bg = RECEIPT_BACKGROUNDS[background ?? 0] ?? RECEIPT_BACKGROUNDS[0]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fullWidth}" height="${fullHeight}" viewBox="0 0 ${fullWidth} ${fullHeight}"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${bg.from}"/><stop offset="1" stop-color="${bg.to}"/></linearGradient><pattern id="grain" width="7" height="9" patternUnits="userSpaceOnUse"><circle cx="1" cy="2" r="0.45" fill="#8b8066" opacity="0.10"/><circle cx="5" cy="7" r="0.35" fill="#8b8066" opacity="0.08"/></pattern><filter id="shadow" x="-30%" y="-10%" width="160%" height="130%"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#20252b" flood-opacity="0.22"/></filter></defs>${margin ? `<rect width="100%" height="100%" fill="url(#bg)"/>` : ''}<g font-family="'SFMono-Regular', 'Menlo', 'PingFang SC', 'Microsoft YaHei', monospace" transform="translate(${margin} ${margin})"${margin ? ' filter="url(#shadow)"' : ''}>${paper}</g></svg>`
  return {
    svg,
    width: fullWidth,
    height: fullHeight,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }
}
