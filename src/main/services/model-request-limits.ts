import type { CatalogPrice } from '../../shared/contracts'
import type { Wire } from './protocol-request'

/** Opt-in accounts prefer gateway output values; otherwise preserve client budgets. */
export function normalizeModelRequestLimits(
  body: Wire,
  route: string,
  limit: CatalogPrice['limit'],
  enabled = false
): Wire {
  if (!enabled) return body
  const key =
    route === '/v1/chat/completions' && Object.hasOwn(body, 'max_completion_tokens')
      ? 'max_completion_tokens'
      : route === '/v1/messages' || route === '/v1/chat/completions'
        ? 'max_tokens'
        : route === '/v1/responses'
          ? 'max_output_tokens'
          : undefined
  if (!key) return body
  const output = limit?.output
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output <= 0) return body
  // Keep the client's Chat field choice and align both fields if both were sent.
  return {
    ...body,
    [key]: output,
    ...(route === '/v1/chat/completions' && Object.hasOwn(body, 'max_tokens')
      ? { max_tokens: output }
      : {})
  }
}
