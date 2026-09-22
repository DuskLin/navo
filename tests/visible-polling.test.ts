import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startVisiblePolling } from '../src/renderer/src/visible-polling'

class Visibility extends EventTarget {
  hidden = false
  show(value: boolean) {
    this.hidden = !value
    this.dispatchEvent(new Event('visibilitychange'))
  }
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test('隐藏窗口不再轮询，恢复立即读取，退出清理定时器与监听器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const visibility = new Visibility()
  let calls = 0
  const stop = startVisiblePolling(
    async () => {
      calls++
    },
    1000,
    visibility
  )
  await flush()
  assert.equal(calls, 1)
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(calls, 2)
  visibility.show(false)
  t.mock.timers.tick(100000)
  await flush()
  assert.equal(calls, 2)
  visibility.show(true)
  await flush()
  assert.equal(calls, 3)
  stop()
  visibility.show(false)
  visibility.show(true)
  t.mock.timers.tick(100000)
  await flush()
  assert.equal(calls, 3)
})

test('慢请求跨越隐藏和显示时保持单个请求；停止后不会重新安排轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const visibility = new Visibility()
  let calls = 0
  let resolve!: () => void
  const stop = startVisiblePolling(
    () => {
      calls++
      return new Promise<void>((r) => {
        resolve = r
      })
    },
    1000,
    visibility
  )
  visibility.show(false)
  visibility.show(true)
  t.mock.timers.tick(10000)
  assert.equal(calls, 1)
  resolve()
  await flush()
  t.mock.timers.tick(0)
  assert.equal(calls, 2)
  stop()
  resolve()
  await flush()
  t.mock.timers.tick(10000)
  assert.equal(calls, 2)
})
