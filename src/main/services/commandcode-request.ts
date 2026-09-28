import type { AccountInput } from '../../shared/contracts'
import { obj, type Wire } from './protocol-request'

// Command Code's Responses endpoint rejects reasoning.summary as an unknown field.
export function normalizeCommandCodeRequest(
  body: Wire,
  provider: AccountInput['provider'],
  route: string
): Wire {
  if (provider !== 'commandcode-goat' || route !== '/v1/responses') return body
  const reasoning = obj(body.reasoning)
  if (!Object.hasOwn(reasoning, 'summary')) return body
  const normalized = { ...reasoning }
  delete normalized.summary
  return { ...body, reasoning: normalized }
}
