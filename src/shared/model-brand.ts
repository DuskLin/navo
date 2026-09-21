export type ModelBrand =
  | 'huawei'
  | 'spark'
  | 'stepfun'
  | 'doubao'
  | 'kimi'
  | 'grok'
  | 'deepseek'
  | 'qwen'
  | 'zai'
  | 'minimax'
  | 'longcat'
  | 'mimo'
  | 'hunyuan'
  | 'openai'
  | 'meta'
  | 'opencode'
  | 'claude'
  | 'gemini'

/** Match model families, including provider-qualified IDs; never infer from arbitrary substrings. */
export function modelBrand(model: string): ModelBrand | null {
  const id = model.trim().toLowerCase().split('/').at(-1) ?? ''
  const rules: [RegExp, ModelBrand][] = [
    [/^(?:kimi(?:[-_ .]|$)|k[23](?:[-_. ]|$))/, 'kimi'],
    [/^grok(?:[-_ .\d]|$)/, 'grok'],
    [/^deepseek(?:[-_ .]|$)/, 'deepseek'],
    [/^qwen(?:[-_ .\d]|$)/, 'qwen'],
    [/^(?:glm|chatglm)(?:[-_ .\d]|$)/, 'zai'],
    [/^minimax(?:[-_ .]|$)/, 'minimax'],
    [/^longcat(?:[-_ .]|$)/, 'longcat'],
    [/^(?:xiaomi[-_ ])?mimo(?:[-_ .]|$)/, 'mimo'],
    [/^(?:hunyuan(?:[-_ .]|$)|hy\d(?:[-_ .]|$))/, 'hunyuan'],
    [/^(?:gpt(?:[-_ .]|$)|o[134](?:[-_ .]|$))/, 'openai'],
    [/^(?:muse[-_ ]spark|llama)(?:[-_ .\d]|$)/, 'meta'],
    [/^claude(?:[-_ .]|$)/, 'claude'],
    [/^(?:pangu|huawei)(?:[-_ .\d]|$)/, 'huawei'],
    [/^spark(?:[-_ .\d]|$)/, 'spark'],
    [/^(?:step|stepfun)(?:[-_ .\d]|$)/, 'stepfun'],
    [/^doubao(?:[-_ .\d]|$)/, 'doubao'],
    [/^gemini(?:[-_ .]|$)/, 'gemini'],
    // No dedicated brand mark in the supplied set: show the serving platform.
    [/^(?:union|omen)[-_ ]alpha(?:[-_ .]|$)/, 'opencode']
  ]
  return rules.find(([pattern]) => pattern.test(id))?.[1] ?? null
}
