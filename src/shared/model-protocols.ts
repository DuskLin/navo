import type { AccountCapabilities, AccountInput, ModelProtocol } from './contracts'
import { openCodeGoRoute } from './opencode-go'

export const MODEL_PROTOCOLS: { value: ModelProtocol; label: string; route: string }[] = [
  { value: 'messages', label: 'Messages', route: '/v1/messages' },
  { value: 'responses', label: 'Responses', route: '/v1/responses' },
  { value: 'chat-completions', label: 'Completions', route: '/v1/chat/completions' }
]
type Configuration = Pick<AccountInput, 'provider' | 'modelProtocols'> & {
  capabilities?: AccountCapabilities | null
}
export function defaultModelProtocols(
  provider: AccountInput['provider'],
  model: string
): ModelProtocol[] {
  if (provider === 'commandcode-goat')
    return /^(?:anthropic\/)?claude-/i.test(model) ? ['messages'] : ['chat-completions']
  if (provider === 'custom') return ['chat-completions']
  if (provider === 'codex') return ['responses']
  return provider === 'opencode-go'
    ? [MODEL_PROTOCOLS.find((p) => p.route === openCodeGoRoute(model))!.value]
    : MODEL_PROTOCOLS.map((p) => p.value)
}
export function supportedModelProtocols(account: Configuration, model: string): ModelProtocol[] {
  if (account.provider === 'codex') return ['responses']
  return account.modelProtocols && Object.hasOwn(account.modelProtocols, model)
    ? account.modelProtocols[model]
    : account.provider === 'commandcode-goat' &&
        account.capabilities?.modelProtocols &&
        Object.hasOwn(account.capabilities.modelProtocols, model)
      ? account.capabilities.modelProtocols[model]
      : defaultModelProtocols(account.provider, model)
}
export function modelUpstreamRoute(
  account: Configuration,
  model: string,
  incoming: string
): string {
  if (incoming === '/v1/messages/count_tokens') return incoming
  if (account.provider === 'codex') return '/v1/responses'
  const supported = supportedModelProtocols(account, model)
  const direct = MODEL_PROTOCOLS.find((p) => p.route === incoming)
  if (direct && supported.includes(direct.value)) return incoming
  const preferred = defaultModelProtocols(account.provider, model).find((p) =>
    supported.includes(p)
  )
  const selected = preferred ?? MODEL_PROTOCOLS.find((p) => supported.includes(p.value))?.value
  if (!selected) throw new Error('模型至少需要选择一种 API')
  return MODEL_PROTOCOLS.find((p) => p.value === selected)!.route
}
