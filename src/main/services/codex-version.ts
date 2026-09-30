import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const CODEX_VERSION_URL = 'https://registry.npmjs.org/@openai/codex/latest'
export const CODEX_FALLBACK_VERSION = '0.159.2'
const REFRESH_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 5 * 60 * 1000
const stableVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)

/** 只读取官方稳定版元数据，不下载或执行 Codex；所有账号共用缓存。 */
export class CodexClientVersion {
  private version = CODEX_FALLBACK_VERSION
  private refreshAt = 0
  private loaded?: Promise<void>
  private pending?: Promise<string>
  constructor(
    private readonly file: string,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}
  async get(): Promise<string> {
    this.loaded ??= this.load()
    await this.loaded
    if (this.now() < this.refreshAt) return this.version
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      if (raw.length > 1024) return
      const data = JSON.parse(raw)
      if (
        data?.version !== 1 ||
        !stableVersion(data.clientVersion) ||
        !Number.isSafeInteger(data.checkedAt) ||
        data.checkedAt <= 0 ||
        data.checkedAt > this.now()
      )
        return
      this.version = data.clientVersion
      this.refreshAt = data.checkedAt + REFRESH_MS
    } catch {
      // 缓存不存在或损坏时继续在线获取。
    }
  }
  private async refresh(): Promise<string> {
    try {
      const response = await this.request(CODEX_VERSION_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
        redirect: 'error'
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Codex 版本查询失败')
      }
      const data = await response.json()
      if (data?.name !== '@openai/codex' || !stableVersion(data.version))
        throw new Error('Codex 稳定版本格式无效')
      this.version = data.version
      const checkedAt = this.now()
      this.refreshAt = checkedAt + REFRESH_MS
      await this.save(checkedAt)
    } catch {
      // 网络失败不阻断推理；保留上次成功版本，没有缓存时使用内置版本。
      this.refreshAt = this.now() + RETRY_MS
    }
    return this.version
  }
  private async save(checkedAt: number): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, clientVersion: this.version, checkedAt }),
        { mode: 0o600 }
      )
      await rename(temporary, this.file)
    } catch {
      // 磁盘不可写时仍保留内存缓存。
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
