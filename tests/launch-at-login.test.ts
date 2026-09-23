import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaunchAtLogin, linuxAutostartEntry } from '../src/main/services/launch-at-login'

type AppAdapter = ConstructorParameters<typeof LaunchAtLogin>[0]

test('Linux autostart writes and removes a user login entry', async () => {
  const config = await mkdtemp(join(tmpdir(), 'navo-autostart-'))
  const executable = join(config, 'Navo AppImage.AppImage')
  const app = { isPackaged: true } as AppAdapter
  const service = new LaunchAtLogin(app, 'linux', {
    XDG_CONFIG_HOME: config,
    APPIMAGE: executable
  })
  const file = join(config, 'autostart', 'dev.navo.app.desktop')
  try {
    assert.deepEqual(await service.get(), {
      supported: true,
      enabled: false,
      requiresApproval: false
    })
    assert.equal((await service.set(true)).enabled, true)
    const content = await readFile(file, 'utf8')
    assert.equal(content, linuxAutostartEntry(executable))
    assert.match(content, /^Exec=".*Navo AppImage\.AppImage"$/m)
    await writeFile(file, `${linuxAutostartEntry(executable)}Hidden=true\n`)
    assert.equal((await service.get()).enabled, false)
    assert.equal((await service.set(false)).enabled, false)
    await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })
    await assert.rejects(service.set('yes' as unknown as boolean), /设置无效/)
  } finally {
    await rm(config, { recursive: true, force: true })
  }
})

test('Linux desktop entry escapes reserved characters in executable paths', () => {
  const entry = linuxAutostartEntry('/tmp/Navo $\\%.AppImage')
  assert.ok(entry.includes(String.raw`\\$`))
  assert.ok(entry.includes(String.raw`\\\\`))
  assert.ok(entry.includes('%%.AppImage'))
  assert.throws(() => linuxAutostartEntry('/tmp/Navo=1.AppImage'), /路径包含无效字符/)
})

test('native login item status reflects system approval', async () => {
  let status = 'requires-approval'
  const calls: boolean[] = []
  const app = {
    isPackaged: true,
    getLoginItemSettings: () => ({ openAtLogin: true, status }),
    setLoginItemSettings: ({ openAtLogin }: { openAtLogin: boolean }) => {
      calls.push(openAtLogin)
      status = openAtLogin ? 'enabled' : 'not-registered'
    }
  } as AppAdapter
  const service = new LaunchAtLogin(app, 'darwin', {})
  assert.deepEqual(await service.get(), {
    supported: true,
    enabled: true,
    requiresApproval: true
  })
  assert.deepEqual(await service.set(false), {
    supported: true,
    enabled: false,
    requiresApproval: false
  })
  assert.deepEqual(calls, [false])
})

test('Windows reports a login item disabled in system settings', async () => {
  let approved = false
  const app = {
    isPackaged: true,
    getLoginItemSettings: () => ({
      openAtLogin: true,
      executableWillLaunchAtLogin: approved
    }),
    setLoginItemSettings: ({ openAtLogin }: { openAtLogin: boolean }) => {
      approved = openAtLogin
    }
  } as AppAdapter
  const service = new LaunchAtLogin(app, 'win32', {})
  assert.equal((await service.get()).enabled, false)
  assert.equal((await service.set(true)).enabled, true)
})

test('development and test runs cannot modify login items', async () => {
  const app = {
    isPackaged: true,
    setLoginItemSettings: () => assert.fail('system setting changed')
  } as unknown as AppAdapter
  const service = new LaunchAtLogin(app, 'win32', { NAVO_TEST_USER_DATA: '/tmp/navo-test' })
  assert.equal((await service.get()).supported, false)
  await assert.rejects(service.set(true), /仅在安装版中可用/)
})
