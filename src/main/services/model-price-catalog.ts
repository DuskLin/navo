import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  CatalogPrice,
  DefaultModelPrice,
  ModelPriceCatalogSnapshot,
  Provider
} from '../../shared/contracts'
import { PRICE_FIELDS } from '../../shared/model-pricing'
import { parseRegistryCapabilities } from './registry-capabilities'
import { object, validateModelPrice } from './gateway-store'

export const MODEL_PRICE_API = 'https://models.dev/api.json'
export const PRICE_CACHE_TTL = 24 * 60 * 60 * 1000
export const catalogProviders: Record<Provider, string> = {
  custom: 'custom',
  codex: 'openai',
  kimi: 'kimi-for-coding',
  deepseek: 'deepseek',
  minimax: 'minimax-coding-plan',
  'commandcode-goat': 'commandcode',
  'opencode-go': 'opencode-go'
}
const amount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
    ? value
    : null

function modelLimit(value: unknown): CatalogPrice['limit'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const node = object(value)
  const limit: NonNullable<CatalogPrice['limit']> = {}
  for (const key of ['context', 'output'] as const) {
    const size = node[key]
    if (typeof size === 'number' && Number.isSafeInteger(size) && size > 0) limit[key] = size
  }
  return Object.keys(limit).length ? limit : undefined
}

export function parseCatalogEntries(value: unknown): CatalogPrice[] {
  const root = object(value)
  const entries: CatalogPrice[] = []
  for (const [provider, rawProvider] of Object.entries(root)) {
    if (
      !provider.trim() ||
      provider.length > 200 ||
      !rawProvider ||
      typeof rawProvider !== 'object' ||
      Array.isArray(rawProvider)
    )
      continue
    const source = object(rawProvider)
    if (!source.models || typeof source.models !== 'object' || Array.isArray(source.models))
      continue
    for (const [model, raw] of Object.entries(object(source.models))) {
      if (
        !model.trim() ||
        model !== model.trim() ||
        model.length > 200 ||
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw)
      )
        continue
      const node = object(raw)
      const cost =
        node.cost && typeof node.cost === 'object' && !Array.isArray(node.cost)
          ? object(node.cost)
          : {}
      const limit = modelLimit(node.limit)
      const capabilities = parseRegistryCapabilities(node)
      const price: CatalogPrice = {
        provider,
        model,
        currency: 'USD',
        ...(limit ? { limit } : {}),
        ...(capabilities ? { capabilities } : {}),
        name: typeof node.name === 'string' ? node.name.slice(0, 200) : model,
        providerName: typeof source.name === 'string' ? source.name.slice(0, 200) : provider,
        input: amount(cost.input),
        output: amount(cost.output),
        cacheRead: amount(cost.cache_read),
        cacheWrite: amount(cost.cache_write),
        tiered: (Array.isArray(cost.tiers) && cost.tiers.length > 0) || !!cost.context_over_200k
      }
      if (PRICE_FIELDS.some((field) => price[field] !== null) || limit || node.name || capabilities)
        entries.push(price)
    }
  }
  if (!entries.length || entries.length > 50000) throw new Error('价格目录无有效数据')
  return entries
}
function defaultPrices(entries: CatalogPrice[]): DefaultModelPrice[] {
  return Object.entries(catalogProviders).flatMap(([provider, id]) =>
    entries
      .filter((p) => p.provider === id)
      .map(
        ({
          name: _name,
          providerName: _providerName,
          limit: _limit,
          capabilities: _capabilities,
          ...p
        }) => ({
          ...p,
          provider: provider as Provider
        })
      )
  )
}
export function parseModelPriceCatalog(value: unknown): DefaultModelPrice[] {
  return defaultPrices(parseCatalogEntries(value))
}

export class ModelPriceCatalog {
  private state: ModelPriceCatalogSnapshot = { prices: [], entries: [], updatedAt: null, error: '' }
  private pending?: Promise<void>
  private retryAt = 0
  private needsMetadataRefresh = false
  constructor(
    private readonly file: string,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}
  snapshot(): ModelPriceCatalogSnapshot {
    return structuredClone(this.state)
  }
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      if (raw.length > 20_000_000) throw new Error('cache too large')
      const data = object(JSON.parse(raw))
      if (
        (data.version !== 2 && data.version !== 3 && data.version !== 4) ||
        !Number.isSafeInteger(data.updatedAt) ||
        (data.updatedAt as number) <= 0 ||
        (data.updatedAt as number) > this.now() ||
        !Array.isArray(data.entries) ||
        !data.entries.length ||
        data.entries.length > 50000
      )
        throw new Error('invalid cache')
      const entries: CatalogPrice[] = data.entries.map((raw) => {
        const node = object(raw)
        const p = validateModelPrice({ ...node, provider: 'kimi' })
        if (
          p.currency !== 'USD' ||
          typeof node.tiered !== 'boolean' ||
          typeof node.provider !== 'string' ||
          !node.provider.trim() ||
          node.provider.length > 200 ||
          typeof node.name !== 'string' ||
          typeof node.providerName !== 'string'
        )
          throw new Error('invalid price')
        return {
          ...p,
          provider: node.provider,
          name: node.name.slice(0, 200),
          providerName: node.providerName.slice(0, 200),
          ...(modelLimit(node.limit) ? { limit: modelLimit(node.limit) } : {}),
          ...(parseRegistryCapabilities(node.capabilities)
            ? { capabilities: parseRegistryCapabilities(node.capabilities) }
            : {}),
          tiered: node.tiered
        }
      })
      if (
        new Set(entries.map((p) => JSON.stringify([p.provider, p.model]))).size !== entries.length
      )
        throw new Error('duplicate prices')
      this.needsMetadataRefresh = data.version !== 4
      this.state = {
        prices: defaultPrices(entries),
        entries,
        updatedAt: data.updatedAt as number,
        error: ''
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.state.error = '默认价格缓存不可用，请刷新价格'
    }
  }
  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending
    if (
      !force &&
      (this.now() < this.retryAt ||
        (!this.needsMetadataRefresh &&
          this.state.updatedAt !== null &&
          this.now() - this.state.updatedAt < PRICE_CACHE_TTL))
    )
      return Promise.resolve()
    this.pending = this.fetchAndSave().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
  private async fetchAndSave(): Promise<void> {
    try {
      const response = await this.request(MODEL_PRICE_API, {
        headers: { accept: 'application/json', 'user-agent': 'Navo' },
        signal: AbortSignal.timeout(15000),
        redirect: 'error'
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('HTTP error')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('empty response')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 20 * 1024 * 1024) {
            await reader.cancel()
            throw new Error('response too large')
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      const entries = parseCatalogEntries(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const prices = defaultPrices(entries)
      const updatedAt = this.now()
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 4, entries, updatedAt }), {
        mode: 0o600
      })
      await rename(`${this.file}.tmp`, this.file)
      this.state = { prices, entries, updatedAt, error: '' }
      this.retryAt = 0
      this.needsMetadataRefresh = false
    } catch {
      this.retryAt = this.now() + 5 * 60 * 1000
      this.state.error = this.state.updatedAt
        ? '默认价格更新失败，继续使用上次缓存，可稍后重试'
        : '默认价格获取失败，请检查网络后重试；手动价格仍可使用'
    }
  }
}
