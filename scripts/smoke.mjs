import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'

const userData = await mkdtemp(join(tmpdir(), 'navo-smoke-'))
const kimiHome = join(userData, 'kimi')
await mkdir(join(kimiHome, 'credentials'), { recursive: true })
await writeFile(join(kimiHome, 'device_id'), 'smoke-kimi-device')
await writeFile(
  join(kimiHome, 'credentials/kimi-code.json'),
  JSON.stringify({
    access_token: 'smoke-kimi-oauth',
    refresh_token: 'smoke-kimi-refresh',
    expires_at: Date.now() / 1000 + 3600
  })
)
const codexHome = join(userData, 'codex')
await mkdir(codexHome)
const codexToken =
  'smoke.' +
  Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'smoke-user' })
  ).toString('base64url') +
  '.signature'
await writeFile(
  join(codexHome, 'auth.json'),
  JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: codexToken,
      refresh_token: 'smoke-codex-refresh',
      account_id: 'smoke-codex-account'
    }
  })
)
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const errors = []
let application
const forwarded = []
let fiveHourRemaining = 40
let weeklyRemaining = 80
let pricingUnavailable = false
let pricingRequests = 0
const fiveHourReset = new Date(Date.now() + 4 * 3600000).toISOString()
const weeklyReset = new Date(Date.now() + 6 * 86400000).toISOString()
const upstream = createServer((req, res) => {
  if (req.url === '/backend-api/wham/usage') {
    assert.equal(req.headers.authorization, 'Bearer ' + codexToken)
    assert.equal(req.headers['chatgpt-account-id'], 'smoke-codex-account')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18000,
            used_percent: 25,
            reset_at: Math.floor(Date.parse(fiveHourReset) / 1000)
          },
          secondary_window: {
            limit_window_seconds: 604800,
            used_percent: 40,
            reset_at: Math.floor(Date.parse(weeklyReset) / 1000)
          }
        }
      })
    )
    return
  }
  if (req.url.startsWith('/backend-api/codex/models?')) {
    assert.equal(req.headers.authorization, 'Bearer ' + codexToken)
    assert.equal(req.headers['chatgpt-account-id'], 'smoke-codex-account')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: [{ slug: 'gpt-codex-smoke' }] }))
    return
  }
  if (req.url === '/api.json') {
    pricingRequests++
    assert.equal(req.headers.authorization, undefined)
    res.writeHead(pricingUnavailable ? 503 : 200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        'kimi-for-coding': {
          models: {
            'kimi-for-coding': {
              name: 'Kimi For Coding',
              limit: { context: 1048576, output: 32768 },
              cost: { input: 1, output: 3, cache_read: 0.2 }
            },
            k3: { cost: { input: 2, output: 6, cache_read: 0.4, tiers: [{ input: 4 }] } }
          }
        }
      })
    )
    return
  }
  if (req.url === '/zen/go/v1/models' || req.url === '/zen/go/v1/usage') {
    assert.equal(req.headers.authorization, 'Bearer smoke-opencode-key')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        req.url.endsWith('/models')
          ? { data: [{ id: 'glm-test' }, { id: 'minimax-test' }, { id: 'gpt-test' }] }
          : {
              usage: {
                rolling: { percent: 10, resetsAt: fiveHourReset },
                weekly: { percent: 20 },
                monthly: { percent: 30 }
              }
            }
      )
    )
    return
  }
  if (req.headers.authorization === 'Bearer smoke-minimax-key') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        req.url === '/v1/models'
          ? { data: [{ id: 'MiniMax-M3' }] }
          : {
              base_resp: { status_code: 0 },
              model_remains: [
                {
                  model_name: 'general',
                  current_interval_remaining_percent: 72,
                  end_time: fiveHourReset,
                  current_weekly_status: 1,
                  current_weekly_remaining_percent: 64,
                  weekly_end_time: weeklyReset
                }
              ]
            }
      )
    )
    return
  }
  if (req.url === '/v1/models' || req.url === '/user/balance') {
    assert.equal(req.headers.authorization, 'Bearer smoke-deepseek-key')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        req.url === '/v1/models'
          ? { data: [{ id: 'deepseek-test-model' }] }
          : {
              is_available: true,
              balance_infos: [
                { currency: 'CNY', total_balance: '12.50' },
                { currency: 'USD', total_balance: '2.75' }
              ]
            }
      )
    )
    return
  }
  if (req.url === '/coding/v1/me') {
    assert.equal(req.headers.authorization, 'Bearer smoke-kimi-oauth')
    assert.equal(req.headers['x-msh-device-id'], 'smoke-kimi-device')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ user_id: 'smoke-kimi-user' }))
    return
  }
  if (req.url === '/coding/v1/usages') {
    assert.doesNotMatch(req.headers['user-agent'] ?? '', /kimi-code-cli|KimiCLI/i)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        parallel: { limit: '30' },
        usage: {
          limit: '100',
          used: String(100 - weeklyRemaining),
          remaining: String(weeklyRemaining),
          resetTime: weeklyReset
        },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: {
              limit: '50',
              used: String(50 - fiveHourRemaining),
              remaining: String(fiveHourRemaining),
              resetTime: fiveHourReset
            }
          }
        ]
      })
    )
    return
  }
  if (req.url === '/coding/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'kimi-for-coding' }, { id: 'k3' }] }))
    return
  }
  forwarded.push(req.headers.authorization)
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-request-id': '6adf4190-2959-4444-878c-454c7a6673ad'
  })
  res.end(
    JSON.stringify({
      id: 'smoke-completion',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 800 }
      },
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    })
  )
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port
// 仅测试入口注入传输层，生产代码始终使用固定官方地址。
const sleepStateFile = join(userData, 'mock-sleep-state')
const mockPmset = join(userData, 'mock-pmset')
await writeFile(sleepStateFile, '0')
await writeFile(
  mockPmset,
  `#!/bin/sh
state=${JSON.stringify(sleepStateFile)}
if [ "$1" = -g ]; then
  /usr/bin/printf 'SleepDisabled %s\\n' "$(/bin/cat "$state")"
else
  [ "$1 $2" = '-a disablesleep' ] || exit 2
  /usr/bin/printf '%s' "$3" > "$state"
fi
`,
  { mode: 0o700 }
)
const testEntry = join(userData, 'smoke-main.cjs')
await writeFile(
  testEntry,
  `
  // Run the real watchdog against a fake pmset, without administrator prompts or host changes.
  const childProcess = require('node:child_process');
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = (file, args, options, callback) => {
    if (file === '/usr/bin/osascript' && args[1]?.startsWith('do shell script ')) {
      const end = args[1].lastIndexOf(' with administrator privileges');
      const command = JSON.parse(args[1].slice('do shell script '.length, end));
      return originalExecFile('/bin/sh', ['-c', command.replaceAll('/usr/bin/pmset', ${JSON.stringify(mockPmset)})], options, callback);
    }
    return originalExecFile(file, args, options, callback);
  };
  const custom = require('node:util').promisify.custom;
  childProcess.execFile[custom] = originalExecFile[custom];
  const { Tray } = require('electron');
  const setContextMenu = Tray.prototype.setContextMenu;
  Tray.prototype.setContextMenu = function (menu) {
    globalThis.smokeTray = this;
    globalThis.smokeTrayMenu = menu;
    return setContextMenu.call(this, menu);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (['api.kimi.com', 'api.kimi.ai', 'api.deepseek.com', 'api.minimaxi.com', 'api.minimax.io', 'opencode.ai', 'models.dev', 'chatgpt.com'].includes(url.hostname)) {
      return realFetch('http://127.0.0.1:${upstreamPort}' + url.pathname + url.search, init);
    }
    return realFetch(input, init);
  };
  require('electron').net.fetch = globalThis.fetch;
  require(${JSON.stringify(resolve('out/main/index.js'))});
`
)
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const gatewayPort = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))

async function launch() {
  const env = {
    ...process.env,
    NAVO_TEST_USER_DATA: userData,
    CODEX_HOME: codexHome,
    KIMI_SHARE_DIR: kimiHome
  }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [testEntry], env })
  const page = await application.firstWindow()
  // The DOM can be ready before the initially hidden native window is shown.
  await application.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window.isVisible()) resolve()
        else window.once('show', resolve)
      })
  )
  page.on('pageerror', (error) => errors.push(error.message))
  await page
    .locator('.app-status')
    .filter({ hasText: /网关运行中|网关已停止/ })
    .waitFor()
  await page.getByRole('button', { name: '设置', exact: true, includeHidden: true }).waitFor()
  return page
}

