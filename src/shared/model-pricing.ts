import type { CatalogPrice, ModelPrice, ModelPriceCatalogSnapshot } from './contracts'
import { autoMatchCatalog, hasCatalogPrice } from './catalog-match'

export const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
export type PriceField = (typeof PRICE_FIELDS)[number]

/** Resolve each field separately; never mix currency labels or treat explicit zero as unset. */
export function resolveModelPrice(
  manual: ModelPrice | undefined,
  fallback: Pick<ModelPrice, PriceField | 'currency'> | undefined,
  field: PriceField
) {
  if (manual && manual[field] !== null)
    return { amount: manual[field], currency: manual.currency, source: 'manual' as const }
  if (fallback && fallback[field] !== null)
    return { amount: fallback[field], currency: fallback.currency, source: 'api' as const }
  return {
    amount: 0,
    currency: manual?.currency ?? fallback?.currency ?? 'USD',
    source: 'zero' as const
  }
}

export function matchedModelPrice(
  price: ModelPrice,
  catalog: ModelPriceCatalogSnapshot | undefined
) {
  if (price.catalogMatch)
    return catalog?.entries?.find(
      (p) => p.provider === price.catalogMatch!.provider && p.model === price.catalogMatch!.model
    )
  return (
    autoMatchCatalog(catalog?.entries ?? [], price.model, price.provider) ??
    catalog?.prices.find((p) => p.provider === price.provider && p.model === price.model)
  )
}

export function searchCatalogPrices(entries: CatalogPrice[], query: string): CatalogPrice[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const words = query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => normalize(word.split('/').at(-1) ?? word))
    .filter(Boolean)
  const exact = normalize(query.split('/').at(-1) ?? query)
  return entries
    .filter((p) =>
      words.every((word) =>
        normalize(`${p.model} ${p.name} ${p.providerName} ${p.provider}`).includes(word)
      )
    )
    .sort(
      (a, b) =>
        Number(normalize(b.model.split('/').at(-1) ?? b.model) === exact) -
          Number(normalize(a.model.split('/').at(-1) ?? a.model) === exact) ||
        Number(hasCatalogPrice(b)) - Number(hasCatalogPrice(a)) ||
        a.model.localeCompare(b.model) ||
        a.provider.localeCompare(b.provider)
    )
}
