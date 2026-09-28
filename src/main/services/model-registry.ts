import type { CatalogPrice, ModelPrice, Provider } from '../../shared/contracts'
import { mergeRegistryCapabilities } from './registry-capabilities'
import { createModelMetadataResolver } from '../../shared/model-metadata'
import { accountSupportsModel, exposedModels, mappedModel } from '../../shared/model-mapping'

type RegistryAccount = {
  provider?: Provider
  models: string[]
  modelMappings?: Record<string, string>
}

function displayName(id: string): string {
  const words: Record<string, string> = {
    kimi: 'Kimi',
    deepseek: 'DeepSeek',
    minimax: 'MiniMax',
    glm: 'GLM',
    gpt: 'GPT',
    for: 'for',
    highspeed: 'HighSpeed'
  }
  return id
    .split(/[-_]+/)
    .map((word) => words[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Keep routing IDs intact; explicit associations override automatic catalog matching. */
export function registryModels(
  accounts: RegistryAccount[],
  entries: CatalogPrice[],
  prices: ModelPrice[]
) {
  const resolve = createModelMetadataResolver(entries, prices)
  const models = [...new Set(accounts.flatMap(exposedModels))]
  return Object.fromEntries(
    models.map((id) => {
      const candidates = accounts
        .filter((account) => accountSupportsModel(account, id))
        .map((account) => {
          const provider = account.provider ?? 'kimi'
          const upstreamModel = mappedModel(account, id)
          return resolve(upstreamModel, provider)
        })
      const matches = candidates.filter((entry) => entry !== undefined)
      const capabilities = mergeRegistryCapabilities(candidates.map((entry) => entry?.capabilities))
      const name = matches.map((entry) => entry.name.trim()).find((name) => name && name !== id)
      const limit: NonNullable<CatalogPrice['limit']> = {}
      for (const key of ['context', 'output'] as const) {
        const values = matches.flatMap((entry) => (entry.limit?.[key] ? [entry.limit[key]!] : []))
        // A shared model may route to multiple providers; use the smallest advertised limit.
        if (values.length) limit[key] = Math.min(...values)
      }
      return [
        id,
        {
          id,
          name: name ?? displayName(id),
          ...(Object.keys(limit).length ? { limit } : {}),
          ...capabilities
        }
      ]
    })
  )
}
