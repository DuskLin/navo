import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'
import type { UpdateState } from '../../shared/updates'

// GitHub feeds supply HTML; render only its text, never remote markup or resources.
function releaseNotesText(notes: string): string {
  if (
    !/<\/?(?:p|div|h[1-6]|ul|ol|li|br|pre|blockquote|a|strong|em|code|table)\b[^>]*>/i.test(notes)
  )
    return notes.trim()
  const document = new DOMParser().parseFromString(notes, 'text/html')
  document
    .querySelectorAll('script, style, iframe, object, template')
    .forEach((node) => node.remove())
  document.querySelectorAll('br').forEach((node) => node.replaceWith('\n'))
  document.querySelectorAll('li').forEach((node) => node.prepend('• '))
  document
    .querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, ul, ol, pre, blockquote, tr')
    .forEach((node) => node.append('\n'))
  return (document.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export function UpdateControl({ version }: { version?: string }) {
  const [state, setState] = useState<UpdateState>()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const notes = useMemo(() => releaseNotesText(state?.releaseNotes ?? ''), [state?.releaseNotes])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await window.navo.getUpdateState()
        if (active) setState(next)
      } catch {
        if (active) setError('更新服务连接失败，请重新打开应用。')
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    if (open) dialog.current?.showModal()
  }, [open])

  const actionable = state && ['available', 'downloaded'].includes(state.status)
  const busy = state && ['checking', 'downloading', 'installing'].includes(state.status)
  const messages: Record<UpdateState['status'], string> = {
    disabled: '开发模式',
    idle: '启动后自动检查更新',
    checking: '正在检查更新…',
    available: `发现新版本 v${state?.version}`,
    downloading: `正在下载 v${state?.version} · ${Math.round(state?.progress ?? 0)}%`,
    downloaded: `v${state?.version} 已就绪`,
    installing: '正在准备重启安装…',
    'up-to-date': '已是最新正式版本',
    error: '更新失败'
  }
  async function act(action: () => Promise<void>) {
    setError('')
    try {
      await action()
      setState(await window.navo.getUpdateState())
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : '操作失败，请重试。'
      )
    }
  }
  return (
    <>
      {state?.version &&
        state.version !== dismissedVersion &&
        ['downloading', 'downloaded', 'available'].includes(state.status) && (
          <aside className="update-notice" aria-label="新版本更新提示">
            <div>
              <strong>发现新版本 v{state.version}</strong>
              <p role="status">{messages[state.status]}</p>
            </div>
            <button className="button" onClick={() => setOpen(true)}>
              查看更新
            </button>
            <button
              className="icon-button"
              aria-label="收起更新提示"
              onClick={() => setDismissedVersion(state.version)}
            >
              <X size={14} />
            </button>
          </aside>
        )}
      <button
        className={`statusbar-copy update-trigger ${actionable ? 'update-ready' : ''}`}
        onClick={() => setOpen(true)}
        title="检查应用更新"
        aria-label="应用更新"
      >
        <ArrowUpCircle size={13} />
        {actionable
          ? messages[state.status]
          : state?.status === 'downloading'
            ? `下载更新 ${Math.round(state.progress)}%`
            : `v${version ?? '…'} · 检查更新`}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="modal update-dialog"
          aria-label="应用更新"
          onCancel={(event) => {
            event.preventDefault()
            setOpen(false)
          }}
        >
          <div className="modal-heading">
            <h2>应用更新</h2>
            <button className="icon-button" aria-label="关闭对话框" onClick={() => setOpen(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="update-content">
            <p>当前版本 v{state?.currentVersion ?? version ?? '…'}</p>
            <p role="status">{state ? messages[state.status] : '正在连接更新服务…'}</p>
            {state?.status === 'downloading' && (
              <progress aria-label="更新下载进度" max={100} value={state.progress} />
            )}
            {state?.version && (
              <section className="update-release-notes" aria-label="更新内容">
                <h3>v{state.version} 更新内容</h3>
                <div className="update-release-notes-body" tabIndex={0}>
                  {notes || '此版本暂未提供更新说明，可前往发布页查看详情。'}
                </div>
              </section>
            )}
            <p className="update-hint">
              {state?.canInstall
                ? '自动检查正式版本并在后台下载；下载完成后由你决定何时重启安装。'
                : '自动检查 GitHub 上的正式版本，发现新版后可下载安装包。'}
            </p>
            {state?.reason && <p className="update-hint">{state.reason}</p>}
            {(error || state?.error) && (
              <p className="update-error" role="alert">
                {error || state?.error}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="button"
                onClick={() => void act(() => window.navo.openReleasePage())}
              >
                发布页
              </button>
              {state?.status === 'downloaded' ? (
                <button
                  className="button primary"
                  onClick={() => void act(() => window.navo.installUpdate())}
                >
                  重启并安装
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={!state || !!busy || state.status === 'disabled'}
                  onClick={() => void act(() => window.navo.checkForUpdates())}
                >
                  {state?.status === 'error' ? '重试更新' : '检查更新'}
                </button>
              )}
            </div>
          </div>
        </dialog>
      )}
    </>
  )
}
