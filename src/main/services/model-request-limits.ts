import type { CatalogPrice } from '../../shared/contracts'
import { obj, ProtocolError, type Wire } from './protocol-request'

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Apply known limits after protocol conversion, without mutating the client's retry payload. */
export function normalizeModelRequestLimits(
  body: Wire,
  route: string,
  limit: CatalogPrice['limit']
): Wire {
  const keys =
    route === '/v1/messages'
      ? ['max_tokens']
      : route === '/v1/responses'
        ? ['max_output_tokens']
        : route === '/v1/chat/completions'
          ? ['max_tokens', 'max_completion_tokens']
          : []
  if (!keys.length) return body // Token counting has no output budget.
  const ceilings = [limit?.output, limit?.context].filter(positiveInteger)
  if (!ceilings.length) return body
  const ceiling = Math.min(...ceilings)
  let result = body
  const set = (key: string, value: unknown) => {
    if (result === body) result = { ...body }
    result[key] = value
  }
  for (const key of keys) {
    // Leave malformed values to protocol validation; only clamp valid budgets.
    if (positiveInteger(body[key]) && body[key] > ceiling) set(key, ceiling)
  }
  // Only Messages requires a budget. Preserve upstream defaults for optional fields;
  // different Chat model families accept different budget parameter names.
  // A context window alone is not an advertised output allowance.
  if (route === '/v1/messages' && body.max_tokens == null && positiveInteger(limit?.output))
    set(keys[0], ceiling)

  const thinking = obj(result.thinking)
  if (
    route === '/v1/messages' &&
    result.max_tokens !== body.max_tokens &&
    thinking.type === 'enabled' &&
    positiveInteger(thinking.budget_tokens) &&
    thinking.budget_tokens >= result.max_tokens
  ) {
    if (result.max_tokens <= 1024)
      throw new ProtocolError(
        '模型输出上限不足以容纳 thinking.budget_tokens（至少 1024 token），请关闭思考或选择其他模型'
      )
    set('thinking', { ...thinking, budget_tokens: result.max_tokens - 1 })
  }
  return result
}
