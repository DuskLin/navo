import type { HelperApi } from '../../shared/contracts'
type Visibility = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>

let nativeVisibility: Visibility | undefined
function windowVisibility(): Visibility {
  if (!nativeVisibility) {
    const state = Object.assign(new EventTarget(), { hidden: false })
    // macOS 页面可见性包含窗口遮挡；这里只暂停实际隐藏或最小化的窗口。
    const api = (window as unknown as { navo: HelperApi }).navo
    api.onWindowVisibilityChange?.((visible) => {
      if (state.hidden === !visible) return
      state.hidden = !visible
      state.dispatchEvent(new Event('visibilitychange'))
    })
    nativeVisibility = state
  }
  return nativeVisibility
}

/** 隐藏窗口暂停展示轮询，恢复时刷新；慢请求期间不叠加新请求。 */
export function startVisiblePolling(
  poll: () => Promise<void>,
  interval: number,
  visibility: Visibility = windowVisibility()
) {
  let stopped = false
  let running = false
  let refreshAgain = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    clearTimeout(timer)
    if (stopped || visibility.hidden) return
    if (running) {
      refreshAgain = true
      return
    }
    running = true
    try {
      await poll()
    } finally {
      running = false
      if (!stopped && !visibility.hidden && (interval > 0 || refreshAgain)) {
        timer = setTimeout(() => void run().catch(console.error), refreshAgain ? 0 : interval)
      }
      refreshAgain = false
    }
  }
  const changed = () => {
    clearTimeout(timer)
    if (!visibility.hidden) void run().catch(console.error)
  }
  visibility.addEventListener('visibilitychange', changed)
  void run().catch(console.error)
  return () => {
    stopped = true
    clearTimeout(timer)
    visibility.removeEventListener('visibilitychange', changed)
  }
}
