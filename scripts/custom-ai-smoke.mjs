import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const userData = await mkdtemp(join(tmpdir(), 'navo-custom-ai-'))
const calls = []
const server = createServer((req, res) => {
  calls.push(req.url)
  assert.equal(req.headers.authorization, 'Bearer custom-smoke-key')
  res.setHeader('content-type', 'application/json')
  if (req.url === '/custom/v1/models') res.end(JSON.stringify({ data: [{ id: 'auto-model' }] }))
  else if (req.url === '/custom/v1/chat/completions') {
    setTimeout(
      () =>
        res.end(
          JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
        ),
      800
    )
  } else {
    res.writeHead(404)
    res.end('{}')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/custom/v1`
let app
try {
  const env = { ...process.env, NAVO_TEST_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [resolve('out/main/index.js')], env })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '先体验一下', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  for (const mode of ['automatic', 'manual']) {
    await page.getByRole('button', { name: '添加账号', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '添加账号', exact: true })
    await dialog.getByLabel('供应商', { exact: true }).selectOption('custom')
    await dialog.getByLabel('账号名称', { exact: true }).fill(`Custom ${mode}`)
    await dialog.getByLabel('模型列表来源', { exact: true }).selectOption(mode)
    await dialog
      .getByLabel('上游 Base URL', { exact: true })
      .fill(mode === 'automatic' ? baseUrl : `${baseUrl}/manual`)
    await dialog.getByLabel('API Key', { exact: true }).fill('custom-smoke-key')
    await dialog.getByLabel('API Key', { exact: true }).press('Tab')
    if (mode === 'automatic') await dialog.getByText('auto-model', { exact: true }).waitFor()
    else
      assert.equal(
        await dialog.getByRole('button', { name: '获取模型列表', exact: true }).isDisabled(),
        true
      )
    await dialog
      .getByLabel('手动添加模型', { exact: true })
      .fill('manual-one\nmanual-two,manual-one')
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
    await dialog.locator('th[title="manual-two"]').waitFor()
    assert.equal(
      await dialog.getByLabel('manual-one Completions', { exact: true }).isChecked(),
      true
    )
    assert.equal(await dialog.getByLabel('manual-one Messages', { exact: true }).isChecked(), false)
    if (mode === 'automatic') {
      const testButton = dialog.getByRole('button', { name: '测试模型 auto-model', exact: true })
      await testButton.click()
      await page.waitForFunction(
        () => document.querySelector('.model-test-controls button')?.textContent === '测试中…'
      )
      // A parent render while the request is pending must not discard its result.
      await dialog.getByLabel('手动添加模型', { exact: true }).fill('pending-rerender')
      const result = dialog.locator('.model-test-result summary').filter({ hasText: '成功' })
      await result.waitFor()
      await dialog.getByLabel('手动添加模型', { exact: true }).fill('')
      assert.equal(await result.isVisible(), true)
      await result.click()
      await dialog.locator('.model-test-result p').getByText('OK', { exact: true }).waitFor()
    }
    await dialog.getByRole('button', { name: '添加映射', exact: true }).click()
    await dialog.getByLabel('请求模型 ID 1', { exact: true }).fill('client-alias')
    await dialog.getByLabel('上游模型 ID 1', { exact: true }).fill('manual-one')
    await dialog.getByRole('button', { name: '添加映射', exact: true }).click()
    await dialog.getByLabel('请求模型 ID 2', { exact: true }).fill('client-alias')
    await dialog.getByLabel('上游模型 ID 2', { exact: true }).fill('manual-two')
    await dialog.getByRole('button', { name: '保存账号', exact: true }).click()
    await dialog.getByRole('alert').getByText('请求模型 ID 不能重复', { exact: true }).waitFor()
    await dialog.getByLabel('请求模型 ID 2', { exact: true }).fill('claude-*')
    await dialog.getByRole('button', { name: '添加映射', exact: true }).click()
    await dialog.getByRole('button', { name: '删除映射 3', exact: true }).click()
    await dialog.getByRole('region', { name: '模型 ID 映射', exact: true }).scrollIntoViewIfNeeded()
    await mkdir(resolve('artifacts'), { recursive: true })
    await page.screenshot({ path: resolve(`artifacts/custom-ai-${mode}.png`) })
    await dialog.getByRole('button', { name: '保存账号', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  await page.reload()
  const snapshot = await page.evaluate(() => window.navo.getGateway())
  assert.equal(snapshot.accounts.length, 2)
  assert.deepEqual(snapshot.accounts[0].models, ['auto-model', 'manual-one', 'manual-two'])
  assert.deepEqual(snapshot.accounts[1].models, ['manual-one', 'manual-two'])
  assert.equal(snapshot.accounts[1].baseUrl, `${baseUrl}/manual`)
  for (const account of snapshot.accounts)
    assert.deepEqual(account.modelMappings, {
      'client-alias': 'manual-one',
      'claude-*': 'manual-two'
    })
  assert.ok(calls.length > 0)
  assert.ok(
    calls.every((url) => ['/custom/v1/models', '/custom/v1/chat/completions'].includes(url))
  )
  assert.equal(calls.filter((url) => url === '/custom/v1/chat/completions').length, 1)
  assert.deepEqual(errors, [])
  console.log(
    '通过：自定义 URL / Key、自动获取、手动批量模型、默认协议、模型映射增删及重复校验、保存及重新加载。'
  )
} finally {
  if (app) await app.close()
  await new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
  await rm(userData, { recursive: true, force: true })
}
