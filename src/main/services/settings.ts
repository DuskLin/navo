import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings } from '../../shared/contracts'

export const defaultSettings: AppSettings = {
  theme: 'light',
  preventSleepDuringRequests: false,
  sleepReleaseDelaySeconds: 60
}

export function validateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') throw new Error('设置格式无效')
  const settings = value as AppSettings
  if (!['light', 'dark'].includes(settings.theme)) {
    throw new Error('设置包含无效选项')
  }
  const enabled = settings.preventSleepDuringRequests ?? false
  const previousDelay = settings.sleepReleaseDelaySeconds ?? 60
  // Migrate the retired 30-second and 3-minute presets to the next available tier.
  const delay = previousDelay === 30 ? 60 : previousDelay === 180 ? 300 : previousDelay
  if (typeof enabled !== 'boolean' || !Number.isInteger(delay) || delay < 1 || delay > 3600) {
    throw new Error('阻止休眠设置无效，释放延迟须为 1–3600 秒')
  }
  return {
    theme: settings.theme,
    preventSleepDuringRequests: enabled,
    sleepReleaseDelaySeconds: delay
  }
}

export class SettingsStore {
  private settings = { ...defaultSettings }
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      this.settings = validateSettings(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('无法读取设置，已使用默认值：', error)
      }
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async save(value: unknown): Promise<AppSettings> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效')
    const patch = { ...value }
    // 串行、原子替换文件，避免快速连续保存造成配置文件损坏。
    const write = this.writes.then(async () => {
      const next = validateSettings({ ...this.settings, ...patch })
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(`${this.filePath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 })
      await rename(`${this.filePath}.tmp`, this.filePath)
      this.settings = next
      return { ...next }
    })
    this.writes = write.then(
      () => {},
      () => {}
    )
    return write
  }
}
