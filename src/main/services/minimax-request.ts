type Body = Record<string, unknown>

function object(value: unknown): Body {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Body) : {}
}

// Match sub2api's NormalizeChineseLLMThinking after protocol conversion.
// Keep effort, budgets and historical thinking/tool blocks intact.
export function normalizeMiniMaxRequest<T extends Body>(body: T, model: string, route: string): T {
  if (!/^minimax-m/i.test(model) || !['/v1/messages', '/v1/chat/completions'].includes(route))
    return body
  if (route === '/v1/chat/completions' && body.reasoning_split === undefined)
    body = { ...body, reasoning_split: true }
  const thinking = object(body.thinking)
  if (thinking.type === 'enabled') return { ...body, thinking: { ...thinking, type: 'adaptive' } }
  // Low/minimal effort also means thinking is requested. Generic Messages
  // conversion does not emit a budget for those levels, but M3 defaults to off.
  if (body.thinking !== undefined) return body
  const effort =
    route === '/v1/messages' ? object(body.output_config).effort : body.reasoning_effort
  if (
    typeof effort !== 'string' ||
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
  )
    return body
  return { ...body, thinking: { type: effort === 'none' ? 'disabled' : 'adaptive' } }
}
