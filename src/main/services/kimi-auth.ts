import { randomUUID } from 'node:crypto'
import { accountBaseUrl, type Region, type AccountCapabilities } from '../../shared/contracts'
import { GatewayStore, capabilityFields, object, string, type Credential } from './gateway-store'
import { KimiCapabilities } from './kimi-capabilities'
import { parseKimiAuth, readLocalKimiAuth } from './kimi-local'

export function kimiHeaders(credential: Credential): Record<string, string> {
  if (!credential.kimiOAuth) return {}
  return {
    'x-msh-device-name': 'Navo',
    'x-msh-device-model': `${process.platform} ${process.arch}`,
    'x-msh-os-version': process.platform,
    'x-msh-device-id': credential.deviceId!
  }
}

export class KimiAuth {
  private importing = new Map<Region, Promise<string>>()
  private refreshing = new Map<string, Promise<Credential>>()
  private capabilities: KimiCapabilities
  constructor(
    private store: GatewayStore,
    private request: typeof fetch = fetch,
    private readLocal: () => Promise<Credential> = readLocalKimiAuth
  ) {
    this.capabilities = new KimiCapabilities(request)
  }

  importLocal(region: Region): Promise<string> {
    const pending = this.importing.get(region)
    if (pending) return pending
    const work = this.importOnce(region).finally(() => this.importing.delete(region))
    this.importing.set(region, work)
    return work
  }
  private async importOnce(region: Region): Promise<string> {
    let credential = await this.readLocal()
    const existing = this.store
      .get()
      .accounts.find(
        (a) =>
          a.provider === 'kimi' &&
          a.kind === 'oauth' &&
          a.region === region &&
          (a.credential.accessToken === credential.accessToken ||
            a.credential.refreshToken === credential.refreshToken ||
            (!!credential.localTokenHash &&
              a.credential.localTokenHash === credential.localTokenHash))
      )
    if (
      existing &&
      ((credential.localTokenHash &&
        existing.credential.localTokenHash === credential.localTokenHash) ||
        (existing.credential.expiresAt ?? 0) > (credential.expiresAt ?? 0))
    )
      credential = existing.credential
    if ((credential.expiresAt ?? 0) <= Date.now() + 60000)
      credential = await this.renew(credential, region)
    const profile = await this.json(accountBaseUrl(region, 'kimi') + '/me', {
      headers: { authorization: `Bearer ${credential.accessToken}`, ...kimiHeaders(credential) }
    })
    credential.accountId = string(profile.user_id ?? profile.userId, 'Kimi 用户 ID', 512)
    const capabilities = await this.models(region, credential)
    let id = ''
    await this.store.mutate((data) => {
      const old = data.accounts.find(
        (a) =>
          a.provider === 'kimi' &&
          a.kind === 'oauth' &&
          a.region === region &&
          a.credential.accountId === credential.accountId
      )
      if (old) {
        id = old.id
        old.credential = credential
        Object.assign(
          old,
          capabilityFields(
            region,
            !capabilities.quota && old.capabilities?.quota
              ? {
                  ...capabilities,
                  quota: old.capabilities.quota,
                  checkedAt: old.capabilities.checkedAt
                }
              : capabilities,
            old.concurrencyOverride,
            'kimi',
            old.excludedModels,
            old.manualModels
          )
        )
      } else {
        id = randomUUID()
        data.accounts.push({
          id,
          name: 'Kimi ' + credential.accountId!.slice(0, 8),
          provider: 'kimi',
          kind: 'oauth',
          kimiOAuthOnly: true,
          region,
          enabled: true,
          memberships: [{ groupId: 'default', priority: 0, weight: 1 }],
          credential,
          ...capabilityFields(region, capabilities, null, 'kimi')
        })
      }
    })
    return id
  }
  models(
    region: Region,
    credential: Credential,
    signal?: AbortSignal
  ): Promise<AccountCapabilities> {
    return this.capabilities.get(
      region,
      credential.accessToken,
      true,
      'kimi',
      signal,
      kimiHeaders(credential)
    )
  }
  async credential(id: string): Promise<Credential> {
    const account = this.store
      .get()
      .accounts.find((a) => a.id === id && a.provider === 'kimi' && a.kind === 'oauth')
    if (!account) throw new Error('Kimi 登录账号不存在')
    if ((account.credential.expiresAt ?? 0) > Date.now() + 60000) return account.credential
    const active = this.refreshing.get(id)
    if (active) return active
    const work = this.refresh(id, account.credential, account.region).finally(() =>
      this.refreshing.delete(id)
    )
    this.refreshing.set(id, work)
    return work
  }
  private async json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.request(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(20000)
      })
    } catch {
      throw new Error('Kimi 认证请求失败，请检查网络后重试')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Kimi 认证失败（${response.status}），请确认账号区域或重新登录后导入`)
    }
    try {
      return object(await response.json())
    } catch {
      throw new Error('Kimi 认证响应格式无效')
    }
  }
  private async renew(old: Credential, region: Region): Promise<Credential> {
    if (!old.refreshToken) throw new Error('Kimi 登录已过期，请重新登录并导入')
    const data = await this.json(
      `https://auth.kimi.${region === 'global' ? 'ai' : 'com'}/api/oauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...kimiHeaders(old) },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: '17e5f671-d194-4dfb-9706-5516cb48c098',
          refresh_token: old.refreshToken
        }).toString()
      }
    )
    if (
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 60
    )
      throw new Error('Kimi 刷新令牌有效期无效')
    return {
      ...parseKimiAuth(
        JSON.stringify({
          ...data,
          refresh_token: data.refresh_token || old.refreshToken,
          expires_at: Date.now() / 1000 + data.expires_in
        }),
        old.deviceId!
      ),
      accountId: old.accountId,
      localTokenHash: old.localTokenHash
    }
  }
  private async refresh(id: string, old: Credential, region: Region): Promise<Credential> {
    let next: Credential | undefined
    try {
      const local = await this.readLocal()
      if (local.accessToken !== old.accessToken && (local.expiresAt ?? 0) > Date.now() + 60000) {
        const profile = await this.json(accountBaseUrl(region, 'kimi') + '/me', {
          headers: { authorization: `Bearer ${local.accessToken}`, ...kimiHeaders(local) }
        })
        if ((profile.user_id ?? profile.userId) === old.accountId)
          next = { ...local, accountId: old.accountId }
      }
    } catch {
      /* 本地账号可能已切换或移除，继续使用导入的认证。 */
    }
    const credential = next ?? (await this.renew(old, region))
    await this.store.mutate((data) => {
      const account = data.accounts.find(
        (a) => a.id === id && a.provider === 'kimi' && a.kind === 'oauth'
      )
      if (!account || account.credential.accessToken !== old.accessToken)
        throw new Error('Kimi 账号已变更，请重试')
      account.credential = credential
    })
    return credential
  }
}
