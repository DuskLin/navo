import { useEffect, useRef, useState } from 'react'
import type { LaunchAtLoginState } from '../../shared/contracts'
import { SettingsToggle } from './SettingsToggle'

export function LaunchAtLoginSettings({ active }: { active: boolean }) {
  const [state, setState] = useState<LaunchAtLoginState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)

  useEffect(() => {
    if (!active) return
    let alive = true
    const refresh = () => {
      if (pending.current) return
      void window.navo.getLaunchAtLogin().then(
        (value) => {
          if (alive) {
            setState(value)
            setError('')
          }
        },
        () => {
          if (alive) setError('无法读取开机自启状态')
        }
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [active])

  async function change(enabled: boolean) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      setState(await window.navo.setLaunchAtLogin(enabled))
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : '开机自启设置失败，请重试'
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <section className="settings-group" aria-label="应用启动">
      <h3>应用启动</h3>
      {state ? (
        <SettingsToggle
          label="开机自启 Navo"
          hint={
            state.supported
              ? '登录系统后自动打开应用；此开关立即生效。网关是否自动启动由下方选项控制。'
              : '仅在安装版中可用。'
          }
          checked={state.enabled}
          disabled={busy || !state.supported}
          onChange={(enabled) => void change(enabled)}
        />
      ) : (
        !error && <p className="muted">正在读取开机自启状态…</p>
      )}
      {state?.requiresApproval && (
        <p className="muted" role="status">
          请在 macOS「系统设置 → 通用 → 登录项与扩展」中允许 Navo，开机自启才会生效。
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
