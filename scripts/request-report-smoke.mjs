import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const userData = await mkdtemp(join(tmpdir(), 'navo-request-report-'))
const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
const port = reserve.address().port
await new Promise((resolve) => reserve.close(resolve))
let app
try {
  const env = { ...process.env, NAVO_TEST_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [resolve('out/main/index.js')], env })
  await app.evaluate(({ shell }) => {
    globalThis.reportUrls = []
    shell.openExternal = async (url) => {
      if (globalThis.failReportOpen) throw new Error('模拟浏览器打开失败')
      globalThis.reportUrls.push(url)
    }
  })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '先体验一下', exact: true }).click()
  await page.evaluate(async (port) => {
    const { settings } = await window.navo.getGateway()
    await window.navo.saveGateway({ ...settings, port })
    await window.navo.setGatewayRunning(true)
  }, port)
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'private-model',
      messages: [{ role: 'user', content: 'private-prompt' }]
    })
  })
  assert.equal(response.status, 503)
  await response.text()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.getByRole('tab', { name: '请求记录' }).click()
  const button = page.getByRole('button', { name: '上报 Issue：503 private-model', exact: true })
  const confirmReport = page.getByRole('dialog', { name: '确认上报请求错误', exact: true })
  await button.click()
  await confirmReport.waitFor()
  assert.match(await confirmReport.innerText(), /相同的错误.*短时间内重复上报/)
  assert.match(await confirmReport.innerText(), /3 天内.*节假日/)
  assert.equal((await app.evaluate(() => globalThis.reportUrls)).length, 0)
  await mkdir(resolve('artifacts'), { recursive: true })
  await page.screenshot({ path: resolve('artifacts/request-report-confirm.png') })
  await confirmReport.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await confirmReport.count(), 0)
  assert.equal((await app.evaluate(() => globalThis.reportUrls)).length, 0)
  await button.click()
  await confirmReport.getByRole('button', { name: '继续上报', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已打开 GitHub Issue' }).waitFor()
  const urls = await app.evaluate(() => globalThis.reportUrls)
  assert.equal(urls.length, 1)
  const url = new URL(urls[0])
  assert.equal(url.pathname, '/DuskLin/navo/issues/new')
  assert.match(url.searchParams.get('body'), /无可用账号/)
  assert.ok(url.searchParams.get('body').includes('private-model'))
  assert.ok(!url.searchParams.get('body').includes('private-prompt'))
  await mkdir(resolve('artifacts'), { recursive: true })
  await page.screenshot({ path: resolve('artifacts/request-report.png') })
  {
    const db = new DatabaseSync(join(userData, 'gateway.json.requests.sqlite'))
    try {
      db.prepare('UPDATE request_failures SET diagnostic = ?').run(
        JSON.stringify({
          captureVersion: 2,
          request: { model: 'private-model' },
          errors: [
            { attempt: 1, detail: { message: 'complete-error-'.repeat(2000) + 'END-OF-EVIDENCE' } }
          ]
        })
      )
    } finally {
      db.close()
    }
  }
  await button.click()
  await confirmReport.getByRole('button', { name: '继续上报', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '完整诊断报告已复制' }).waitFor()
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  assert.ok(copied.includes('complete-error-'.repeat(2000) + 'END-OF-EVIDENCE'))
  await app.evaluate(() => {
    globalThis.failReportOpen = true
  })
  await button.click()
  await confirmReport.getByRole('button', { name: '继续上报', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '模拟浏览器打开失败' }).waitFor()
  assert.equal(await button.isEnabled(), true)
  // Exercise renderer visibility independently from report authorization in the main process.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('gateway:request-history')
    ipcMain.handle('gateway:request-history', () => ({
      records: [200, 400, 499].map((status) => ({
        id: String(status),
        time: Date.now(),
        account: '',
        group: '',
        model: 'test',
        status,
        attempts: 1,
        durationMs: 1,
        firstTokenMs: null
      })),
      nextCursor: null,
      total: 3
    }))
  })
  await page.getByRole('button', { name: '上报 Issue：400 test', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: /^上报 Issue：/ }).count(), 1)
  console.log(
    '通过：真实 Electron 错误请求 → 脱敏日志 → Issue 预填；499/成功无按钮；打开失败可重试。'
  )
} finally {
  await app?.close()
  await rm(userData, { recursive: true, force: true })
}
