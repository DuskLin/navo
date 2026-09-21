import type { UpdateState } from '../../shared/updates'

interface ReleaseInfo {
  version: string
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null
}

function releaseNotes(info: ReleaseInfo): string {
  const notes = info.releaseNotes
  return (
    (typeof notes === 'string'
      ? notes
      : notes?.find((entry) => entry.version === info.version)?.note) ?? ''
  ).trim()
}

// Keep the lifecycle independent of Electron so failures and concurrent commands can be tested.
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(silent?: boolean, forceRunAfter?: boolean): void | Promise<void>
}

export class UpdateService {
  private state: UpdateState
  private pending: Promise<void> | undefined
  private startupTimer?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>

  constructor(
    private readonly engine: UpdateEngine,
    options: { version: string; enabled: boolean; canInstall: boolean; reason: string },
    private readonly prepareInstall: () => Promise<void>
  ) {
    this.state = {
      status: options.enabled ? 'idle' : 'disabled',
      currentVersion: options.version,
      version: null,
      releaseNotes: '',
      progress: 0,
      canInstall: options.enabled && options.canInstall,
      reason: options.reason,
      error: ''
    }
    engine.autoDownload = false
    engine.autoInstallOnAppQuit = false
    engine.allowPrerelease = false
    engine.allowDowngrade = false
    engine.on('update-available', (info: ReleaseInfo) => {
      this.state = {
        ...this.state,
        status: 'available',
        version: info.version,
        releaseNotes: releaseNotes(info),
        error: ''
      }
    })
    engine.on('update-not-available', () => {
      this.state = {
        ...this.state,
        status: 'up-to-date',
        version: null,
        releaseNotes: '',
        error: ''
      }
    })
    engine.on('download-progress', (info: { percent: number }) => {
      if (this.state.status !== 'downloading') return
      this.state.progress = Number.isFinite(info.percent)
        ? Math.max(0, Math.min(100, info.percent))
        : 0
    })
    engine.on('update-downloaded', (info: ReleaseInfo) => {
      this.state = {
        ...this.state,
        status: 'downloaded',
        version: info.version,
        releaseNotes:
          releaseNotes(info) ||
          (info.version === this.state.version ? this.state.releaseNotes : ''),
        progress: 100
      }
    })
    engine.on('error', () => this.fail())
  }

  get(): UpdateState {
    return { ...this.state }
  }

  private fail(): void {
    const installing = this.state.status === 'installing'
    this.state = {
      ...this.state,
      status: 'error',
      error: installing
        ? '安装失败，请重试或前往发布页下载安装包。'
        : '检查或下载更新失败，请检查网络后重试，也可前往发布页手动下载。'
    }
  }

  start(): void {
    if (this.state.status === 'disabled' || this.interval) return
    this.startupTimer = setTimeout(() => void this.check(), 10_000)
    this.interval = setInterval(() => void this.check(), 6 * 60 * 60 * 1000)
    this.startupTimer.unref()
    this.interval.unref()
  }

  dispose(): void {
    clearTimeout(this.startupTimer)
    clearInterval(this.interval)
  }

  check(): Promise<void> {
    if (this.pending) return this.pending
    if (['disabled', 'downloaded', 'installing'].includes(this.state.status))
      return Promise.resolve()
    this.state = {
      ...this.state,
      status: 'checking',
      error: '',
      progress: 0,
      version: null,
      releaseNotes: ''
    }
    this.pending = Promise.resolve().then(async () => {
      try {
        await this.engine.checkForUpdates()
        if (this.get().status === 'available' && this.state.canInstall) {
          this.state.status = 'downloading'
          await this.engine.downloadUpdate()
        }
      } catch {
        this.fail()
      } finally {
        this.pending = undefined
      }
    })
    return this.pending
  }

  async install(): Promise<void> {
    if (this.state.status !== 'downloaded' || !this.state.canInstall)
      throw new Error('更新尚未下载完成')
    this.state.status = 'installing'
    try {
      await this.prepareInstall()
    } catch (error) {
      this.state.status = 'downloaded'
      throw error
    }
    try {
      await this.engine.quitAndInstall(false, true)
    } catch {
      this.fail()
    }
  }
}
