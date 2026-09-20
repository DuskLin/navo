import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Credential } from './gateway-store'
import { object, string } from './gateway-store'

export function parseKimiAuth(raw: string, deviceId: string): Credential {
  try {
    const data = object(JSON.parse(raw))
    const accessToken = string(data.access_token, '访问令牌', 16384)
    const refreshToken = string(data.refresh_token, '刷新令牌', 16384)
    if (/[\s\x00-\x1f\x7f]/.test(accessToken + refreshToken)) throw new Error()
    if (!/^[\x21-\x7e]{1,512}$/.test(deviceId)) throw new Error()
    const expiresAt = Math.floor(Number(data.expires_at) * 1000)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error()
    return {
      accessToken,
      refreshToken,
      expiresAt,
      deviceId,
      kimiOAuth: true,
      localTokenHash: createHash('sha256').update(accessToken).digest('hex')
    }
  } catch {
    throw new Error('本地 Kimi 登录凭据格式无效，请在 Kimi Code 中重新登录')
  }
}

export async function readKimiKeychain(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await promisify(execFile)(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'kimi-code', '-a', 'oauth/kimi-code', '-w'],
      { timeout: 15000, maxBuffer: 1024 * 1024 }
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function readLocalKimiAuth(
  homes = process.env.KIMI_SHARE_DIR
    ? [process.env.KIMI_SHARE_DIR]
    : [join(homedir(), '.kimi'), join(homedir(), '.kimi-code')],
  keychain: () => Promise<string | null> = readKimiKeychain
): Promise<Credential> {
  for (const home of homes) {
    let raw: string
    try {
      raw = await readFile(join(home, 'credentials', 'kimi-code.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error('无法读取本地 Kimi 登录凭据，请检查文件权限')
    }
    let deviceId: string
    try {
      deviceId = (await readFile(join(home, 'device_id'), 'utf8')).trim()
    } catch {
      throw new Error('缺少本地 Kimi 设备标识，请启动 Kimi Code 后重试')
    }
    return parseKimiAuth(raw, deviceId)
  }
  // 旧版 macOS 登录存放在钥匙串；自定义目录不读取其他实例的认证。
  if (!process.env.KIMI_SHARE_DIR && homes.some((h) => h === join(homedir(), '.kimi'))) {
    const raw = await keychain()
    if (raw) {
      for (const home of homes) {
        let deviceId: string
        try {
          deviceId = (await readFile(join(home, 'device_id'), 'utf8')).trim()
        } catch {
          continue
        }
        return parseKimiAuth(raw, deviceId)
      }
    }
  }
  throw new Error(
    '未找到本地 Kimi 登录态。请先在 Kimi Code 中登录；支持 ~/.kimi、~/.kimi-code 或 KIMI_SHARE_DIR 下的 credentials/kimi-code.json。'
  )
}
