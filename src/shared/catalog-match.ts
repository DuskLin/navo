import type { CatalogPrice, Provider } from './contracts'

export const catalogProviders: Record<Provider, string> = {
  custom: 'custom',
  codex: 'openai',
  kimi: 'kimi-for-coding',
  deepseek: 'deepseek',
  minimax: 'minimax-coding-plan',
  'commandcode-goat': 'commandcode',
  'opencode-go': 'opencode-go'
}

const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const basename = (value: string) => value.split('/').at(-1) ?? value
// Keep numeric components distinct: v4.1 must not become v41.
const numbers = (value: string) => (value.match(/\d+/g) ?? []).join('|')
const sameName = (a: string, b: string) =>
  Boolean(normalize(a)) && normalize(a) === normalize(b) && numbers(a) === numbers(b)

export const hasCatalogPrice = (entry: CatalogPrice): boolean =>
  [entry.input, entry.output, entry.cacheRead, entry.cacheWrite].some(
    (value) => value !== null && value !== undefined
  )

/** Conservative fuzzy identity matching: prefixes, case and separators, not model variants. */
export function autoMatchCatalog(
  entries: CatalogPrice[],
  model: string,
  provider: Provider
): CatalogPrice | undefined {
  const name = basename(model)
  const candidates = entries
    .map((entry) => ({
      entry,
      score: sameName(name, basename(entry.model)) ? 2 : sameName(name, entry.name) ? 1 : 0
    }))
    .filter(({ score }) => score > 0)
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Number(hasCatalogPrice(b.entry)) - Number(hasCatalogPrice(a.entry)) ||
      Number(b.entry.provider === catalogProviders[provider]) -
        Number(a.entry.provider === catalogProviders[provider]) ||
      a.entry.provider.localeCompare(b.entry.provider) ||
      a.entry.model.localeCompare(b.entry.model)
  )
  const best = candidates[0]
  // A shared display name may refer to multiple distinct model IDs. Leave that
  // association to the user instead of choosing a version by price or ordering.
  if (
    best?.score === 1 &&
    new Set(candidates.map(({ entry }) => normalize(basename(entry.model)))).size > 1
  )
    return undefined
  return best?.entry
}
