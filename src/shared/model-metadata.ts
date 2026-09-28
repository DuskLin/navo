import type { CatalogPrice, ModelPrice, Provider } from './contracts'
import { catalogProviders, createCatalogMatcher } from './catalog-match'

/** Resolve metadata once per catalog/config revision, using the actual upstream ID. */
export function createModelMetadataResolver(entries: CatalogPrice[], prices: ModelPrice[]) {
  const match = createCatalogMatcher(entries)
  const providerMatchers = new Map<Provider, ReturnType<typeof createCatalogMatcher>>()
  const catalog = new Map(
    entries.map((entry) => [JSON.stringify([entry.provider, entry.model]), entry])
  )
  const associations = new Map(
    prices.map((price) => [JSON.stringify([price.provider, price.model]), price])
  )
  return (
    model: string,
    provider: Provider = 'kimi',
    diagnose = false
  ):
    | (Pick<CatalogPrice, 'name' | 'limit' | 'capabilities'> & {
        resolution?: {
          catalogMatch: { provider: string; model: string } | null
          catalogLimits: CatalogPrice['limit'] | null
          manualLimits: ModelPrice['limits'] | null
          configuredMatch: ModelPrice['catalogMatch'] | null
        }
      })
    | undefined => {
    const manual = associations.get(JSON.stringify([provider, model]))
    const mapping = manual?.catalogMatch
    let providerMatch = providerMatchers.get(provider)
    if (!providerMatch) {
      providerMatch = createCatalogMatcher(
        entries.filter((entry) => entry.provider === catalogProviders[provider])
      )
      providerMatchers.set(provider, providerMatch)
    }
    // A provider's own metadata takes precedence over another provider's price entry.
    const entry = mapping
      ? catalog.get(JSON.stringify([mapping.provider, mapping.model]))
      : (providerMatch(model, provider) ?? match(model, provider))
    const resolved = manual?.limits
      ? { ...entry, name: entry?.name ?? model, limit: { ...entry?.limit, ...manual.limits } }
      : entry
    if (!diagnose) return resolved
    return {
      ...resolved,
      name: resolved?.name ?? model,
      resolution: {
        catalogMatch: entry ? { provider: entry.provider, model: entry.model } : null,
        catalogLimits: entry?.limit ?? null,
        manualLimits: manual?.limits ?? null,
        configuredMatch: mapping ?? null
      }
    }
  }
}
