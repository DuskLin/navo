import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { UpdateService } from '../src/main/services/updates'

class Engine extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checks = 0
  downloads = 0
  installs = 0
  hasUpdate = true
  failDownload = false
  releaseNotes: string | Array<{ version: string; note: string | null }> | null = '新增更新说明'
  async checkForUpdates() {
    this.checks++
    this.emit(this.hasUpdate ? 'update-available' : 'update-not-available', {
      version: '0.2.0',
      releaseNotes: this.releaseNotes
    })
  }
  async downloadUpdate() {
    this.downloads++
    if (this.failDownload) throw new Error('network failed')
    this.emit('download-progress', { percent: 53 })
    this.emit('update-downloaded', { version: '0.2.0' })
  }
  quitAndInstall() {
    this.installs++
  }
}
const options = { version: '0.1.0', enabled: true, canInstall: true, reason: '' }

test('updates download once, keep ready state and install only after preparation', async () => {
  const engine = new Engine()
  let prepared = false
  const service = new UpdateService(engine, options, async () => {
    prepared = true
  })
  assert.equal(engine.autoDownload, false)
  assert.equal(engine.autoInstallOnAppQuit, false)
  assert.equal(engine.allowPrerelease, false)
  assert.equal(engine.allowDowngrade, false)
  await assert.rejects(service.install(), /尚未下载/)
  const first = service.check()
  assert.equal(service.check(), first)
  await first
  await service.check()
  assert.equal(engine.checks, 1)
  assert.equal(engine.downloads, 1)
  assert.equal(engine.installs, 0)
  assert.equal(service.get().status, 'downloaded')
  assert.equal(service.get().releaseNotes, '新增更新说明')
  await service.install()
  assert.equal(prepared, true)
  assert.equal(engine.installs, 1)
  await assert.rejects(service.install())
})

test('download failure is visible and retry succeeds; cancelled install remains ready', async () => {
  const engine = new Engine()
  engine.failDownload = true
  const service = new UpdateService(engine, options, async () => {
    throw new Error('cancelled')
  })
  await service.check()
  assert.equal(service.get().status, 'error')
  assert.equal(service.get().releaseNotes, '新增更新说明')
  engine.failDownload = false
  await service.check()
  await assert.rejects(service.install(), /cancelled/)
  assert.equal(service.get().status, 'downloaded')
  assert.equal(engine.installs, 0)
})

test('release notes select the new version and clear on a fresh check or missing notes', async () => {
  const engine = new Engine()
  const service = new UpdateService(engine, { ...options, canInstall: false }, async () => {})
  engine.releaseNotes = [
    { version: '0.1.0', note: '旧版说明' },
    { version: '0.2.0', note: '<h2>新增功能</h2><ul><li>展示更新内容</li></ul>' }
  ]
  await service.check()
  assert.equal(service.get().releaseNotes, engine.releaseNotes[1].note)
  engine.hasUpdate = false
  const check = service.check()
  assert.equal(service.get().releaseNotes, '')
  await check
  assert.equal(service.get().version, null)
  assert.equal(service.get().releaseNotes, '')
  engine.hasUpdate = true
  engine.releaseNotes = null
  await service.check()
  assert.equal(service.get().status, 'available')
  assert.equal(service.get().releaseNotes, '')
})

test('development does not check; unsupported installs still report updates', async () => {
  const engine = new Engine()
  const disabled = new UpdateService(engine, { ...options, enabled: false }, async () => {})
  disabled.start()
  await disabled.check()
  disabled.dispose()
  assert.equal(engine.checks, 0)
  const fallback = new UpdateService(
    new Engine(),
    { ...options, canInstall: false },
    async () => {}
  )
  await fallback.check()
  assert.equal(fallback.get().status, 'available')
  await assert.rejects(fallback.install())
})

test('no update and asynchronous updater errors produce recoverable states', async () => {
  const engine = new Engine()
  engine.hasUpdate = false
  const service = new UpdateService(engine, options, async () => {})
  await service.check()
  assert.equal(service.get().status, 'up-to-date')
  assert.equal(engine.downloads, 0)
  engine.emit('error', new Error('updater failed'))
  assert.equal(service.get().status, 'error')
  await service.check()
  assert.equal(service.get().status, 'up-to-date')
})
