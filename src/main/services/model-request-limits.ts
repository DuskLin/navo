import type { CatalogPrice } from '../../shared/contracts'
import type { Wire } from './protocol-request'

/** Client budgets win; only fill an omitted output budget from gateway metadata. */
export function normalizeModelRequestLimits(
  body: Wire,
  route: string,
  limit: CatalogPrice['limit']
): Wire {
  const key =
    route === '/v1/messages' || route === '/v1/chat/completions'
      ? 'max_tokens'
      : route === '/v1/responses'
        ? 'max_output_tokens'
        : undefined
  if (!key) return body
  // Preserve explicit values for protocol/upstream validation, without injecting
  // a second competing budget field into Chat requests.
  if (
    ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].some((field) =>
      Object.hasOwn(body, field)
    )
  )
    return body
  const output = limit?.output
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output <= 0) return body
  return { ...body, [key]: output }
}
