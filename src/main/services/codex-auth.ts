import { parseCodexQuota } from '../../shared/codex-quota'
import { readLocalCodexAuth } from './codex-local'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AccountCapabilities } from '../../shared/contracts'
import { GatewayStore, capabilityFields, object, string, type Credential } from './gateway-store'
import { ProtocolError, type Wire } from './protocol-request'

const BASE = 'https://chatgpt.com/backend-api/codex'
const VERSION = '0.144.0'
function claim(token: string): Record<string, unknown> {
  try {
    return object(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()))
  } catch {
    return {}
  }
}
function token(value: unknown, label: string): string {
  const result = string(value, label, 16384)
  if (/[\s\x00-\x1f\x7f]/.test(result)) throw new Error(label + '格式无效')
  return result
}
export function parseCodexAuth(raw: string): Credential {
  let auth: Record<string, unknown>
  try {
    auth = object(JSON.parse(raw))
  } catch {
    throw new Error('Codex auth.json 格式无效')
  }
  if ((auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') || !auth.tokens)
    throw new Error('请先在 Codex 中使用 ChatGPT 账号登录；此入口不支持 API Key')
  const tokens = object(auth.tokens)
  const accessToken = token(tokens.access_token, 'Codex 访问令牌')
  const access = claim(accessToken)
  const identity = claim(typeof tokens.id_token === 'string' ? tokens.id_token : '')
  const accountClaim =
    access['https://api.openai.com/auth'] ?? identity['https://api.openai.com/auth']
  const accountId = token(
    tokens.account_id ?? (accountClaim && object(accountClaim).chatgpt_account_id),
    'Codex 账号 ID'
  )
  const userId =
    identity.sub ?? (accountClaim && object(accountClaim).chatgpt_user_id) ?? access.sub
  return {
    accessToken,
    accountId,
    ...(userId ? { userId: token(userId, 'Codex 用户 ID') } : {}),
    ...(tokens.refresh_token
      ? { refreshToken: token(tokens.refresh_token, 'Codex 刷新令牌') }
      : {}),
    ...(typeof access.exp === 'number' && Number.isSafeInteger(access.exp * 1000) && access.exp > 0
      ? { expiresAt: access.exp * 1000 }
      : {})
  }
}
export function codexHeaders(credential: Credential): Record<string, string> {
  return {
    authorization: 'Bearer ' + credential.accessToken,
    'chatgpt-account-id': credential.accountId!,
    originator: 'codex_cli_rs',
    version: VERSION,
    'user-agent': 'codex_cli_rs/' + VERSION,
    accept: 'text/event-stream'
  }
}
export function codexRequest(body: Wire): Wire {
  if (body.previous_response_id || body.background)
    throw new ProtocolError('Codex 为无状态接口，请传入完整历史且关闭 background')
  const result: Wire = {
    ...body,
    store: false,
    stream: true,
    instructions: typeof body.instructions === 'string' ? body.instructions : ''
  }
  if (typeof result.input === 'string')
    result.input = [{ role: 'user', content: [{ type: 'input_text', text: result.input }] }]
  for (const key of [
    'max_output_tokens',
    'max_completion_tokens',
    'max_tokens',
    'temperature',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
    'stream_options'
  ])
    delete result[key]
  return result
}
export function sameCodexAccount(a: Credential, b: Credential): boolean {
  return (
    a.accountId === b.accountId &&
    (a.userId && b.userId
      ? a.userId === b.userId
      : !!(a.refreshToken && a.refreshToken === b.refreshToken) || a.accessToken === b.accessToken)
  )
}
export class CodexAuth {
  private importing?: Promise<string>
  private refreshing = new Map<string, Promise<Credential>>()
  constructor(
    private store: GatewayStore,
    private request: typeof fetch = fetch,
    private home = process.env.CODEX_HOME || join(homedir(), '.codex')
  ) {}
  importLocal(): Promise<string> {
    this.importing ??= this.importOnce().finally(() => {
      this.importing = undefined
    })
    return this.importing
  }
  private async importOnce(): Promise<string> {
    const raw = await readLocalCodexAuth(this.home)
    let credential = parseCodexAuth(raw)
    const existing = this.store
      .get()
      .accounts.find((a) => a.provider === 'codex' && sameCodexAccount(a.credential, credential))
    if (existing && (existing.credential.expiresAt ?? 0) > (credential.expiresAt ?? 0))
      credential = existing.credential
    if (credential.expiresAt && credential.expiresAt <= Date.now() + 60000)
      credential = await this.renew(credential)
    const capabilities = await this.models(credential)
    let importedId = ''
    await this.store.mutate((data) => {
      const old = data.accounts.find(
        (a) => a.provider === 'codex' && sameCodexAccount(a.credential, credential)
      )
      if (old) {
        importedId = old.id
        old.credential = credential
        Object.assign(
          old,
          capabilityFields(
            old.region,
            !capabilities.quota && old.capabilities?.quota
              ? {
                  ...capabilities,
                  quota: old.capabilities.quota,
                  checkedAt: old.capabilities.checkedAt
                }
              : capabilities,
            old.concurrencyOverride,
            'codex',
            old.excludedModels,
            old.manualModels
          )
        )
      } else
        data.accounts.push({
          id: (importedId = randomUUID()),
          name: 'Codex ' + credential.accountId!.slice(0, 8),
          provider: 'codex',
          kind: 'oauth',
          region: 'global',
          enabled: true,
          memberships: [{ groupId: 'default', priority: 0, weight: 1 }],
          credential,
          ...capabilityFields('global', capabilities, null, 'codex')
        })
    })
    return importedId
  }
  async models(credential: Credential, signal?: AbortSignal): Promise<AccountCapabilities> {
    const response = await this.request(BASE + '/models?client_version=' + VERSION, {
      headers: { ...codexHeaders(credential), accept: 'application/json' },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
      redirect: 'manual'
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Codex 模型同步失败（' + response.status + '），请确认本地登录有效后重新导入')
    }
    let data: Record<string, unknown>
    try {
      data = object(await response.json())
    } catch {
      throw new Error('Codex 上游返回了无效 JSON')
    }
    const models = Array.isArray(data.models) ? data.models : data.data
    if (!Array.isArray(models)) throw new Error('Codex 模型列表格式无效')
    const names = [
      ...new Set(
        models
          .filter((m) => m && typeof m === 'object')
          .map((m) => string(m.slug ?? m.id, 'Codex 模型', 200))
      )
    ]
    if (!names.length) throw new Error('Codex 未返回可用模型')
    const usage = await this.quota(credential, signal)
    return {
      models: names,
      maxConcurrency: null,
      checkedAt: Date.now(),
      ...usage
    }
  }
  private async quota(credential: Credential, signal?: AbortSignal) {
    const unavailable = (warning: string) => ({ quota: null, warning })
    try {
      const response = await this.request('https://chatgpt.com/backend-api/wham/usage', {
        headers: { ...codexHeaders(credential), accept: 'application/json' },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
        redirect: 'manual'
      })
      if (!response.ok) {
        await response.body?.cancel()
        return unavailable(
          response.status === 401 || response.status === 403
            ? `Codex 额度查询未获授权（${response.status}），请重新登录并导入认证。`
            : `Codex 额度查询失败（${response.status}），请稍后重试。`
        )
      }
      const quota = parseCodexQuota(await response.json())
      return { quota, warning: quota ? '' : 'Codex 未返回可识别的额度窗口。' }
    } catch {
      signal?.throwIfAborted()
      return unavailable('Codex 额度查询失败，请检查网络后重试。')
    }
  }
  async credential(id: string): Promise<Credential> {
    const account = this.store.get().accounts.find((a) => a.id === id && a.provider === 'codex')
    if (!account) throw new Error('Codex 账号不存在')
    if (!account.credential.expiresAt || account.credential.expiresAt > Date.now() + 60000)
      return account.credential
    const active = this.refreshing.get(id)
    if (active) return active
    const work = this.refresh(id, account.credential).finally(() => this.refreshing.delete(id))
    this.refreshing.set(id, work)
    return work
  }
  private async renew(old: Credential): Promise<Credential> {
    if (!old.refreshToken) throw new Error('Codex 认证已过期，请重新登录并导入')
    const response = await this.request('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: old.refreshToken,
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
      })
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Codex 认证刷新失败（' + response.status + '），请重新登录并导入')
    }
    let data: Record<string, unknown>
    try {
      data = object(await response.json())
    } catch {
      throw new Error('Codex 上游返回了无效 JSON')
    }
    const next = parseCodexAuth(
      JSON.stringify({
        tokens: {
          ...data,
          account_id: old.accountId,
          refresh_token: data.refresh_token || old.refreshToken
        }
      })
    )
    if (old.userId && next.userId && old.userId !== next.userId)
      throw new Error('Codex 刷新返回的用户身份不一致')
    next.userId ??= old.userId
    if (
      !next.expiresAt &&
      typeof data.expires_in === 'number' &&
      data.expires_in > 0 &&
      Number.isSafeInteger(Math.floor(Date.now() + data.expires_in * 1000))
    )
      next.expiresAt = Math.floor(Date.now() + data.expires_in * 1000)
    return next
  }
  private async refresh(id: string, old: Credential): Promise<Credential> {
    // 优先复用 Codex 自己更新的令牌，避免用已经轮换的旧刷新令牌。
    let next: Credential | undefined
    try {
      const local = parseCodexAuth(await readLocalCodexAuth(this.home))
      if (
        sameCodexAccount(local, old) &&
        local.accessToken !== old.accessToken &&
        local.expiresAt &&
        local.expiresAt > Date.now() + 60000
      )
        next = local
    } catch {
      /* 本地账号可以已切换或移除，继续使用已导入的认证。 */
    }
    const credential = next ?? (await this.renew(old))
    await this.store.mutate((data) => {
      const account = data.accounts.find((a) => a.id === id && a.provider === 'codex')
      if (!account || account.credential.accessToken !== old.accessToken)
        throw new Error('Codex 账号已变更，请重试')
      account.credential = credential
    })
    return credential
  }
}
