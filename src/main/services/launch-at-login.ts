import { readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { App } from 'electron'
import type { LaunchAtLoginState } from '../../shared/contracts'

function linuxAutostartFile(env: NodeJS.ProcessEnv): string {
  const config = env.XDG_CONFIG_HOME
  return join(
    config && isAbsolute(config) ? config : join(homedir(), '.config'),
    'autostart',
    'dev.navo.app.desktop'
  )
}

function desktopExec(path: string): string {
  if (/[=\r\n]/.test(path)) throw new Error('应用路径包含无效字符')
  const quoted = path
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/%/g, '%%')
  // Desktop Entry string parsing runs before Exec argument unquoting.
  return `"${quoted.replace(/\\/g, '\\\\')}"`
}

export function linuxAutostartEntry(path: string): string {
  return `[Desktop Entry]\nType=Application\nName=Navo\nExec=${desktopExec(path)}\nTerminal=false\nX-Navo-Autostart=true\n`
}

export class LaunchAtLogin {
  constructor(
    private readonly app: Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>,
    private readonly platform = process.platform,
    private readonly env = process.env
  ) {}

  private supported(): boolean {
    return (
      this.app.isPackaged &&
      !this.env.NAVO_TEST_USER_DATA &&
      ['darwin', 'win32', 'linux'].includes(this.platform)
    )
  }

  private linuxEntry(): string {
    const executable = this.env.APPIMAGE || process.execPath
    return linuxAutostartEntry(resolve(executable))
  }

  get(): LaunchAtLoginState {
    if (!this.supported()) {
      return { supported: false, enabled: false, requiresApproval: false }
    }
    if (this.platform === 'linux') {
      try {
        const content = readFileSync(linuxAutostartFile(this.env), 'utf8')
        return {
          supported: true,
          enabled: content === this.linuxEntry(),
          requiresApproval: false
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return { supported: true, enabled: false, requiresApproval: false }
      }
    }
    const item = this.app.getLoginItemSettings()
    return {
      supported: true,
      enabled:
        this.platform === 'win32'
          ? item.openAtLogin && item.executableWillLaunchAtLogin
          : item.status === 'enabled' || item.status === 'requires-approval',
      requiresApproval: this.platform === 'darwin' && item.status === 'requires-approval'
    }
  }

  async set(enabled: boolean): Promise<LaunchAtLoginState> {
    if (typeof enabled !== 'boolean') throw new Error('开机自启设置无效')
    if (!this.supported()) throw new Error('开机自启仅在安装版中可用')
    if (this.platform === 'linux') {
      const file = linuxAutostartFile(this.env)
      if (enabled) {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(`${file}.tmp`, this.linuxEntry(), { mode: 0o644 })
        await rename(`${file}.tmp`, file)
      } else {
        try {
          await unlink(file)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } else {
      this.app.setLoginItemSettings({ openAtLogin: enabled })
    }
    return this.get()
  }
}