try {
  let page = await launch()
  const welcome = page.getByRole('dialog', { name: '欢迎使用 Navo' })
  await welcome.waitFor()
  await page.screenshot({ path: join(artifacts, 'star-welcome.png') })
  await welcome.getByRole('button', { name: '先体验一下' }).click()
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).waitFor()
  assert.equal(await welcome.count(), 0)
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration
    }
  })
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  await page.screenshot({ path: join(artifacts, 'empty.png') })

  // The real preload exposes update state; developer builds never contact GitHub.
  const initialUpdate = await page.evaluate(() => window.navo.getUpdateState())
  assert.equal(initialUpdate.status, 'disabled')
  await page.getByRole('button', { name: '应用更新', exact: true }).click()
  const updateDialog = page.getByRole('dialog', { name: '应用更新' })
  await updateDialog.getByText('开发模式', { exact: true }).waitFor()
  assert.equal(await updateDialog.getByRole('region', { name: '更新内容' }).count(), 0)
  assert.equal(
    await updateDialog.getByRole('button', { name: '检查更新', exact: true }).isDisabled(),
    true
  )
  await updateDialog.getByRole('button', { name: '关闭对话框' }).click()
  await application.evaluate(({ ipcMain }, state) => {
    ipcMain.removeHandler('update:get')
    ipcMain.handle('update:get', () => ({
      ...state,
      canInstall: true,
      reason: '',
      version: '0.2.0',
      releaseNotes:
        '<h2>新增功能</h2><ul><li>弹窗展示更新内容</li></ul><p>修复 &amp; 改进</p><script>window.__releaseScriptExecuted = true</script>',
      status: 'downloaded',
      progress: 100
    }))
  }, initialUpdate)
  await page.getByLabel('新版本更新提示').waitFor()
  await page.getByRole('button', { name: '查看更新' }).click()
  await updateDialog.getByRole('button', { name: '重启并安装' }).waitFor()
  const releaseNotes = updateDialog.getByRole('region', { name: '更新内容' })
  assert.match(await releaseNotes.innerText(), /新增功能\n.*弹窗展示更新内容/)
  assert.match(await releaseNotes.innerText(), /修复 & 改进/)
  assert.equal(await releaseNotes.locator('script, img, iframe').count(), 0)
  assert.equal(await page.evaluate(() => window.__releaseScriptExecuted), undefined)
  await page.screenshot({ path: join(artifacts, 'update-ready.png') })
  await updateDialog.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '收起更新提示' }).click()
  await application.evaluate(({ ipcMain }, state) => {
    ipcMain.removeHandler('update:get')
    ipcMain.handle('update:get', () => state)
  }, initialUpdate)

  // 模拟旧主进程没有新接口：显示可执行的提示，并在接口恢复后清除错误。
  const initialGateway = await page.evaluate(() => window.navo.getGateway())
  await application.evaluate(({ ipcMain }) => ipcMain.removeHandler('gateway:get'))
  await page.reload()
  await page.getByRole('heading', { name: '网关服务尚未就绪', exact: true }).waitFor()
  await page.getByText(/仅刷新窗口无法更新后台/).waitFor()
  await application.evaluate(({ ipcMain }, snapshot) => {
    ipcMain.handle('gateway:get', () => snapshot)
  }, initialGateway)
  await page.getByRole('button', { name: '设置', exact: true }).waitFor()
  assert.equal(await page.getByRole('alert').count(), 0)
  await application.close()
  application = undefined
  page = await launch()

  assert.equal(await page.getByRole('tablist', { name: '网关管理' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '卡片管理', exact: true }).count(), 0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('heading', { name: '卡片管理', exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByLabel('模型表现', { exact: true }).uncheck()
  await page.getByRole('button', { name: '网关设置', exact: true }).click()
  assert.equal(
    await page
      .locator('section[aria-label="网关设置"] fieldset')
      .evaluate((element) => getComputedStyle(element).borderTopWidth),
    '0px'
  )
  await page.screenshot({ path: join(artifacts, 'settings-gateway.png') })
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.screenshot({ path: join(artifacts, 'settings-gateway-dark.png') })
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  const originalTimeout = await page.getByLabel('请求总超时（秒）', { exact: true }).inputValue()
  await page.getByLabel('请求总超时（秒）', { exact: true }).fill('123')
  await page.getByRole('button', { name: '远程仪表盘', exact: true }).click()
  await page.getByLabel('HTTPS 端口', { exact: true }).waitFor()
  const originalDashboardPort = await page.getByLabel('HTTPS 端口', { exact: true }).inputValue()
  await page.getByLabel('HTTPS 端口', { exact: true }).fill('18444')
  await page.screenshot({ path: join(artifacts, 'settings-dashboard.png') })
  await page.getByRole('button', { name: '网关设置', exact: true }).click()
  assert.equal(await page.getByLabel('请求总超时（秒）', { exact: true }).inputValue(), '123')
  await page.getByRole('button', { name: '重置修改', exact: true }).click()
  assert.equal(
    await page.getByLabel('请求总超时（秒）', { exact: true }).inputValue(),
    originalTimeout
  )
  await page.getByRole('button', { name: '远程仪表盘', exact: true }).click()
  assert.equal(await page.getByLabel('HTTPS 端口', { exact: true }).inputValue(), '18444')
  await page.getByRole('button', { name: '重置修改', exact: true }).click()
  assert.equal(
    await page.getByLabel('HTTPS 端口', { exact: true }).inputValue(),
    originalDashboardPort
  )
  await page.getByRole('button', { name: '返回概览', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '卡片管理', exact: true }).click()
  assert.equal(await page.getByLabel('模型表现', { exact: true }).isChecked(), false)
  await page.getByLabel('模型表现', { exact: true }).check()
  await page.screenshot({ path: join(artifacts, 'settings-display.png') })
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.getByRole('tablist', { name: '网关管理' }).waitFor()
  await page.getByRole('button', { name: '返回概览', exact: true }).click()
  assert.equal(await page.getByRole('tablist', { name: '网关管理' }).count(), 0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: '分组管理' }).count(), 0)
  assert.equal(
    await page.getByRole('button', { name: '导入本地 Codex 认证', exact: true }).count(),
    0
  )
  await page.getByRole('button', { name: '实验性功能', exact: true }).click()
  const sleepToggle = page.getByRole('switch', {
    name: process.platform === 'darwin' ? '禁用系统睡眠（含合盖）' : '阻止自动休眠',
    exact: true
  })
  await sleepToggle.waitFor()
  assert.equal(await sleepToggle.isChecked(), false)
  assert.equal(await page.getByLabel('释放延迟', { exact: true }).isDisabled(), true)
  await sleepToggle.click()
  await page.waitForFunction(
    async () => (await window.navo.getSettings()).preventSleepDuringRequests
  )
  await page.getByLabel('释放延迟', { exact: true }).selectOption('900')
  const acOnlyToggle = page.getByRole('switch', { name: '仅连接电源适配器时启用', exact: true })
  assert.equal(await acOnlyToggle.isChecked(), false)
  await acOnlyToggle.click()
  await page.waitForFunction(async () => (await window.navo.getSettings()).sleepOnlyOnAC)
  await acOnlyToggle.click()
  await page.waitForFunction(async () => !(await window.navo.getSettings()).sleepOnlyOnAC)
  await page.waitForFunction(
    async () => (await window.navo.getSettings()).sleepReleaseDelaySeconds === 900
  )
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  assert.equal(
    (await page.evaluate(() => window.navo.getSettings())).preventSleepDuringRequests,
    true
  )
  await page.screenshot({ path: join(artifacts, 'request-sleep-settings.png') })
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.getByLabel('释放延迟', { exact: true }).selectOption('60')
  await page.waitForFunction(
    async () => (await window.navo.getSettings()).sleepReleaseDelaySeconds === 60
  )
  await sleepToggle.click()
  await page.waitForFunction(
    async () => !(await window.navo.getSettings()).preventSleepDuringRequests
  )
  // 使用临时登录文件和模拟上游，验证完整主进程/预加载/界面导入链路。
  await page.getByRole('button', { name: '导入本地 Codex 认证', exact: true }).click()
  const codexRisk = page.getByRole('dialog', { name: '导入 Codex 认证风险提醒' })
  await codexRisk.waitFor()
  assert.equal((await page.evaluate(() => window.navo.getGateway())).accounts.length, 0)
  await page.screenshot({ path: join(artifacts, 'codex-import-risk.png') })
  await codexRisk.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await page.evaluate(() => window.navo.getGateway())).accounts.length, 0)
  await page.getByRole('button', { name: '导入本地 Codex 认证', exact: true }).click()
  await page
    .getByRole('dialog', { name: '导入 Codex 认证风险提醒' })
    .getByRole('button', { name: '我已了解，继续导入' })
    .click()
  await page.getByRole('dialog', { name: '导入 Codex 认证风险提醒' }).waitFor({ state: 'hidden' })
  await page.waitForFunction(async () => (await window.navo.getGateway()).accounts.length === 1)
  const codexSnapshot = await page.evaluate(() => window.navo.getGateway())
  const importedCodex = codexSnapshot.accounts[0]
  assert.equal(importedCodex.provider, 'codex')
  assert.equal(importedCodex.kind, 'oauth')
  assert.equal(importedCodex.capabilities.quota.fiveHour.remaining, 75)
  assert.equal(importedCodex.capabilities.quota.weekly.remaining, 60)
  assert.ok(!JSON.stringify(codexSnapshot).includes(codexToken))
  assert.ok(!JSON.stringify(codexSnapshot).includes('smoke-codex-refresh'))
  await page.getByRole('button', { name: '导入本地 Codex 认证', exact: true }).click()
  await page
    .getByRole('dialog', { name: '导入 Codex 认证风险提醒' })
    .getByRole('button', { name: '我已了解，继续导入' })
    .click()
  await page.getByRole('dialog', { name: '导入 Codex 认证风险提醒' }).waitFor({ state: 'hidden' })
  await page.waitForFunction(async () => (await window.navo.getGateway()).accounts.length === 1)
  await page.screenshot({ path: join(artifacts, 'codex-experimental.png') })
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  const codexRow = page.getByRole('row').filter({ hasText: importedCodex.name })
  await codexRow.getByRole('button', { name: '编辑', exact: true }).click()
  const codexDialog = page.getByRole('dialog', { name: '编辑账号' })
  assert.equal(await codexDialog.getByLabel('API Key', { exact: true }).count(), 0)
  assert.equal(await codexDialog.getByLabel('供应商', { exact: true }).isDisabled(), true)
  await codexDialog.getByLabel('手动添加模型', { exact: true }).fill('gpt-6-astra')
  await codexDialog.getByRole('button', { name: '添加模型', exact: true }).click()
  const manualRow = codexDialog.getByRole('row').filter({ hasText: 'gpt-6-astra' })
  await manualRow.getByText('手动', { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'codex-import.png') })
  await codexDialog.getByRole('button', { name: '保存账号', exact: true }).click()
  await codexDialog.waitFor({ state: 'hidden' })
  const refreshedCodex = await page.evaluate(
    (id) => window.navo.refreshAccount(id),
    importedCodex.id
  )
  assert.ok(
    refreshedCodex.accounts.find((a) => a.id === importedCodex.id).models.includes('gpt-6-astra')
  )
  await page.evaluate((id) => window.navo.deleteAccount(id), importedCodex.id)
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  await page
    .getByRole('dialog', { name: '添加账号' })
    .getByLabel('供应商', { exact: true })
    .selectOption('kimi-local')
  const kimiImportDialog = page.getByRole('dialog', { name: '导入本地 Kimi 登录态' })
  assert.equal(
    await kimiImportDialog.getByLabel('登录账号区域', { exact: true }).inputValue(),
    'mainland-cn'
  )
  await kimiImportDialog.getByRole('button', { name: '导入登录态', exact: true }).click()
  await kimiImportDialog.waitFor({ state: 'hidden' })
  const kimiSnapshot = await page.evaluate(() => window.navo.getGateway())
  const importedKimi = kimiSnapshot.accounts[0]
  assert.equal(importedKimi.kind, 'oauth')
  assert.equal(importedKimi.provider, 'kimi')
  assert.ok(!JSON.stringify(kimiSnapshot).includes('smoke-kimi-oauth'))
  const repeatedKimi = await page.evaluate(() => window.navo.importKimiAccount('mainland-cn'))
  assert.equal(repeatedKimi.accounts.length, 1)
  assert.equal(repeatedKimi.accounts[0].id, importedKimi.id)
  await page
    .getByRole('row')
    .filter({ hasText: importedKimi.name })
    .getByRole('button', { name: '编辑', exact: true })
    .click()
  const kimiEditor = page.getByRole('dialog', { name: '编辑账号' })
  assert.equal(await kimiEditor.getByLabel('API Key', { exact: true }).count(), 0)
  assert.equal(await kimiEditor.getByLabel('账号区域', { exact: true }).isDisabled(), true)
  const kimiUAGate = kimiEditor.getByRole('switch', { name: '允许非 Kimi UA 调度', exact: true })
  assert.equal(await kimiUAGate.isChecked(), false)
  await kimiUAGate.click()
  const kimiWarning = page.getByRole('dialog', { name: '允许非 Kimi UA 调度？', exact: true })
  await kimiWarning.waitFor()
  await kimiWarning.getByRole('button', { name: '保持关闭', exact: true }).click()
  assert.equal(await kimiUAGate.isChecked(), false)
  await kimiUAGate.click()
  await kimiWarning.getByRole('button', { name: '我已了解风险，允许调度', exact: true }).click()
  assert.equal(await kimiUAGate.isChecked(), true)
  await page.screenshot({ path: join(artifacts, 'kimi-local-import.png') })
  await kimiEditor.getByRole('button', { name: '保存账号', exact: true }).click()
  await kimiEditor.waitFor({ state: 'hidden' })
  const savedKimiPolicy = await page.evaluate(() => window.navo.getGateway())
  assert.equal(savedKimiPolicy.accounts.find((a) => a.id === importedKimi.id).kimiOAuthOnly, false)
  await page.evaluate((id) => window.navo.deleteAccount(id), importedKimi.id)
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  for (const name of ['开发账号 A', '开发账号 B']) {
    await page.getByRole('button', { name: '添加账号', exact: true }).click()
    assert.equal(
      await page
        .getByRole('dialog')
        .getByText(/OAuth|Refresh Token|浏览器授权/)
        .count(),
      0
    )
    assert.equal(await page.getByLabel('接入方式', { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => typeof window.navo.startLogin), 'undefined')
    await page.getByLabel('账号名称', { exact: true }).fill(name)
    await page.getByLabel(/^API Key/).fill(name.endsWith('A') ? 'smoke-secret-a' : 'smoke-secret-b')
    assert.equal(
      await page.getByLabel('上游 Base URL', { exact: true }).inputValue(),
      'https://api.kimi.com/coding/v1'
    )
    assert.equal(
      await page.getByLabel('上游 Base URL', { exact: true }).getAttribute('readonly'),
      ''
    )
    await page.getByLabel('API Key', { exact: true }).press('Tab')
    await page
      .getByRole('table', { name: '可用模型' })
      .getByText('kimi-for-coding', { exact: true })
      .waitFor()
    assert.equal(await page.getByLabel('账号并发上限', { exact: true }).inputValue(), '30')
    if (name === '开发账号 A') {
      await page
        .getByLabel('kimi-for-coding 测试协议', { exact: true })
        .selectOption('chat-completions')
      await page.getByRole('button', { name: '测试模型 kimi-for-coding', exact: true }).click()
      await page.locator('.model-test-result summary').filter({ hasText: '成功' }).waitFor()
      await page.locator('.model-test-result summary').click()
      await page.locator('.model-test-result p').getByText('ok', { exact: true }).waitFor()
      assert.equal(forwarded.pop(), 'Bearer smoke-secret-a')
      const testRecords = await page.evaluate(() => window.navo.getRequestHistory())
      assert.equal(testRecords.records[0].group, '模型测试')
      assert.equal(testRecords.records[0].usage.output, 100)
      assert.equal(testRecords.records[0].usage.cacheRead, 800)

      await page.screenshot({ path: join(artifacts, 'account-model-test.png') })
      await page.getByLabel('账号并发上限', { exact: true }).fill('5')
      const scrollBody = page.locator('.modal-scroll-body')
      assert.equal(await scrollBody.evaluate((el) => getComputedStyle(el).scrollbarWidth), 'none')
      assert.equal(await scrollBody.evaluate((el) => el.offsetWidth - el.clientWidth), 0)
      await scrollBody.focus()
      await scrollBody.press('End')
      // 等待 End 键的原生滚动动画结束，再读取滑块位置进行拖动。
      await page.waitForFunction(() => {
        const el = document.querySelector('.modal-scroll-body')
        return el.scrollTop > 0 && el.scrollHeight - el.clientHeight - el.scrollTop < 1
      })
      await page.waitForFunction(() =>
        document.querySelector('.modal-scroll-track').classList.contains('is-visible')
      )
      // 滑块可拖拽，滚动停止后自动隐藏；表单状态保持。
      const thumb = await page.locator('.modal-scroll-thumb').boundingBox()
      const track = await page.locator('.modal-scroll-track').boundingBox()
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
      await page.mouse.down()
      await page.mouse.move(track.x + track.width / 2, track.y + 2, { steps: 5 })
      await page.mouse.up()
      await page.mouse.move(100, 100)
      await page.waitForFunction(() => document.querySelector('.modal-scroll-body').scrollTop < 10)
      await page.waitForFunction(
        () => !document.querySelector('.modal-scroll-track').classList.contains('is-visible')
      )
      assert.equal(await page.getByLabel('账号名称', { exact: true }).inputValue(), name)
      assert.equal(await page.getByLabel('账号并发上限', { exact: true }).inputValue(), '5')
    }
    assert.equal(
      await page.getByLabel('kimi-for-coding Messages', { exact: true }).isChecked(),
      true
    )
    await page.getByRole('button', { name: '删除模型 k3', exact: true }).click()
    assert.equal(await page.getByLabel('k3 Messages', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '获取上游信息', exact: true }).click()
    await page.getByRole('button', { name: '获取上游信息', exact: true }).waitFor()
    assert.equal(await page.getByLabel('k3 Messages', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '恢复已删除模型（1）', exact: true }).click()
    assert.equal(await page.getByLabel('k3 Messages', { exact: true }).count(), 1)
    await page.getByText('剩余 80 / 100', { exact: true }).waitFor()
    await page.getByText('剩余 40 / 50', { exact: true }).waitFor()
    await page.getByRole('button', { name: '保存账号', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByText(name, { exact: true }).waitFor()
  }
  await page.getByRole('tab', { name: '费用管理', exact: true }).click()
  const pricesTable = page.getByRole('table', { name: '模型单价', exact: true })
  assert.equal(await pricesTable.locator('tbody tr').count(), 2)
  await page.waitForFunction(
    async () => (await window.navo.getGateway()).modelPriceCatalog.updatedAt !== null
  )
  await pricesTable.getByRole('cell', { name: '1 USD · API 默认', exact: true }).waitFor()
  assert.equal(pricingRequests, 1)
  await page
    .getByRole('button', { name: '编辑 Kimi Code kimi-for-coding 单价', exact: true })
    .click()
  await page.getByLabel('输入单价（USD / 百万 token）', { exact: true }).fill('0')
  await page.getByRole('button', { name: '保存单价', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await pricesTable.getByRole('cell', { name: '0 USD · 手动', exact: true }).waitFor()
  await page
    .getByRole('button', { name: '编辑 Kimi Code kimi-for-coding 单价', exact: true })
    .click()
  await page.getByRole('button', { name: '恢复 API 默认值', exact: true }).click()
  await page.getByRole('button', { name: '保存单价', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await pricesTable.getByRole('cell', { name: '1 USD · API 默认', exact: true }).waitFor()
  await page
    .getByRole('button', { name: '编辑 Kimi Code kimi-for-coding 单价', exact: true })
    .click()
  await page.getByLabel('币种', { exact: true }).selectOption('CNY')
  await page.getByLabel('输入单价（CNY / 百万 token）', { exact: true }).fill('1.25')
  await page.getByLabel('输出单价（CNY / 百万 token）', { exact: true }).fill('8')
  await page.getByLabel('缓存读取（CNY / 百万 token）', { exact: true }).fill('0')
  await page.getByRole('button', { name: '保存单价', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  const priceRow = pricesTable.getByRole('row').filter({ hasText: 'kimi-for-coding' })
  await priceRow.getByRole('cell', { name: '1.25 CNY · 手动', exact: true }).waitFor()
  await priceRow.getByRole('cell', { name: '0 CNY · 默认 0', exact: true }).waitFor()
  pricingUnavailable = true
  await page.getByRole('button', { name: '刷新默认价格', exact: true }).click()
  await page.getByText('默认价格更新失败，继续使用上次缓存，可稍后重试', { exact: true }).waitFor()
  await priceRow.getByRole('cell', { name: '1.25 CNY · 手动', exact: true }).waitFor()
  await pricesTable.getByRole('cell', { name: '2 USD · API 默认', exact: true }).waitFor()
  pricingUnavailable = false
  await page.getByRole('button', { name: '刷新默认价格', exact: true }).click()
  await page
    .getByText('默认价格更新失败，继续使用上次缓存，可稍后重试', { exact: true })
    .waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(artifacts, 'model-pricing.png') })
  await page.getByLabel('搜索模型或供应商', { exact: true }).fill('not-supported')
  await page.getByText('没有匹配的模型', { exact: true }).waitFor()
  await page.getByLabel('搜索模型或供应商', { exact: true }).fill('')
  await page
    .getByRole('button', { name: '编辑 Kimi Code kimi-for-coding 单价', exact: true })
    .click()
  await page.getByLabel('输入单价（CNY / 百万 token）', { exact: true }).fill('99')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await priceRow.getByRole('cell', { name: '1.25 CNY · 手动', exact: true }).waitFor()
  await page.getByRole('button', { name: '编辑 Kimi Code k3 单价', exact: true }).click()
  await page.getByRole('button', { name: '搜索并匹配模型', exact: true }).click()
  await page.getByLabel('搜索 Models.dev 模型', { exact: true }).fill('kimi_for_coding')
  await page
    .getByRole('button', { name: '应用 kimi-for-coding / kimi-for-coding 价格', exact: true })
    .click()
  await page.getByText('已匹配：kimi-for-coding / kimi-for-coding', { exact: true }).waitFor()
  await page.getByRole('button', { name: '保存单价', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.navo.getGateway())).modelPrices.find((p) => p.model === 'k3')
      .catalogMatch.model,
    'kimi-for-coding'
  )
  await page.getByRole('button', { name: '编辑 Kimi Code k3 单价', exact: true }).click()
  await page.getByRole('button', { name: '搜索并匹配模型', exact: true }).click()
  await page.getByLabel('搜索 Models.dev 模型', { exact: true }).fill('missing-model')
  await page
    .getByText('没有找到相关模型，可更换关键词，或在下方直接输入价格。', { exact: true })
    .waitFor()
  await page.getByLabel('输入单价（USD / 百万 token）', { exact: true }).fill('99')
  await page.screenshot({ path: join(artifacts, 'price-model-matching.png') })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(
    (await page.evaluate(() => window.navo.getGateway())).modelPrices.find((p) => p.model === 'k3')
      .input,
    null
  )
  await page.getByRole('tab', { name: /账号池/ }).click()
  const accountSnapshot = await page.evaluate(() => window.navo.getGateway())
  assert.equal(accountSnapshot.accounts.length, 2)
  assert.equal(accountSnapshot.accounts.find((a) => a.name === '开发账号 A').maxConcurrency, 5)
  assert.ok(!JSON.stringify(accountSnapshot).includes('smoke-secret'))
  const encrypted = await readFile(join(userData, 'gateway.json'), 'utf8')
  assert.ok(!encrypted.includes('smoke-secret'))
  assert.ok(!encrypted.includes('开发账号'))
  assert.equal(typeof JSON.parse(encrypted).encrypted, 'string')

  await page.getByRole('button', { name: '网关设置', exact: true }).click()
  await page.getByLabel(/^监听端口/).fill(String(gatewayPort))
  await page.getByLabel('打开应用时自动启动网关', { exact: true }).check()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByText('网关设置已保存', { exact: true }).waitFor()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.getByRole('button', { name: '返回概览', exact: true }).click()
  await page.getByRole('button', { name: '启动网关', exact: true }).click()
  await page.getByRole('button', { name: '停止网关', exact: true }).waitFor()
  // Verify the real Electron assertion is acquired by gateway traffic and released after idle.
  await application.evaluate(({ powerSaveBlocker }) => {
    const original = powerSaveBlocker.start.bind(powerSaveBlocker)
    globalThis.sleepBlockerIds = []
    globalThis.restoreSleepBlocker = () => {
      powerSaveBlocker.start = original
    }
    powerSaveBlocker.start = (type) => {
      const id = original(type)
      globalThis.sleepBlockerIds.push(id)
      return id
    }
  })
  await page.evaluate(() =>
    window.navo.saveSettings({
      preventSleepDuringRequests: true,
      sleepReleaseDelaySeconds: 3
    })
  )
  await (await fetch(`http://127.0.0.1:${gatewayPort}/sleep-blocker-check`)).text()
  assert.equal(
    await application.evaluate(
      ({ powerSaveBlocker }) =>
        globalThis.sleepBlockerIds.length === 1 &&
        powerSaveBlocker.isStarted(globalThis.sleepBlockerIds[0])
    ),
    true
  )
  if (process.platform === 'darwin') {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readFile(sleepStateFile, 'utf8')) === '1') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(await readFile(sleepStateFile, 'utf8'), '1')
  }
  await page.waitForTimeout(3500)
  if (process.platform === 'darwin') assert.equal(await readFile(sleepStateFile, 'utf8'), '0')
  assert.equal(
    await application.evaluate(({ powerSaveBlocker }) =>
      powerSaveBlocker.isStarted(globalThis.sleepBlockerIds[0])
    ),
    false
  )
  await (await fetch(`http://127.0.0.1:${gatewayPort}/sleep-blocker-check`)).text()
  await page.evaluate(() =>
    window.navo.saveSettings({
      preventSleepDuringRequests: false,
      sleepReleaseDelaySeconds: 60
    })
  )
  assert.equal(
    await application.evaluate(({ powerSaveBlocker }) =>
      globalThis.sleepBlockerIds.some((id) => powerSaveBlocker.isStarted(id))
    ),
    false
  )
  await application.evaluate(() => globalThis.restoreSleepBlocker())
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  const originalClipboard = await application.evaluate(({ clipboard }) => clipboard.readText())
  let groupKey
  try {
    await page.evaluate(() => window.navo.copyConnection({ groupId: 'default', format: 'key' }))
    groupKey = await application.evaluate(({ clipboard }) => clipboard.readText())
    await page.getByRole('button', { name: '复制 api.json 链接', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
      `http://127.0.0.1:${gatewayPort}/api.json`
    )
    const registryResponse = await fetch(`http://127.0.0.1:${gatewayPort}/api.json`, {
      headers: { authorization: `Bearer ${groupKey}` }
    })
    assert.equal(registryResponse.status, 200)
    const registry = (await registryResponse.json())['navo']
    assert.equal(registry.type, 'openai')
    assert.equal(registry.api, `http://127.0.0.1:${gatewayPort}/v1`)
    assert.equal(registry.models['kimi-for-coding'].name, 'Kimi For Coding')
    assert.deepEqual(registry.models['kimi-for-coding'].limit, { context: 1048576, output: 32768 })
    await page.getByRole('button', { name: '复制 URL', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('.statusbar-copy .lucide-check') !== null
    )
    assert.equal(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
      `http://127.0.0.1:${gatewayPort}/v1`
    )
    assert.equal(await page.getByRole('button', { name: '复制 Key', exact: true }).count(), 0)
  } finally {
    await application.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      originalClipboard
    )
  }
  for (let i = 0; i < 4; i++) {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${groupKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-for-coding',
        messages: [{ role: 'user', content: 'smoke' }]
      })
    })
    assert.equal(response.status, 200)
    await response.json()
  }
  assert.deepEqual(forwarded, [
    'Bearer smoke-secret-b',
    'Bearer smoke-secret-b',
    'Bearer smoke-secret-b',
    'Bearer smoke-secret-b'
  ])
  await page.waitForFunction(async () => (await window.navo.getGateway()).requests.length === 5)
  await page.getByRole('button', { name: '返回概览', exact: true }).click()
  await page.getByRole('button', { name: '调度页', exact: true }).click()
  await page.locator('.flow-node.model').first().waitFor()
  await page.locator('.flow-node.agent').nth(3).waitFor()
  assert.equal(await page.locator('.flow-node.agent').count(), 4)
  assert.equal(await page.locator('.flow-node.harness').count(), 1)
  const idleSlider = page.getByRole('slider', { name: '空闲节点保留时间' })
  await idleSlider.focus()
  await idleSlider.press('End')
  await page.waitForFunction(
    async () => (await window.navo.getGateway()).settings.flowIdleMinutes === 60
  )
  await page.reload()
  await page.getByRole('slider', { name: '空闲节点保留时间' }).waitFor()
  assert.equal(await idleSlider.inputValue(), '4')
  const sliderBounds = await idleSlider.boundingBox()
  await page.mouse.move(
    sliderBounds.x + sliderBounds.width - 6,
    sliderBounds.y + sliderBounds.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(sliderBounds.x + 6, sliderBounds.y + sliderBounds.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForFunction(
    async () => (await window.navo.getGateway()).settings.flowIdleMinutes === 5
  )
  const flowInitialTheme = await page.locator('html').getAttribute('data-theme')
  for (const [themeName, themeId, background] of [
    ['深色模式', 'dark', 'rgb(3, 18, 34)'],
    ['浅色模式', 'light', 'rgb(246, 250, 255)']
  ]) {
    await page.getByRole('button', { name: themeName, exact: true }).click()
    await page.waitForFunction(
      ({ themeId, background }) =>
        document.documentElement.dataset.theme === themeId &&
        getComputedStyle(document.querySelector('.flow-canvas')).backgroundColor === background,
      { themeId, background }
    )
    await page.screenshot({ path: join(artifacts, `live-flow-${themeId}.png`) })
  }
  if (flowInitialTheme === 'dark')
    await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.screenshot({ path: join(artifacts, 'live-flow.png') })
  assert.equal(
    await page.getByRole('button', { name: '调度页', exact: true }).getAttribute('aria-pressed'),
    'true'
  )
  await page.reload()
  await page.locator('.live-flow-panel').waitFor()
  assert.equal(
    await page.getByRole('button', { name: '调度页', exact: true }).getAttribute('aria-pressed'),
    'true'
  )
  await page.getByRole('button', { name: '额度页', exact: true }).click()
  await page.locator('.overview-quotas').waitFor()
  assert.equal(
    await page.getByRole('button', { name: '额度页', exact: true }).getAttribute('aria-pressed'),
    'true'
  )
  await page.getByRole('img', { name: '5,500', exact: true }).waitFor()
  const autoRefresh = page.getByRole('button', { name: '切换自动刷新间隔', exact: true })
  for (const label of ['5s', '15s', '30s']) {
    assert.equal(await autoRefresh.textContent(), label)
    await autoRefresh.click()
  }
  assert.equal(await autoRefresh.textContent(), '5s')
  await page.locator('.workspace').evaluate((el) => el.scrollTo(0, 0))
  await page.screenshot({ path: join(artifacts, 'usage.png') })
  const quotaCards = page.locator('.overview-account-card')
  const logo = page.getByRole('button', { name: '长按 开发账号 A Logo 拖动排序', exact: true })
  await logo.click()
  assert.equal(await page.locator('.quota-drag-ghost').count(), 0)
  const logoBounds = await logo.boundingBox()
  const destinationBounds = await page
    .getByRole('article', { name: '开发账号 B 额度', exact: true })
    .boundingBox()
  await page.mouse.move(logoBounds.x + logoBounds.width / 2, logoBounds.y + logoBounds.height / 2)
  await page.mouse.down()
  await page.waitForSelector('.quota-drag-ghost')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForSelector('.quota-drag-ghost', { state: 'detached' })
  assert.equal(await quotaCards.first().getAttribute('aria-label'), '开发账号 A 额度')
  await page.mouse.down()
  await page.waitForSelector('.quota-drag-ghost')
  await page.evaluate(() => {
    window.__nativeDragCount = 0
    document.addEventListener('dragstart', () => window.__nativeDragCount++)
  })
  await page.mouse.move(
    destinationBounds.x + destinationBounds.width / 2,
    destinationBounds.y + 50,
    { steps: 10 }
  )
  assert.equal(await page.evaluate(() => window.__nativeDragCount), 0)
  const ghostBounds = await page.locator('.quota-drag-ghost').boundingBox()
  assert.ok(ghostBounds.x > logoBounds.x + 100, 'dragged card follows the pointer')
  await page.mouse.up()
  await page.waitForSelector('.quota-drag-ghost', { state: 'detached' })
  await page.waitForFunction(
    () =>
      document.querySelector('.overview-account-card')?.getAttribute('aria-label') ===
      '开发账号 B 额度'
  )
  assert.equal(await quotaCards.first().getAttribute('aria-label'), '开发账号 B 额度')
  await page.screenshot({ path: join(artifacts, 'quota-card-order.png') })
  const heatmap = page.getByRole('region', { name: '每日消耗热力图', exact: true })
  await heatmap
    .getByLabel('历史活动统计', { exact: true })
    .getByText('最长连续天数', { exact: true })
    .waitFor()
  await page.waitForFunction(() =>
    document.querySelector('.activity-summary')?.textContent.includes('1 天')
  )
  await page.locator('.toast').waitFor({ state: 'hidden' })
  await heatmap.locator('.heatmap-day.is-today').waitFor()
  await heatmap.locator('.heatmap-day.is-today').hover()
  await heatmap.getByRole('tooltip').waitFor()
  assert.match(await heatmap.getByRole('tooltip').textContent(), /使用了.*Token/)
  assert.equal(await heatmap.locator('.heatmap-day.is-today').getAttribute('title'), null)
  await page.screenshot({ path: join(artifacts, 'heatmap-tooltip-daily.png') })
  assert.ok((await heatmap.locator('.heatmap-day').count()) > 300)
  await heatmap.getByRole('button', { name: '每周', exact: true }).click()
  assert.ok((await heatmap.locator('.heatmap-level-3').count()) > 0)
  await heatmap.locator('.heatmap-level-3').last().scrollIntoViewIfNeeded()
  await heatmap.locator('.heatmap-level-3').last().hover()
  assert.match(await heatmap.getByRole('tooltip').textContent(), /当周：/)
  assert.equal(await heatmap.locator('.is-hovered').count(), 7)
  await page.screenshot({ path: join(artifacts, 'heatmap-tooltip-weekly.png') })
  await heatmap.getByRole('button', { name: '累计', exact: true }).click()
  assert.ok((await heatmap.locator('.heatmap-level-3').count()) > 0)
  await heatmap.locator('.heatmap-level-3').last().focus()
  assert.match(await heatmap.getByRole('tooltip').textContent(), /截至.*累计/)
  await page.screenshot({ path: join(artifacts, 'heatmap-tooltip-cumulative.png') })
  await page.keyboard.press('Escape')
  assert.equal(await heatmap.getByRole('tooltip').count(), 0)
  await heatmap.getByRole('button', { name: '每日', exact: true }).click()
  await heatmap.locator('.heatmap-day.is-today').click()
  await heatmap.getByText('kimi-for-coding', { exact: true }).waitFor()
  assert.match(await heatmap.locator('.heatmap-day-summary').textContent(), /5 次请求.*5,500/)
  await heatmap.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifacts, 'heatmap.png') })
  await heatmap.getByRole('button', { name: '收起', exact: true }).click()
  const quotaCard = page.getByRole('article', { name: '开发账号 A 额度', exact: true })
  await quotaCard.getByText('5h', { exact: true }).waitFor()
  await quotaCard.getByText('7D', { exact: true }).waitFor()
  assert.equal(
    await page.getByRole('region', { name: '已关联账号额度' }).getByRole('article').count(),
    2
  )
  assert.equal(
    await quotaCard.getByRole('progressbar', { name: '5h 剩余额度比例' }).getAttribute('value'),
    '80'
  )
  await quotaCard.getByTitle('剩余 40 / 50', { exact: true }).waitFor()
  await quotaCard.getByTitle('剩余 80 / 100', { exact: true }).waitFor()
  fiveHourRemaining = 35
  weeklyRemaining = 60
  await quotaCard.getByRole('button', { name: '刷新 开发账号 A 额度', exact: true }).click()
  await page.getByRole('button', { name: '刷新 开发账号 B 额度', exact: true }).click()
  await quotaCard.getByTitle('剩余 35 / 50', { exact: true }).waitFor()
  await quotaCard.getByTitle('剩余 60 / 100', { exact: true }).waitFor()
  const costCard = page.getByRole('article', { name: '开发账号 B 额度', exact: true })
  await costCard.getByText('估算总额', { exact: false }).first().waitFor()
  assert.equal(await quotaCard.locator('.quota-cost-estimate').count(), 2)
  const estimatedAccount = await page.evaluate(async () =>
    (await window.navo.getGateway()).accounts.find((account) => account.name === '开发账号 B')
  )
  for (const [key, fraction] of [
    ['fiveHour', 0.3],
    ['weekly', 0.4]
  ]) {
    const amount = estimatedAccount.quotaEstimates[key].amounts[0]
    assert.ok(amount.used > 0)
    assert.ok(Math.abs(amount.total - amount.used / fraction) < 1e-9)
    const average = estimatedAccount.quotaEstimates[key].averages.find(
      (entry) => entry.currency === amount.currency
    )
    assert.equal(average.cycles, 1)
    assert.equal(average.total, amount.total)
    assert.equal(estimatedAccount.quotaEstimates[key].cacheHitRate, 0.8)
  }
  assert.equal(await costCard.getByText('估算均值', { exact: false }).count(), 2)
  assert.equal(await costCard.getByText('缓存命中率', { exact: false }).count(), 2)
  assert.equal(
    await costCard
      .locator('.quota-cost-estimate')
      .getByRole('img', { name: '80%', exact: true })
      .count(),
    2
  )
  await page.screenshot({ path: join(artifacts, 'quota-cost-estimates.png') })
  await costCard.getByRole('button', { name: '管理 开发账号 B 5H 统计周期', exact: true }).click()
  const cycleDialog = page.getByRole('dialog', { name: '开发账号 B · 5H 统计周期', exact: true })
  await cycleDialog.getByRole('button', { name: '排除统计', exact: true }).click()
  await cycleDialog.getByText('已排除', { exact: true }).waitFor()
  const excludedSnapshot = await page.evaluate(() => window.navo.getGateway())
  assert.deepEqual(
    excludedSnapshot.accounts.find((a) => a.name === '开发账号 B').quotaEstimates.fiveHour.averages,
    []
  )
  assert.equal(
    excludedSnapshot.accounts.find((a) => a.name === '开发账号 B').quotaEstimates.weekly.averages
      .length,
    1
  )
  await page.screenshot({ path: join(artifacts, 'quota-cycle-manager.png') })
  await cycleDialog.getByRole('button', { name: '恢复统计', exact: true }).click()
  await cycleDialog.getByText('参与均值', { exact: true }).waitFor()
  const restoredCycles = await page.evaluate(() => window.navo.getGateway())
  assert.equal(
    restoredCycles.accounts.find((a) => a.name === '开发账号 B').quotaEstimates.fiveHour.averages[0]
      .cycles,
    1
  )
  await cycleDialog.getByRole('button', { name: '关闭对话框', exact: true }).click()

  assert.equal(
    await quotaCard.getByRole('progressbar', { name: '5h 剩余额度比例' }).getAttribute('value'),
    '70'
  )
  assert.equal(
    await quotaCard.getByRole('progressbar', { name: '7D 剩余额度比例' }).getAttribute('value'),
    '60'
  )
  fiveHourRemaining = 0
  await quotaCard.getByRole('button', { name: '刷新 开发账号 A 额度', exact: true }).click()
  await quotaCard.getByTitle('剩余 0 / 50', { exact: true }).waitFor()
  assert.equal(
    await quotaCard.getByRole('progressbar', { name: '5h 剩余额度比例' }).getAttribute('value'),
    '0'
  )

  await page.getByText('已复制到剪贴板', { exact: true }).waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(artifacts, 'light.png') })

  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    'rgb(21, 23, 25)'
  )
  assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark')
  assert.deepEqual(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')), {
    theme: 'dark',
    sleepOnlyOnAC: false,
    preventSleepDuringRequests: false,
    sleepReleaseDelaySeconds: 60
  })
  await page.screenshot({ path: join(artifacts, 'dark.png') })

  // 无效 IPC 输入应被主进程拒绝，不能污染已保存的主题。
  const rejected = await page.evaluate(async () => {
    try {
      await window.navo.saveSettings({ theme: 'invalid' })
      return false
    } catch {
      return true
    }
  })
  assert.equal(rejected, true)
  await application.close()
  application = undefined

  page = await launch()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  await page.getByRole('button', { name: '停止网关', exact: true }).waitFor()
  const restoredGateway = await page.evaluate(() => window.navo.getGateway())
  assert.equal(restoredGateway.modelPriceCatalog.prices.length, 2)
  assert.equal(restoredGateway.modelPriceCatalog.error, '')
  assert.equal(
    restoredGateway.modelPrices.find((p) => p.model === 'k3').catalogMatch.model,
    'kimi-for-coding'
  )
  assert.deepEqual(
    restoredGateway.modelPrices.filter((p) => p.model === 'kimi-for-coding'),
    [
      {
        provider: 'kimi',
        model: 'kimi-for-coding',
        currency: 'CNY',
        input: 1.25,
        output: 8,
        cacheRead: 0,
        cacheWrite: null
      }
    ]
  )
  assert.deepEqual(
    restoredGateway.quotaCardOrder,
    ['开发账号 B', '开发账号 A'].map(
      (name) => restoredGateway.accounts.find((a) => a.name === name).id
    )
  )
  assert.equal(
    await page.locator('.overview-account-card').first().getAttribute('aria-label'),
    '开发账号 B 额度'
  )
  assert.equal(restoredGateway.accounts.length, 2)
  assert.equal(restoredGateway.groups.length, 1)
  assert.equal(restoredGateway.settings.port, gatewayPort)
  assert.equal(restoredGateway.accounts.find((a) => a.name === '开发账号 A').maxConcurrency, 5)
  assert.equal(restoredGateway.accounts.find((a) => a.name === '开发账号 A').concurrencyOverride, 5)
  assert.equal(await page.getByRole('tablist', { name: '网关管理' }).count(), 0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.getByText('开发账号 A', { exact: true }).waitFor()
  // 关闭窗口只隐藏，后台网关仍然处理真实 HTTP 请求。
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.close()
      return !window.isDestroyed() && !window.isVisible() && !globalThis.smokeTray.isDestroyed()
    }),
    true
  )
  // 使用重启前复制的密钥验证持久化后的真实转发。
  const restoredResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
    headers: { authorization: `Bearer ${groupKey}` }
  })
  assert.equal(restoredResponse.status, 200)
  await restoredResponse.text()
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => {
      globalThis.smokeTrayMenu.items.find((item) => item.label === '显示主窗口').click()
      return BrowserWindow.getAllWindows()[0].isVisible()
    }),
    true
  )
  for (const event of ['activate', 'second-instance']) {
    assert.equal(
      await application.evaluate(({ app, BrowserWindow }, event) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.close()
        app.emit(event)
        return window.isVisible() && BrowserWindow.getAllWindows().length === 1
      }, event),
      true
    )
  }
  await page.getByRole('tab', { name: '请求记录' }).click()
  await page.getByRole('columnheader', { name: '费用', exact: true }).waitFor()
  const costButton = page
    .getByRole('row')
    .filter({ hasText: 'kimi-for-coding' })
    .first()
    .getByRole('button', { name: '查看请求费用明细', exact: true })
  await costButton.scrollIntoViewIfNeeded()
  await costButton.hover()
  await costButton.focus()
  const costTooltip = page.getByRole('tooltip').filter({ hasText: '请求费用明细' })
  await costTooltip.getByText('缓存读取', { exact: true }).waitFor()
  await costTooltip.getByText('800', { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'request-cost-tooltip.png') })
  await costButton.press('Escape')
  await costTooltip.waitFor({ state: 'hidden' })
  await page.getByText('模型列表', { exact: true }).waitFor()
  // 重启后旧请求仍可查看；新增请求通过 10 条游标分页访问。
  assert.equal(restoredGateway.requests.length, 5)
  for (let i = 0; i < 11; i++) {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${groupKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-for-coding', input: 'smoke' })
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  await page.getByText('共 17 条', { exact: true }).waitFor()
  assert.equal(await page.getByRole('row').count(), 11)
  // Request IDs remain in history even though the table no longer renders them.
  await page.waitForFunction(async () =>
    (await window.navo.getRequestHistory()).records.some(
      (record) => record.upstreamRequestId === '6adf4190-2959-4444-878c-454c7a6673ad'
    )
  )
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByText('第 2 页', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 7)
  await page.getByRole('button', { name: '上一页', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 10)
  await page.screenshot({ path: join(artifacts, 'requests.png') })
  await page.getByRole('tab', { name: /账号池/ }).click()
  const row = page.getByRole('row').filter({ hasText: '开发账号 B' })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('账号名称', { exact: true }).fill('备用账号 B')
  await page.getByLabel('账号并发上限', { exact: true }).fill('7')
  await page.getByRole('button', { name: '恢复自动', exact: true }).click()
  assert.equal(await page.getByLabel('账号并发上限', { exact: true }).inputValue(), '30')
  await page.getByLabel('账号并发上限', { exact: true }).fill('7')
  await page.screenshot({ path: join(artifacts, 'account-editor.png') })
  await page.getByRole('button', { name: '保存账号', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByText('备用账号 B', { exact: true }).waitFor()
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.navo.getGateway()).accounts.find((a) => a.name === '备用账号 B')
          .maxConcurrency
    ),
    7
  )
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    'rgb(248, 249, 250)'
  )
  await page.getByRole('button', { name: '添加账号', exact: true }).first().click()
  await page.getByLabel('供应商', { exact: true }).selectOption('deepseek')
  assert.equal(await page.getByLabel('账号区域', { exact: true }).count(), 0)
  await page.getByLabel('账号名称', { exact: true }).fill('DeepSeek 测试账号')
  await page.getByLabel('API Key', { exact: true }).fill('smoke-deepseek-key')
  await page.getByLabel('API Key', { exact: true }).press('Tab')
  await page.getByRole('img', { name: 'CNY 12.5', exact: true }).waitFor()
  await page.getByRole('img', { name: 'USD 2.75', exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('上游 Base URL', { exact: true }).inputValue(),
    'https://api.deepseek.com/v1'
  )
  await page
    .getByRole('table', { name: '可用模型' })
    .getByText('deepseek-test-model', { exact: true })
    .waitFor()
  await page.screenshot({ path: join(artifacts, 'deepseek-editor.png') })
  await page.getByRole('button', { name: '保存账号', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page
    .getByRole('row')
    .filter({ hasText: 'DeepSeek 测试账号' })
    .getByRole('img', { name: 'USD 2.75', exact: true })
    .waitFor()
  await application.close()
  application = undefined
  page = await launch()
  const deepseekAccount = await page.evaluate(async () =>
    (await window.navo.getGateway()).accounts.find((account) => account.provider === 'deepseek')
  )
  assert.equal(deepseekAccount.name, 'DeepSeek 测试账号')
  assert.equal(deepseekAccount.capabilities.balance.balances.length, 2)
  await page.getByText('DeepSeek 测试账号', { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'deepseek-overview.png') })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  await page.getByLabel('供应商', { exact: true }).selectOption('minimax')
  await page.getByLabel('账号名称', { exact: true }).fill('MiniMax 测试账号')
  assert.equal(
    await page.getByLabel('上游 Base URL', { exact: true }).inputValue(),
    'https://api.minimaxi.com/v1'
  )
  await page.getByLabel('账号区域', { exact: true }).selectOption('global')
  assert.equal(
    await page.getByLabel('上游 Base URL', { exact: true }).inputValue(),
    'https://api.minimax.io/v1'
  )
  await page.getByLabel('API Key', { exact: true }).fill('smoke-minimax-key')
  await page.getByLabel('API Key', { exact: true }).press('Tab')
  await page
    .getByRole('table', { name: '可用模型' })
    .getByText('MiniMax-M3', { exact: true })
    .waitFor()
  await page.screenshot({ path: join(artifacts, 'minimax-editor.png') })
  await page.getByRole('button', { name: '保存账号', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  const minimaxAccount = await page.evaluate(async () =>
    (await window.navo.getGateway()).accounts.find((account) => account.provider === 'minimax')
  )
  assert.equal(minimaxAccount.region, 'global')
  assert.equal(minimaxAccount.capabilities.quota.fiveHour.remaining, 72)
  assert.equal(minimaxAccount.capabilities.quota.weekly.remaining, 64)
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  await page.getByLabel('供应商', { exact: true }).selectOption('opencode-go')
  assert.equal(await page.getByLabel('账号区域', { exact: true }).count(), 0)
  await page.getByLabel('账号名称', { exact: true }).fill('OpenCode Go 测试账号')
  await page.getByLabel('API Key', { exact: true }).fill('smoke-opencode-key')
  await page.getByLabel('API Key', { exact: true }).press('Tab')
  await page.getByRole('dialog').getByText('剩余 70%', { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('上游 Base URL', { exact: true }).inputValue(),
    'https://opencode.ai/zen/go/v1'
  )
  assert.equal(await page.getByLabel('minimax-test Messages', { exact: true }).isChecked(), true)
  assert.equal(await page.getByLabel('minimax-test Responses', { exact: true }).isChecked(), false)
  await page.getByLabel('minimax-test Responses', { exact: true }).check()
  await page.getByLabel('minimax-test Messages', { exact: true }).uncheck()
  assert.equal(await page.getByLabel('minimax-test Responses', { exact: true }).isDisabled(), false)
  await page.getByLabel('minimax-test Responses', { exact: true }).uncheck()
  assert.equal(await page.getByLabel('minimax-test Responses', { exact: true }).isChecked(), false)
  await page.getByLabel('minimax-test Responses', { exact: true }).check()
  await page.getByRole('button', { name: '获取上游信息', exact: true }).click()
  await page.getByLabel('minimax-test Responses', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('minimax-test Responses', { exact: true }).isChecked(), true)
  await page.getByRole('table', { name: '可用模型' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifacts, 'opencode-go-editor.png') })
  await page.getByRole('button', { name: '保存账号', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  const goRow = page.getByRole('row').filter({ hasText: 'OpenCode Go 测试账号' })
  await goRow.getByText('月 70%', { exact: true }).waitFor()
  const kimiFont = await page
    .locator('.quota-summary > span')
    .first()
    .evaluate((element) => getComputedStyle(element).fontSize)
  assert.equal(
    await goRow
      .locator('.quota-summary > span')
      .evaluate((element) => getComputedStyle(element).fontSize),
    kimiFont
  )
  await application.close()
  application = undefined
  page = await launch()
  const goAccount = await page.evaluate(async () =>
    (await window.navo.getGateway()).accounts.find((account) => account.provider === 'opencode-go')
  )
  assert.equal(goAccount.capabilities.quota.monthly.remaining, 70)
  assert.equal(goAccount.capabilities.quota.unit, 'percent')
  assert.deepEqual(goAccount.modelProtocols['minimax-test'], ['responses'])
  await page.getByText('OpenCode Go 测试账号', { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'opencode-go-overview.png') })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(640, 440)
  )
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    true
  )
  await page.screenshot({ path: join(artifacts, 'compact.png') })
  await page.getByRole('button', { name: '返回概览', exact: true }).click()
  await page.getByRole('button', { name: '停止网关', exact: true }).click()
  await page.getByRole('button', { name: '启动网关', exact: true }).waitFor()
  await page.getByRole('button', { name: '复制 URL', exact: true }).waitFor({ state: 'hidden' })
  // 仅隔离的测试进程注入已聚合数据，验证峰谷列、首 token 单位和多模型布局。
  const performancePreview = await page.evaluate(async () => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const stats = await window.navo.getUsageStats({
      start: start.getTime(),
      end: start.getTime() + 86400000,
      bucketMs: 3600000
    })
    const snapshot = await window.navo.getGateway()
    stats.byAccount = [
      {
        accountId: snapshot.accounts[0].id,
        model: 'kimi-for-coding-highspeed',
        period: 'off-peak',
        averageFirstTokenMs: 180,
        firstTokenSamples: 2,
        averageTokensPerSecond: 62.9,
        speedSamples: 2
      },
      {
        accountId: snapshot.accounts[0].id,
        model: 'kimi-for-coding-highspeed',
        period: 'peak',
        averageFirstTokenMs: 1260,
        firstTokenSamples: 3,
        averageTokensPerSecond: 45.6,
        speedSamples: 3
      },
      {
        accountId: snapshot.accounts[0].id,
        model: 'k3',
        period: 'peak',
        averageFirstTokenMs: 2300,
        firstTokenSamples: 1,
        averageTokensPerSecond: 18.5,
        speedSamples: 1
      },
      {
        accountId: snapshot.accounts.find((account) => account.provider === 'opencode-go').id,
        model: 'deepseek-flash',
        period: 'off-peak',
        averageFirstTokenMs: 420,
        firstTokenSamples: 2,
        averageTokensPerSecond: 92.5,
        speedSamples: 2
      },
      {
        accountId: snapshot.accounts.find((account) => account.provider === 'opencode-go').id,
        model: 'deepseek-flash',
        period: 'peak',
        averageFirstTokenMs: 980,
        firstTokenSamples: 3,
        averageTokensPerSecond: 61.3,
        speedSamples: 3
      }
    ]
    return stats
  })
  await application.evaluate(({ ipcMain, BrowserWindow }, stats) => {
    ipcMain.removeHandler('gateway:usage-stats')
    ipcMain.handle('gateway:usage-stats', () => stats)
    BrowserWindow.getAllWindows()[0].setSize(1120, 900)
  }, performancePreview)
  const performanceTable = page.getByRole('table', {
    name: 'kimi-for-coding-highspeed 峰谷表现',
    exact: true
  })
  await performanceTable.getByRole('img', { name: '180ms', exact: true }).waitFor()
  await performanceTable.getByRole('img', { name: '1.26s', exact: true }).waitFor()
  await performanceTable.getByRole('img', { name: '62.9 tokens/s', exact: true }).waitFor()
  await performanceTable.getByRole('img', { name: '45.6 tokens/s', exact: true }).waitFor()
  assert.equal(
    await page
      .getByRole('table', { name: 'k3 峰谷表现', exact: true })
      .getByRole('img', { name: '—', exact: true })
      .count(),
    2
  )
  await page.screenshot({ path: join(artifacts, 'peak-offpeak-performance.png') })
  assert.deepEqual(errors, [])
  // A second before-quit listener can cancel the final quit; the still-visible UI
  // must retain access to its history database after the gateway has shut down.
  await application.evaluate(
    ({ app }) =>
      new Promise((resolve) => {
        let attempts = 0
        const cancelFinalQuit = (event) => {
          attempts++
          if (attempts === 2) {
            event.preventDefault()
            app.removeListener('before-quit', cancelFinalQuit)
            resolve()
          }
        }
        app.on('before-quit', cancelFinalQuit)
        app.quit()
      })
  )
  // The history handler still uses the real database (the usage handler above is a fixture).
  await page.evaluate(async () => {
    await window.navo.getRequestHistory()
  })
  await Promise.all([
    application.waitForEvent('close'),
    application.evaluate(() => {
      globalThis.smokeTrayMenu.items.find((item) => item.label === '退出 Navo').click()
    })
  ])
  application = undefined
  console.log(
    '通过：真实 Electron、进程隔离、主题、统一账号管理、系统加密存储、真实 HTTP 负载均衡、重启恢复与自动启动、请求记录及最小窗口布局。'
  )
} finally {
  if (application) await application.close()
  await new Promise((resolve) => {
    upstream.close(resolve)
    upstream.closeAllConnections()
  })
  await rm(userData, { recursive: true, force: true })
}
