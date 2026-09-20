import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export async function readCodexKeychain(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    // 与 cc-switch 相同的服务名；不通过 shell，也不输出凭据或子进程错误。
    const { stdout } = await exec(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Codex Auth', '-w'],
      { timeout: 15000, maxBuffer: 1024 * 1024 }
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function readLocalCodexAuth(
  home = process.env.CODEX_HOME || join(homedir(), '.codex'),
  keychain: () => Promise<string | null> = readCodexKeychain
): Promise<string> {
  // 自定义目录不读取未按目录定位的钥匙串，避免导入另一个 Codex 实例的账号。
  const defaultHome = resolve(home) === resolve(homedir(), '.codex')
  if (defaultHome) {
    const cached = await keychain()
    if (cached) return cached
  }
  try {
    return await readFile(join(home, 'auth.json'), 'utf8')
  } catch {
    throw new Error(
      '无法读取本地 Codex 认证。请先使用 ChatGPT 登录；支持 macOS Codex Auth 钥匙串及 CODEX_HOME（默认 ~/.codex）下的 auth.json。'
    )
  }
}
