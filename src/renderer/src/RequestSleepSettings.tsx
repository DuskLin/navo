import { useEffect, useRef, useState } from 'react'
import { Coffee } from 'lucide-react'
import type { AppSettings, SleepProtectionState } from '../../shared/contracts'
import { SettingsToggle } from './SettingsToggle'

export function RequestSleepSettings() {
  const [settings, setSettings] = useState<AppSettings>()
  const [busy, setBusy] = useState(false)
  const [protection, setProtection] = useState<SleepProtectionState>()
  const [error, setError] = useState('')
  const pending = useRef(false)
  useEffect(() => {
    let alive = true
    void window.navo.getSettings().then(
      (value) => {
        if (alive) setSettings(value)
      },
      () => {
        if (alive) setError('无法读取阻止休眠设置')
      }
    )
    const poll = async () => {
      try {
        const state = await window.navo.getSleepProtection()
        if (alive) setProtection(state)
      } catch {
        if (alive) setError('无法读取系统休眠控制状态')
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  async function save(patch: Partial<AppSettings>) {
    if (pending.current || protection?.mode !== 'system') return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      setSettings(await window.navo.saveSettings(patch))
      setProtection(await window.navo.getSleepProtection())
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : '保存失败，请重试'
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <section className="lab-card" aria-label="请求期间阻止休眠">
      <header className="lab-card-heading">
        <span className="lab-icon">
          <Coffee size={20} />
        </span>
        <div className="lab-heading-copy">
          <h3>请求期间阻止休眠</h3>
          <p>请求期间禁用系统睡眠，合盖仍可运行，屏幕可正常熄灭</p>
        </div>
        <span className="lab-badge">macOS</span>
      </header>
      {protection?.mode === 'idle' ? (
        <p className="lab-footnote">此功能仅支持 macOS。</p>
      ) : settings && protection ? (
        <div className="lab-toggles">
          <SettingsToggle
            label="禁用系统睡眠（含合盖）"
            hint="需要 macOS 管理员授权；最后一个请求结束后延迟恢复"
            checked={settings.preventSleepDuringRequests}
            disabled={busy}
            onChange={(preventSleepDuringRequests) => void save({ preventSleepDuringRequests })}
          />
          <label className="settings-toggle-row sleep-delay-row">
            <span>
              <strong>释放延迟</strong>
              <small>所有请求结束后，继续保持唤醒的时间</small>
            </span>
            <select
              aria-label="释放延迟"
              value={settings.sleepReleaseDelaySeconds}
              disabled={busy || !settings.preventSleepDuringRequests}
              onChange={(event) =>
                void save({ sleepReleaseDelaySeconds: Number(event.target.value) })
              }
            >
              <option value={60}>1 分钟</option>
              <option value={300}>5 分钟</option>
              <option value={900}>15 分钟</option>
              <option value={1800}>30 分钟</option>
              <option value={3600}>1 小时</option>
            </select>
          </label>
        </div>
      ) : (
        !error && <p className="lab-loading">正在读取设置…</p>
      )}
      {protection?.mode === 'system' && (
        <>
          <footer className="lab-card-footer">
            <span className={`lab-status ${protection.active ? 'is-active' : ''}`} role="status">
              <i />
              {protection.error
                ? '系统休眠控制异常'
                : protection.externallyDisabled
                  ? '系统原本已禁用睡眠，保留原设置'
                  : !protection.authorized
                    ? '尚未授权'
                    : protection.active
                      ? '系统睡眠已禁用'
                      : '已授权，等待请求'}
            </span>
            {settings?.preventSleepDuringRequests &&
              (!protection.authorized || protection.error) && (
                <button
                  className="button lab-secondary"
                  disabled={busy}
                  onClick={() => void save({ preventSleepDuringRequests: true })}
                >
                  授权并重试
                </button>
              )}
          </footer>
          <p className="lab-footnote">
            生效时苹果菜单的“睡眠”会不可用。每次启动 Navo 后需授权一次；关闭开关或退出时恢复原设置。
            应用异常退出或失去响应后，辅助进程会在约 10 秒内恢复。屏幕休眠设置不变。
          </p>
        </>
      )}
      {busy && (
        <p className="lab-footnote" role="status">
          正在应用设置，请完成可能出现的 macOS 授权…
        </p>
      )}
      {(error || protection?.error) && (
        <p className="error-banner" role="alert">
          {error || protection?.error}
        </p>
      )}
    </section>
  )
}
