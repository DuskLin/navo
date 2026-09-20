import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Monitor, RefreshCw, FlaskConical } from 'lucide-react'
import { SessionMigrationSettings } from './SessionMigrationSettings'
import { SettingsToggle } from './SettingsToggle'
import type { KimiDesktopState, KimiDesktopPreferences } from '../../shared/kimi-desktop'
import './experimental.css'

export function KimiDesktopSettings({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<KimiDesktopState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  useEffect(() => {
    let alive = true
    const poll = async () => {
      if (pending.current) return
      try {
        const result = await window.navo.getKimiDesktop()
        if (alive && !pending.current) setState(result)
      } catch {
        if (alive) setError('无法读取桌面集成状态')
      }
    }
    void poll()
    const timer = setInterval(poll, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  async function action(run: () => Promise<KimiDesktopState>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await run()
      setState(result)
      setError(result.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const save = (patch: Partial<KimiDesktopPreferences>) => {
    if (!state) return
    void action(() =>
      window.navo.saveKimiDesktop({
        enabled: state.enabled,
        autoReapply: state.autoReapply,
        accountQuota: state.accountQuota,
        sessionStats: state.sessionStats,
        ...patch
      })
    )
  }
  return (
    <div className="experiments-page">
      <header className="experiments-heading">
        <div>
          <span className="experiments-eyebrow">
            <FlaskConical size={13} /> LABS
          </span>
          <h2>实验性功能</h2>
        </div>
        <span className="lab-badge">预览</span>
      </header>
      {children}
      <section className="lab-card" aria-label="Kimi Code Desktop 集成">
        <header className="lab-card-heading">
          <span className="lab-icon">
            <Monitor size={20} />
          </span>
          <div className="lab-heading-copy">
            <h3>Kimi Code Desktop</h3>
            <p>在顶部查看账号额度与会话统计</p>
          </div>
          <span className="lab-badge">macOS</span>
        </header>
        {state ? (
          <>
            <div className="lab-toggles">
              <SettingsToggle
                label="启用集成"
                hint="随 Navo 运行"
                checked={state.enabled}
                disabled={busy || !state.supported}
                onChange={(enabled) => save({ enabled })}
              />
              <SettingsToggle
                label="账号额度"
                hint="在顶部显示账号额度与余额"
                checked={state.accountQuota}
                disabled={busy || !state.supported}
                onChange={(accountQuota) => save({ accountQuota })}
              />
              <SettingsToggle
                label="会话统计"
                hint="在顶部显示生成速率、Token 用量与缓存命中率"
                checked={state.sessionStats}
                disabled={busy || !state.supported}
                onChange={(sessionStats) => save({ sessionStats })}
              />
              <SettingsToggle
                label="更新后自动恢复"
                hint="Desktop 更新后重新应用集成"
                checked={state.autoReapply}
                disabled={busy || !state.enabled || !state.supported}
                onChange={(autoReapply) => save({ autoReapply })}
              />
            </div>
            <footer className="lab-card-footer">
              <span className={`lab-status ${state.patched ? 'is-active' : ''}`} role="status">
                <i />
                {state.patched ? '已注入' : state.status}
                {state.version && <span className="lab-version">v{state.version}</span>}
              </span>
              <button
                className="button lab-secondary"
                disabled={busy || !state.enabled || !state.compatible}
                onClick={() => void action(() => window.navo.reapplyKimiDesktop())}
              >
                <RefreshCw size={14} />
                {busy ? '处理中…' : '重新注入'}
              </button>
            </footer>
            {state.patched && <p className="lab-footnote">在 Kimi Code 按 ⌘R 刷新生效</p>}
          </>
        ) : (
          <p className="lab-loading" role="status">
            正在检测 Desktop…
          </p>
        )}
        {(error || state?.error) && (
          <p role="alert" className="error-banner">
            {error || state?.error}
          </p>
        )}
      </section>
      <SessionMigrationSettings />
    </div>
  )
}
