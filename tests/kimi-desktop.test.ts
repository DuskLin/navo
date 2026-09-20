import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KimiDesktopIntegration } from '../src/main/services/kimi-desktop-integration'
import { quotaDisplaySnapshot } from '../src/main/services/kimi-quota-export'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'navo-injection-'))
  const app = join(root, 'Kimi Code.app'),
    user = join(root, 'Navo')
  const dir = join(app, 'Contents/Resources/desktop-dist')
  await mkdir(join(dir, 'assets'), { recursive: true })
  await mkdir(user)
  const html = (v: string) =>
    `<html><script src="/assets/main-${v}.js"></script><link href="/assets/main-${v}.css"><body>${v}</body></html>`
  const update = async (version: string, compatible = true) => {
    await writeFile(
      join(app, 'Contents/Info.plist'),
      `<key>CFBundleShortVersionString</key><string>${version}</string>`
    )
    await writeFile(join(dir, 'index.html'), html(version))
    await writeFile(join(dir, `assets/main-${version}.js`), compatible ? 'ch-spacer' : 'new-layout')
    await writeFile(join(dir, `assets/main-${version}.css`), '.chat-header{} .ch-spacer{}')
  }
  await update('1.0.1')
  const manager = new KimiDesktopIntegration(user, '// widget', app, 'darwin')
  await manager.load()
  return {
    root,
    user,
    dir,
    manager,
    update,
    html,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

test('按版本备份，手动恢复更新，关闭不会恢复旧版入口', async () => {
  const f = await fixture()
  try {
    assert.equal(f.manager.getState().enabled, false)
    await f.manager.save({ enabled: true, autoReapply: false })
    assert.equal(f.manager.getState().patched, true)
    await f.update('1.0.2')
    await f.manager.monitor()
    await f.manager.monitor()
    assert.equal(await readFile(join(f.dir, 'index.html'), 'utf8'), f.html('1.0.2'))
    await f.manager.reapply()
    assert.equal((await readdir(join(f.user, 'kimi-desktop-backups'))).length, 2)
    await f.manager.save({ enabled: false, autoReapply: false })
    assert.equal(await readFile(join(f.dir, 'index.html'), 'utf8'), f.html('1.0.2'))
    assert.equal(
      JSON.parse(await readFile(join(f.dir, 'assets/navo-quota-data.json'), 'utf8')).enabled,
      false
    )
  } finally {
    await f.cleanup()
  }
})

test('自动恢复需两次稳定检测，不兼容版本不写入', async () => {
  const f = await fixture()
  try {
    await f.manager.save({ enabled: true, autoReapply: true })
    await f.update('1.0.2')
    await f.manager.monitor()
    assert.equal(f.manager.getState().patched, false)
    await f.manager.monitor()
    assert.equal(f.manager.getState().patched, true)
    await f.update('2.0.0', false)
    await f.manager.monitor()
    await f.manager.monitor()
    assert.equal(f.manager.getState().compatible, false)
    await assert.rejects(f.manager.reapply(), /不兼容/)
    assert.equal(await readFile(join(f.dir, 'index.html'), 'utf8'), f.html('2.0.0'))
  } finally {
    await f.cleanup()
  }
})

test('页面被其他补丁修改后，关闭只移除自己的标记', async () => {
  const f = await fixture()
  try {
    await f.manager.save({ enabled: true, autoReapply: false })
    const current = await readFile(join(f.dir, 'index.html'), 'utf8')
    await writeFile(join(f.dir, 'index.html'), current.replace('</html>', '<!-- other --></html>'))
    await f.manager.save({ enabled: false, autoReapply: false })
    assert.equal(
      await readFile(join(f.dir, 'index.html'), 'utf8'),
      f.html('1.0.1').replace('</html>', '<!-- other --></html>')
    )
  } finally {
    await f.cleanup()
  }
})

test('仅有额度或余额的账号进入展示快照，零额度保留且凭据不进入导出', () => {
  const accounts = ['kimi', 'opencode-go', 'deepseek'].map((provider) => ({
    id: provider,
    name: provider,
    provider: provider as 'kimi' | 'opencode-go' | 'deepseek',
    enabled: true,
    capabilities: {
      models: [],
      maxConcurrency: null,
      checkedAt: Date.now(),
      warning: '',
      quota: {
        fiveHour: { limit: 100, used: 100, remaining: 0, resetAt: null },
        weekly: null,
        total: null,
        totalUnlimited: false
      }
    },
    credential: { accessToken: 'PRIVATE_TOKEN' },
    secret: 'PRIVATE_SECRET'
  }))
  const data = quotaDisplaySnapshot([
    ...accounts,
    { ...accounts[0], id: 'no-data', capabilities: null },
    {
      ...accounts[0],
      id: 'empty-quota',
      capabilities: {
        ...accounts[0].capabilities,
        quota: {
          ...accounts[0].capabilities.quota,
          fiveHour: { limit: null, used: null, remaining: null, resetAt: null }
        }
      }
    },
    {
      ...accounts[0],
      id: 'balance-only',
      capabilities: {
        ...accounts[0].capabilities,
        quota: null,
        balance: { available: false, balances: [{ currency: 'USD', balance: 0 }] }
      }
    }
  ])
  assert.deepEqual(
    data.accounts.map((a) => a.id),
    ['kimi', 'opencode-go', 'deepseek', 'balance-only']
  )
  assert.ok(!JSON.stringify(data).includes('PRIVATE'))
})

test('独立模块选择持久化，关闭总开关保留选择，旧配置默认开启两个模块', async () => {
  const f = await fixture()
  try {
    await f.manager.save({ enabled: true, autoReapply: false })
    assert.equal(f.manager.getState().accountQuota, true)
    assert.equal(f.manager.getState().sessionStats, true)
    for (const [accountQuota, sessionStats] of [
      [true, false],
      [false, true],
      [false, false]
    ]) {
      const preferences = { enabled: true, autoReapply: true, accountQuota, sessionStats }
      await f.manager.save(preferences)
      await f.manager.load()
      assert.equal(f.manager.getState().accountQuota, accountQuota)
      assert.equal(f.manager.getState().sessionStats, sessionStats)
      await f.manager.save({ ...preferences, enabled: false })
      await f.manager.load()
      assert.equal(f.manager.getState().accountQuota, accountQuota)
      assert.equal(f.manager.getState().sessionStats, sessionStats)
      await f.manager.save(preferences)
      await f.update('1.0.2')
      await f.manager.monitor()
      await f.manager.monitor()
      assert.equal(f.manager.getState().patched, true)
      assert.equal(f.manager.getState().accountQuota, accountQuota)
      assert.equal(f.manager.getState().sessionStats, sessionStats)
    }
    await assert.rejects(
      f.manager.save({ enabled: true, autoReapply: false, accountQuota: 'false' }),
      /设置无效/
    )
  } finally {
    await f.cleanup()
  }
})
