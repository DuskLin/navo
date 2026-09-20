import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 2100, height: 900 } })
  let fail = false
  const quota = (remaining) => ({
    limit: 100,
    remaining,
    resetAt: new Date(Date.now() + 3600000).toISOString()
  })
  const data = {
    exportedAt: Date.now(),
    sessions: {
      session_a: {
        complete: true,
        input: 100,
        output: 200,
        cacheRead: 900,
        cacheWrite: 0,
        totalTokens: 1200,
        tokensPerSecond: 48.5,
        cacheHitRate: 0.9,
        requests: 2,
        agents: 2,
        speedAt: Date.now()
      }
    },
    accounts: [
      {
        id: 'a',
        name: '账号 A',
        enabled: true,
        checkedAt: Date.now(),
        fiveHour: quota(72),
        weekly: quota(48)
      },
      {
        id: 'b',
        name: '<img src=x onerror=alert(1)>',
        enabled: true,
        checkedAt: Date.now(),
        fiveHour: quota(10),
        weekly: quota(20)
      }
    ]
  }
  await page.route('http://quota.test/**', async (route) => {
    if (route.request().url().includes('navo-quota-data'))
      return route.fulfill({ status: fail ? 503 : 200, json: data })
    return route.fulfill({
      contentType: 'text/html',
      body: '<div class="chat-header" style="margin-left:270px;height:48px;display:flex;gap:14px"><div style="width:200px">会话标题</div><div class="ch-spacer" style="flex:1"></div><button id="open-file" style="width:200px">打开文件</button></div>'
    })
  })
  await page.goto('http://quota.test/sessions/session_a')
  await page.addScriptTag({
    content: await readFile(new URL('./widget.js', import.meta.url), 'utf8')
  })
  const host = page.locator('#navo-quota-widget')
  await host.locator('.speed').filter({ hasText: '48.5 tok/s' }).waitFor()
  await host.getByRole('button', { name: '查看当前会话 Token 统计' }).click()
  await host.locator('.session-panel').waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await page.evaluate(() => history.pushState({}, '', '/sessions/session_unknown'))
  await page.waitForFunction(
    () =>
      document.querySelector('#navo-quota-widget').shadowRoot.querySelector('.speed')
        .textContent === '— tok/s'
  )
  await page.evaluate(() => history.pushState({}, '', '/sessions/session_a'))
  await host.locator('.speed').filter({ hasText: '48.5 tok/s' }).waitFor()
  await host.getByText('72%', { exact: true }).waitFor()
  await host.getByRole('button', { name: '查看 <img src=x onerror=alert(1)> 额度' }).click()
  await host.getByText('剩余 10%', { exact: true }).waitFor()
  assert.equal(await host.locator('img').count(), 0)
  // 1～3 个账号的自然宽度，以及 4 个账号时横向滚动。
  const reload = () => host.getByRole('button', { name: '重新读取' }).click()
  data.accounts.push(
    { ...data.accounts[0], id: 'c', name: '账号 C' },
    { ...data.accounts[0], id: 'd', name: '账号 D' }
  )
  await reload()
  await host.getByRole('button', { name: '查看 账号 D 额度' }).waitFor({ state: 'attached' })
  assert.equal(await host.locator('.account').count(), 4)
  assert.equal(await host.getAttribute('data-visible-count'), '3')
  const gap = await page.evaluate(
    () =>
      document.querySelector('#open-file').getBoundingClientRect().left -
      document.querySelector('#navo-quota-widget').getBoundingClientRect().right
  )
  assert.ok(gap >= 24)
  await host.getByRole('button', { name: '向右查看账号' }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('#navo-quota-widget').shadowRoot.querySelector('.accounts')
        .scrollLeft > 200
  )
  // 按可用宽度降为两个、一个，不遮挡右侧按钮。
  await page.setViewportSize({ width: 1850, height: 900 })
  await page.waitForFunction(
    () => document.querySelector('#navo-quota-widget').dataset.visibleCount === '2'
  )
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.waitForFunction(
    () => document.querySelector('#navo-quota-widget').dataset.visibleCount === '1'
  )
  await page.setViewportSize({ width: 2100, height: 900 })
  await host.getByRole('button', { name: '查看 <img src=x onerror=alert(1)> 额度' }).click()
  if (!(await host.locator('.panel').isVisible()))
    await host.getByRole('button', { name: '查看 <img src=x onerror=alert(1)> 额度' }).click()
  data.accounts[1].checkedAt = Date.now() - 180000
  await host.getByRole('button', { name: '重新读取' }).click()
  await host.getByText('额度已过期，等待 Navo 更新').waitFor()
  fail = true
  await host.getByRole('button', { name: '重新读取' }).click()
  await host.getByText('Navo 未连接或数据同步已停止').waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await host.locator('.panel').isVisible(), false)
  await page.addScriptTag({
    content: await readFile(new URL('./widget.js', import.meta.url), 'utf8')
  })
  assert.equal(await page.locator('#navo-quota-widget').count(), 1)
  // 独立开关动态隐藏模块和详情，并释放布局空间。
  fail = false
  const sync = async (accountQuota, sessionStats) => {
    data.accountQuota = accountQuota
    data.sessionStats = sessionStats
    const response = page.waitForResponse((r) => r.url().includes('navo-quota-data'))
    await host.locator('.refresh').evaluate((button) => button.click())
    await response
  }
  await host.locator('.session-summary').click()
  await sync(true, false)
  await host.locator('.session-summary').waitFor({ state: 'hidden' })
  assert.equal(await host.locator('.session-panel').isVisible(), false)
  assert.equal(await host.locator('.accounts').isVisible(), true)
  await host.locator('.account').first().click()
  await sync(false, true)
  await host.locator('.accounts').waitFor({ state: 'hidden' })
  assert.equal(await host.locator('.panel').isVisible(), false)
  assert.equal(await host.locator('.session-summary').isVisible(), true)
  assert.equal(await host.locator('.prev').isVisible(), false)
  assert.equal(await host.locator('.next').isVisible(), false)
  assert.equal(await host.evaluate((el) => el.getBoundingClientRect().width), 300)
  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForFunction(
    () => document.querySelector('#navo-quota-widget').getBoundingClientRect().width === 48
  )
  assert.equal(await host.locator('.session-summary').isVisible(), true)
  await sync(false, false)
  await host.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 2100, height: 900 })
  await sync(true, true)
  await host.waitFor({ state: 'visible' })
  assert.equal(await host.locator('.accounts').isVisible(), true)
  assert.equal(await host.locator('.session-summary').isVisible(), true)
  data.accounts = [
    { id: 'empty', name: '无额度账号', enabled: true, checkedAt: Date.now() },
    { id: 'weekly-only', name: '仅周额度', enabled: true, checkedAt: Date.now(), weekly: quota(0) }
  ]
  await sync(true, true)
  await host.getByRole('button', { name: '查看 仅周额度 额度' }).waitFor()
  assert.equal(await host.locator('.account').count(), 1)
  assert.equal(await host.locator('.stat').count(), 1)
  assert.match(await host.locator('.stat').innerText(), /0%/)
  assert.doesNotMatch(await host.locator('.stats').innerText(), /5h/)
  await host.locator('.account').click()
  assert.equal(await host.locator('.details .row').count(), 1)
  console.log(
    '通过：全部账号、1～3 个响应式布局、超过 3 个横向滚动、按钮间距、名称转义、过期和断连提示、重复注入保护、独立模块开关及空间回收。'
  )
} finally {
  await browser.close()
}
