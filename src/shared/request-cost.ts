import type { GatewaySnapshot, ModelPrice, RequestRecord } from './contracts'
import {
  createModelPriceMatcher,
  matchedModelPrice,
  PRICE_FIELDS,
  resolveModelPrice
} from './model-pricing'

export interface RequestCost {
  amounts: { currency: 'CNY' | 'USD'; value: number }[]
  source: 'reported' | 'estimated' | 'unknown'
  note: string
}
export type RequestPricing = Pick<GatewaySnapshot, 'modelPrices' | 'modelPriceCatalog'> & {
  accounts: Pick<GatewaySnapshot['accounts'][number], 'id' | 'provider'>[]
}
type PriceLookup = {
  account: (id: string | undefined) => RequestPricing['accounts'][number] | undefined
  manual: (provider: ModelPrice['provider'], model: string) => ModelPrice | undefined
  match: ReturnType<typeof createModelPriceMatcher>
}

/** 每份价格配置只建一次索引，避免历史请求数与目录大小相乘。 */
export function createRequestCostCalculator(snapshot: RequestPricing) {
  const accounts = new Map(snapshot.accounts.map((a) => [a.id, a]))
  const prices = new Map(
    snapshot.modelPrices.map((p) => [JSON.stringify([p.provider, p.model]), p])
  )
  const lookup: PriceLookup = {
    account: (id) => (id === undefined ? undefined : accounts.get(id)),
    manual: (provider, model) => prices.get(JSON.stringify([provider, model])),
    match: createModelPriceMatcher(snapshot.modelPriceCatalog)
  }
  return Object.assign((record: RequestRecord) => requestCost(record, snapshot, lookup), {
    details: (record: RequestRecord) => requestCostDetails(record, snapshot, lookup)
  })
}

export function requestCost(
  record: RequestRecord,
  snapshot: RequestPricing,
  lookup?: PriceLookup
): RequestCost {
  const unknown = (note: string): RequestCost => ({ amounts: [], source: 'unknown', note })
  const usage = record.usage
  if (usage?.cost != null && Number.isFinite(usage.cost) && usage.cost >= 0)
    return {
      amounts: [{ currency: 'USD', value: usage.cost }],
      source: 'reported',
      note: '上游报告的美元费用'
    }
  const account = lookup
    ? lookup.account(record.accountId)
    : snapshot.accounts.find((a) => a.id === record.accountId)
  const provider = record.provider ?? (account ? (account.provider ?? 'kimi') : undefined)
  if (!provider) return unknown('无法确定历史请求的供应商')
  const model = record.upstreamModel ?? record.model
  const manual: ModelPrice = (lookup
    ? lookup.manual(provider, model)
    : snapshot.modelPrices.find((p) => p.provider === provider && p.model === model)) ?? {
    provider,
    model,
    currency: 'USD',
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null
  }
  const fallback = lookup
    ? lookup.match(manual)
    : matchedModelPrice(manual, snapshot.modelPriceCatalog)
  const amounts = new Map<'USD' | 'CNY', number>()
  for (const field of PRICE_FIELDS) {
    const tokens = usage?.[field] ?? 0
    if (!Number.isFinite(tokens) || tokens < 0) return unknown('token 用量无效')
    if (tokens === 0) continue
    const price = resolveModelPrice(manual, fallback, field)
    amounts.set(
      price.currency,
      (amounts.get(price.currency) ?? 0) + (tokens * price.amount) / 1_000_000
    )
  }
  if (!amounts.size) amounts.set(manual.currency, 0)
  return {
    amounts: [...amounts].map(([currency, value]) => ({ currency, value })),
    source: 'estimated',
    note: `按当前模型单价计算，未报告用量按 0 计；手动值优先，价格更新后费用随之变化${fallback?.tiered ? '；API 使用基础档价格' : ''}${record.interruption || record.status === 499 ? '；仅包含中断前已报告的用量' : ''}`
  }
}

export function requestCostDetails(
  record: RequestRecord,
  snapshot: RequestPricing,
  lookup?: PriceLookup
) {
  const account = lookup
    ? lookup.account(record.accountId)
    : snapshot.accounts.find((a) => a.id === record.accountId)
  const provider = record.provider ?? (account ? (account.provider ?? 'kimi') : undefined)
  const model = record.upstreamModel ?? record.model
  const manual =
    lookup && provider
      ? lookup.manual(provider, model)
      : snapshot.modelPrices.find((p) => p.provider === provider && p.model === model)
  const fallback = provider
    ? (lookup?.match ?? ((price) => matchedModelPrice(price, snapshot.modelPriceCatalog)))(
        manual ?? {
          provider,
          model,
          currency: 'USD',
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null
        }
      )
    : undefined
  return PRICE_FIELDS.map((field) => {
    const tokens = record.usage?.[field] ?? 0
    const price = resolveModelPrice(manual, fallback, field)
    return {
      field,
      tokens,
      price,
      subtotal: Number.isFinite(tokens) && tokens >= 0 ? (tokens * price.amount) / 1_000_000 : null
    }
  })
}
