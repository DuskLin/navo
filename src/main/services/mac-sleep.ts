import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SleepProtectionState } from '../../shared/contracts'
import { macSleepAuthorizationScript } from './mac-sleep-helper'

type Authorize = (script: string) => Promise<string>
const authorize: Authorize = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', script],
      { timeout: 120000, maxBuffer: 8192 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().slice(0, 500)
          reject(
            new Error(
              detail.includes('(-128)')
                ? '管理员授权已取消，请重新开启开关完成授权。'
                : error.killed
                  ? '管理员授权超时，请重新开启开关完成授权。'
                  : `系统休眠辅助进程启动失败${detail ? `：${detail}` : '，请重试'}`
            )
          )
        } else resolve(stdout.trim())
      }
    )
  })

/** A session-scoped privileged watchdog, with no installed daemon or sudoers grant. */
export class MacSleepProtection {
  private session?: string
  private preparing?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private wanted = false
  private closed = false
  private state: SleepProtectionState = {
    mode: 'system',
    authorized: false,
    active: false,
    externallyDisabled: false,
    error: ''
  }

  constructor(private readonly runAuthorization: Authorize = authorize) {}

  snapshot(): SleepProtectionState {
    return { ...this.state }
  }

  prepare(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('应用正在退出'))
    if (this.preparing) return this.preparing
    if (this.session && this.state.authorized) return Promise.resolve()
    this.preparing = this.startSession().finally(() => {
      this.preparing = undefined
    })
    return this.preparing
  }

  private async startSession(): Promise<void> {
    this.invalidate()
    await this.waitForStop()
    this.session = undefined
    this.state.authorized = false
    this.state.active = false
    this.state.externallyDisabled = false
    this.state.error = ''
    try {
      const session = await this.runAuthorization(
        macSleepAuthorizationScript(process.pid, process.getuid!())
      )
      if (!/^\/private\/tmp\/navo-sleep\.[A-Za-z0-9]+$/.test(session))
        throw new Error('系统休眠辅助进程返回了无效状态')
      this.session = session
      if (this.closed) {
        this.invalidate()
        throw new Error('应用正在退出')
      }
      for (let attempt = 0; attempt < 50; attempt++) {
        this.heartbeat()
        if (this.state.authorized) break
        await delay(100)
      }
      if (!this.state.authorized) {
        let detail = ''
        try {
          detail = readFileSync(join(session, 'helper.log'), 'utf8').trim().slice(0, 500)
        } catch {}
        throw new Error(`系统休眠辅助进程未能启动${detail ? `：${detail}` : '，请重新授权'}`)
      }
      this.timer = setInterval(() => {
        try {
          this.heartbeat()
        } catch (error) {
          this.state.error = error instanceof Error ? error.message : '无法更新系统睡眠状态'
          this.state.authorized = false
          this.invalidate()
        }
      }, 1000)
      this.timer.unref()
    } catch (error) {
      this.invalidate()
      this.state.authorized = false
      this.state.error = error instanceof Error ? error.message : '无法启动系统休眠辅助进程'
      throw error
    }
  }

  private heartbeat(): void {
    if (!this.session) return
    this.writeLease()
    let status: string
    try {
      status = readFileSync(join(this.session, 'status'), 'utf8').trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.state.authorized) return
      throw new Error('系统休眠辅助进程已退出，请重新授权')
    }
    if (['enable-error', 'restore-error', 'read-error', 'stopped'].includes(status)) {
      throw new Error(
        status === 'restore-error'
          ? '系统睡眠恢复失败，请在终端执行 sudo pmset -a disablesleep 0 恢复'
          : '系统休眠控制失败，请重新开启开关授权'
      )
    }
    this.state.authorized = ['ready', 'active', 'external'].includes(status)
    this.state.active = status === 'active'
    this.state.externallyDisabled = status === 'external'
  }

  private writeLease(): void {
    if (this.session)
      writeFileSync(
        join(this.session, 'control'),
        `${Math.floor(Date.now() / 1000) + 10} ${this.wanted ? 1 : 0}\n`
      )
  }

  setWanted(wanted: boolean): void {
    this.wanted = wanted
    if (wanted && !this.state.authorized) throw new Error('禁用合盖睡眠需要管理员授权')
    try {
      this.writeLease()
    } catch {
      this.state.error = '无法更新系统睡眠状态，请重新授权'
      this.state.authorized = false
      this.invalidate()
      throw new Error(this.state.error)
    }
  }

  /** Synchronous revocation also runs on updater exits and abnormal app shutdown. */
  invalidate(): void {
    clearInterval(this.timer)
    this.timer = undefined
    if (this.session) {
      try {
        writeFileSync(join(this.session, 'control'), '0 0\n')
      } catch {
        /* The 10s lease is the fallback. */
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.invalidate()
    await this.waitForStop().catch((error) => console.warn(error))
  }

  private async waitForStop(): Promise<void> {
    if (!this.session) return
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        if (readFileSync(join(this.session, 'status'), 'utf8').trim() === 'stopped') return
      } catch {
        return
      }
      await delay(100)
    }
    throw new Error('系统睡眠尚未恢复，请在终端执行 sudo pmset -a disablesleep 0 恢复')
  }
}
