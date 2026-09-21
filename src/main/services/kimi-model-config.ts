import type { GatewaySnapshot } from '../../shared/contracts'
import { accountSupportsModel } from '../../shared/model-mapping'
import { registryModels } from './model-registry'

// TOML basic strings share JSON escapes except for control characters, which
// TOML requires to be escaped even when JSON permits them literally.
const quote = (value: string): string =>
  JSON.stringify(value).replace(
    /[\u0000-\u001f\u007f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
const array = (values: string[]): string => `[ ${values.map(quote).join(', ')} ]`

export function kimiModelConfig(
  model: string,
  snapshot: Pick<GatewaySnapshot, 'accounts' | 'modelPriceCatalog' | 'modelPrices'>
): string {
  const accounts = snapshot.accounts.filter(
    (account) =>
      account.enabled &&
      account.hasCredential &&
      account.capabilities &&
      accountSupportsModel(account, model)
  )
  if (!accounts.length) throw new Error('该模型暂无已启用且同步成功的来源账号')
  const entries = snapshot.modelPriceCatalog.entries
  const prices = snapshot.modelPrices
  const contexts = accounts.map(
    (account) => registryModels([account], entries, prices)[model]?.limit?.context
  )
  if (contexts.some((value) => !value || !Number.isSafeInteger(value) || value <= 0))
    throw new Error('缺少该模型的上下文长度，请先在设置的模型定价中关联模型目录，再重试复制')
  const metadata = registryModels(accounts, entries, prices)[model]
  const capabilities: string[] = []
  if (metadata.tool_call) capabilities.push('tool_use')
  if (metadata.reasoning) capabilities.push('thinking')
  if (metadata.modalities?.input?.includes('image')) capabilities.push('image_in')
  const lines = [
    `[models.${quote(`Navo/${model}`)}]`,
    'provider = "Navo"',
    `model = ${quote(model)}`,
    `max_context_size = ${Math.min(...(contexts as number[]))}`,
    `capabilities = ${array(capabilities)}`,
    `display_name = ${quote(metadata.name)}`
  ]
  if (metadata.reasoning && metadata.support_efforts?.length)
    lines.push(`support_efforts = ${array(metadata.support_efforts)}`)
  return `${lines.join('\n')}\n`
}
