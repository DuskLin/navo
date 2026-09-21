import type { AccountInput } from './contracts'

type MappingAccount = Pick<AccountInput, 'modelMappings'> & { models: string[] }

export function validateModelMappings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('模型 ID 映射格式无效')
  const entries = Object.entries(value)
  if (entries.length > 2000) throw new Error('模型 ID 映射最多添加 2000 条')
  const seen = new Set<string>()
  return Object.fromEntries(
    entries.map(([source, target]) => {
      const from = source.trim()
      const to = typeof target === 'string' ? target.trim() : ''
      if ([from, to].some((id) => !id || id.length > 200 || /[\s\x00-\x1f\x7f]/.test(id)))
        throw new Error('映射的模型 ID 不能为空、超过 200 个字符或包含空格及控制字符')
      if (from.slice(0, -1).includes('*') || to.includes('*'))
        throw new Error('仅请求模型 ID 末尾支持一个 *，上游模型 ID 不支持通配符')
      if (seen.has(from)) throw new Error(`请求模型 ID 重复：${from}`)
      seen.add(from)
      return [from, to]
    })
  )
}

/** Like sub2api: exact matches first, then the longest trailing-* prefix. No chaining. */
export function mappedModel(account: Pick<AccountInput, 'modelMappings'>, model: string): string {
  const mappings = account.modelMappings
  if (!mappings) return model
  if (Object.hasOwn(mappings, model)) return mappings[model]
  let longest = -1
  let target = model
  for (const [pattern, value] of Object.entries(mappings)) {
    if (
      pattern.endsWith('*') &&
      pattern.length > longest &&
      model.startsWith(pattern.slice(0, -1))
    ) {
      longest = pattern.length
      target = value
    }
  }
  return target
}

export function accountSupportsModel(account: MappingAccount, model: string): boolean {
  return account.models.includes(mappedModel(account, model))
}

/** Wildcards accept requests but are not concrete model IDs to advertise. */
export function exposedModels(account: MappingAccount): string[] {
  return [...new Set([...account.models, ...Object.keys(account.modelMappings ?? {})])].filter(
    (model) => !model.includes('*') && accountSupportsModel(account, model)
  )
}
