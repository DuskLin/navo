import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright'

const directory = await mkdtemp(join(tmpdir(), 'navo-receipt-smoke-'))
const artifacts = resolve('artifacts/usage-receipt')
await mkdir(artifacts, { recursive: true })
const database = new DatabaseSync(join(directory, 'gateway.json.requests.sqlite'))
database.exec(
  'CREATE TABLE requests (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, record TEXT NOT NULL)'
)
const history = {
  append: (record) =>
    database
      .prepare('INSERT INTO requests (id, record) VALUES (?, ?)')
      .run(record.id, JSON.stringify(record)),
  close: () => database.close()
}
const now = Date.now()
const base = {
  time: now - 100,
  group: '',
  account: 'Demo',
  accountId: 'demo',
  provider: 'custom',
  status: 200,
  attempts: 1,
  durationMs: 100,
  firstTokenMs: 20,
  usage: { input: 184210, output: 69320, cacheRead: 2258730, cacheWrite: 0, cost: 12.35 }
}
for (const [i, model] of ['gpt-demo', 'kimi-demo', 'legacy-model'].entries())
  history.append({
    ...base,
    id: `today-${i}`,
    model,
    harness: i === 2 ? undefined : i === 0 ? 'Codex' : 'Kimi Code',
    sessionId: i === 2 ? undefined : `session-${i}`
  })
for (let i = 0; i < 24; i++)
  history.append({
    ...base,
    id: `old-${i}`,
    time: now - 10 * 86400000,
    model: `custom-model-${i}-` + 'long-name-'.repeat(9),
    harness: 'Claude Code',
    sessionId: 'long-session'
  })
history.close()
const entry = join(directory, 'main.cjs')
await writeFile(
  entry,
  `
const { ipcMain, clipboard, dialog, net } = require('electron');
globalThis.receiptCopies = [];
globalThis.receiptFail = false;
globalThis.receiptSaveCancel = false;
globalThis.receiptCopyFail = false;
const original = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => original(channel, (...args) => {
  if (channel === 'gateway:usage-stats' && args[1]?.receipt && globalThis.receiptFail) throw new Error('测试统计读取失败');
  if (channel === 'gateway:usage-stats' && args[1]?.receipt && globalThis.receiptEmpty) args[1] = { ...args[1], accountId: 'empty-test-account' };
  return handler(...args);
});
clipboard.write = async (items) => {
  if (globalThis.receiptCopyFail) throw new Error('测试复制失败');
  const blob = await items[0].getType('image/png');
  globalThis.receiptCopies.push(Buffer.from(await blob.arrayBuffer()));
};
dialog.showSaveDialog = async () => globalThis.receiptSaveCancel ? { canceled: true } : { canceled: false, filePath: ${JSON.stringify(join(artifacts, 'receipt-export.png'))} };
globalThis.fetch = async () => { throw new Error('Offline smoke test'); };
net.fetch = globalThis.fetch;
require(${JSON.stringify(resolve('out/main/index.js'))});
`
)
const env = { ...process.env, NAVO_TEST_USER_DATA: directory }
delete env.ELECTRON_RUN_AS_NODE
let application
let recording
const errors = []
try {
  application = await electron.launch({
    args: [
      ...(process.env.NAVO_RECEIPT_DPR
        ? [`--force-device-scale-factor=${process.env.NAVO_RECEIPT_DPR}`]
        : []),
      entry
    ],
    env,
    ...(process.env.NAVO_RECEIPT_RECORD === '1'
      ? { recordVideo: { dir: join(artifacts, 'video'), size: { width: 1120, height: 760 } } }
      : {})
  })
  const page = await application.firstWindow()
  recording = page.video()
  await page.evaluate(() => {
    window.paperDraws = 0
    const draw = WebGLRenderingContext.prototype.drawElements
    WebGLRenderingContext.prototype.drawElements = function (...args) {
      window.paperDraws++
      return draw.apply(this, args)
    }
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '先体验一下' }).click()
  await page.getByRole('button', { name: '打印小票', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'AI 用量小票', exact: true })
  await application.evaluate(() => {
    globalThis.receiptFail = true
  })
  await modal.getByRole('button', { name: '打印我的小票' }).click()
  await modal.getByRole('alert').filter({ hasText: '测试统计读取失败' }).waitFor()
  await application.evaluate(() => {
    globalThis.receiptFail = false
  })
  await modal.getByRole('button', { name: '打印我的小票' }).click()
  await modal.getByText('正在打印小票…').waitFor()
  await modal.getByRole('button', { name: '跳过', exact: true }).click()
  await page.screenshot({ path: join(artifacts, 'print-light.png') })
  const paper = modal.locator('.receipt-moving-paper')
  let bounds = await paper.boundingBox()
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 30, y + 30)
  await page.mouse.up()
  assert.equal(await modal.locator('.receipt-paper-clip.ready').count(), 1)
  await page.waitForFunction(
    () => document.querySelector('.receipt-moving-paper').dataset.paperState === 'rest'
  )
  assert.equal(await paper.getAttribute('data-renderer'), 'mesh')
  if (process.env.NAVO_RECEIPT_SHARPNESS) {
    const tag = process.env.NAVO_RECEIPT_SHARPNESS
    const density = Number(process.env.NAVO_RECEIPT_DPR || 1)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1120,
      height: 760,
      deviceScaleFactor: density,
      mobile: false
    })
    const paint = () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            dispatchEvent(new Event('resize'))
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          })
      )
    await paint()
    assert.equal(await page.evaluate(() => devicePixelRatio), density)
    const capture = async (path) => {
      const rect = await paper.boundingBox()
      // Use CDP directly: Playwright's element screenshot temporarily resets Electron's emulated DPR.
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...rect, scale: 1 },
        captureBeyondViewport: true
      })
      await writeFile(path, Buffer.from(data, 'base64'))
    }
    await capture(join(artifacts, `sharpness-${tag}.png`))
    console.log(
      'Paper pixels',
      await paper.evaluate((element) => {
        const canvas = element.querySelector('canvas')
        const rect = canvas.getBoundingClientRect()
        return {
          dpr: devicePixelRatio,
          css: [rect.width, rect.height],
          bitmap: [canvas.width, canvas.height],
          renderer: element.dataset.renderer,
          state: element.dataset.paperState
        }
      })
    )
    await paper.evaluate((element) => {
      const img = element.querySelector('img').cloneNode()
      img.id = 'vector-reference'
      img.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;visibility:visible;filter:none;transform:none;pointer-events:none;z-index:10'
      element.append(img)
    })
    await capture(join(artifacts, `sharpness-${tag}-vector.png`))
    await paper.locator('#vector-reference').evaluate((element) => element.remove())
    await paper.evaluate((element) => {
      element.querySelector('canvas').style.visibility = 'visible'
      element.querySelector('img').style.visibility = 'hidden'
    })
    await capture(join(artifacts, `sharpness-${tag}-mesh.png`))
    const oldFilter = await paper.locator('canvas').evaluate((canvas) => {
      const filter = canvas.style.filter
      canvas.style.filter = 'none'
      return filter
    })
    await capture(join(artifacts, `sharpness-${tag}-mesh-no-filter.png`))
    await paper.locator('canvas').evaluate((canvas, filter) => {
      canvas.style.filter = filter
    }, oldFilter)
    await paper.evaluate((element) => {
      element.querySelector('canvas').style.removeProperty('visibility')
      element.querySelector('img').style.removeProperty('visibility')
    })
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await paint()
  }
  const idleDraws = await page.evaluate(() => window.paperDraws)
  await page.waitForTimeout(160)
  assert.equal(await page.evaluate(() => window.paperDraws), idleDraws)
  bounds = await paper.boundingBox()
  const gripX = bounds.x + bounds.width * 0.82,
    gripY = bounds.y + bounds.height * 0.16
  await page.mouse.move(gripX, gripY)
  await page.mouse.down()
  for (let step = 1; step <= 20; step++) {
    await page.mouse.move(gripX - (15 * step) / 20, gripY + (bounds.width * 0.55 * step) / 20)
    await page.waitForTimeout(12)
  }
  await page.waitForTimeout(240)
  assert.equal(await paper.getAttribute('data-paper-state'), 'pulling')
  const partialCut = Number(await paper.getAttribute('data-peel'))
  assert.ok(partialCut >= 0.75 && partialCut < 1)
  await page.screenshot({ path: join(artifacts, 'paper-bending.png') })
  await page.mouse.up()
  await page.waitForFunction(
    () => document.querySelector('.receipt-moving-paper').dataset.paperState === 'hanging'
  )
  assert.equal(await modal.locator('.receipt-paper-clip.ready').count(), 1)
  assert.equal(Number(await paper.getAttribute('data-peel')), partialCut)
  await page.screenshot({ path: join(artifacts, 'paper-hanging.png') })
  const hangingDraws = await page.evaluate(() => window.paperDraws)
  await page.waitForTimeout(process.env.NAVO_RECEIPT_RECORD === '1' ? 800 : 180)
  assert.equal(await page.evaluate(() => window.paperDraws), hangingDraws)
  // Re-grab the deformed surface rather than its old rectangular position.
  const secondX = bounds.x + bounds.width * 0.32,
    secondY = bounds.y + bounds.height * 0.22
  await page.mouse.move(secondX, secondY)
  await page.mouse.down()
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(secondX + step, secondY + (bounds.width * 0.26 * step) / 12)
    await page.waitForTimeout(12)
  }
  await modal.locator('.receipt-paper-clip.tearing').waitFor()
  await page.mouse.up()
  await page.waitForTimeout(90)
  await page.screenshot({ path: join(artifacts, 'paper-recoil.png') })
  await modal.getByRole('button', { name: '保存图片' }).waitFor()
  await page.screenshot({ path: join(artifacts, 'preview-light.png') })
  const src = await modal.locator('.receipt-scene').getAttribute('src')
  const svg = decodeURIComponent(src.split(',').slice(1).join(','))
  assert.ok(svg.includes('USD 37.05'))
  assert.ok(svg.includes('未知客户端'))
  await modal.getByRole('button', { name: '复制图片', exact: true }).click()
  await modal.getByRole('status').filter({ hasText: '图片已复制' }).waitFor()
  const copy = await application.evaluate(() => {
    const image = globalThis.receiptCopies.at(-1)
    return {
      signature: image.subarray(0, 8).toString('hex'),
      width: image.readUInt32BE(16),
      height: image.readUInt32BE(20)
    }
  })
  assert.equal(copy.signature, '89504e470d0a1a0a')
  assert.equal(copy.width, 1296)
  assert.ok(copy.height > 1500)
  await modal.getByRole('button', { name: '保存图片', exact: true }).click()
  await modal.getByRole('status').filter({ hasText: '小票已保存' }).waitFor()
  const png = await readFile(join(artifacts, 'receipt-export.png'))
  assert.equal(png.readUInt32BE(16), copy.width)
  assert.equal(png.readUInt32BE(20), copy.height)
  // A rejected export leaves the preview usable and retryable.
  await application.evaluate(() => {
    globalThis.receiptCopyFail = true
  })
  await modal.getByRole('button', { name: '复制图片', exact: true }).click()
  await modal.getByRole('alert').filter({ hasText: '测试复制失败' }).waitFor()
  await application.evaluate(() => {
    globalThis.receiptCopyFail = false
    globalThis.receiptSaveCancel = true
  })
  await modal.getByRole('button', { name: '保存图片', exact: true }).click()
  await page.waitForFunction(
    () => !document.querySelector('.receipt-export-actions button').disabled
  )
  assert.equal(await modal.getByRole('alert').count(), 0)
  await modal.getByRole('button', { name: 'Token', exact: true }).click()
  await modal.getByRole('button', { name: '森林', exact: true }).click()
  assert.equal(
    await modal.getByRole('button', { name: '森林' }).getAttribute('aria-pressed'),
    'true'
  )
  assert.ok(
    decodeURIComponent(await modal.locator('.receipt-scene').getAttribute('src')).includes(
      '总 T O K E N'
    )
  )
  await page.evaluate(async () => {
    await window.navo.saveSettings({ theme: 'dark' })
    document.documentElement.dataset.theme = 'dark'
  })
  await page.screenshot({ path: join(artifacts, 'preview-dark.png') })
  await modal.getByRole('button', { name: '重新选择统计范围' }).click()
  await modal.getByRole('button', { name: '近 30 天' }).click()
  await modal.getByRole('button', { name: '直接预览' }).click()
  await modal.locator('.receipt-scene').waitFor()
  const longSvg = decodeURIComponent(await modal.locator('.receipt-scene').getAttribute('src'))
  assert.ok(longSvg.includes('custom-model-23-'))
  await modal.getByRole('button', { name: '复制图片', exact: true }).click()
  await modal.getByRole('status').filter({ hasText: '图片已复制' }).waitFor()
  const longHeight = await application.evaluate(() =>
    globalThis.receiptCopies.at(-1).readUInt32BE(20)
  )
  assert.ok(longHeight > copy.height * 2)
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(640, 440)
  )
  await page.screenshot({ path: join(artifacts, 'preview-small.png') })
  assert.ok(
    await modal
      .locator('.receipt-preview-scroll')
      .evaluate((element) => element.scrollHeight > element.clientHeight)
  )
  assert.ok(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
  await page.keyboard.press('Escape')
  assert.equal(await modal.count(), 0)
  // Natural completion also works without using Skip.
  await page.getByRole('button', { name: '打印小票', exact: true }).click()
  await modal.getByRole('button', { name: '打印我的小票' }).click()
  await modal.locator('.receipt-paper-clip.ready').waitFor()
  await modal.getByRole('button', { name: '撕下', exact: true }).click()
  await modal.locator('.receipt-scene').waitFor()
  await page.keyboard.press('Escape')
  // A strong pull tears while held; WebGL loss retains a usable paper fallback.
  await page.getByRole('button', { name: '打印小票', exact: true }).click()
  await modal.getByRole('button', { name: '打印我的小票' }).click()
  await modal.getByRole('button', { name: '跳过', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.receipt-moving-paper').dataset.renderer === 'mesh'
  )
  const held = await modal.locator('.receipt-moving-paper').boundingBox()
  await page.mouse.move(held.x + held.width / 2, held.y + held.height / 2)
  await page.mouse.down()
  await page.mouse.move(held.x + held.width / 2 + 300, held.y + held.height / 2 + 150, {
    steps: 12
  })
  await modal.locator('.receipt-paper-clip.tearing').waitFor()
  await page.mouse.up()
  await modal.locator('.receipt-scene').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打印小票', exact: true }).click()
  await modal.getByRole('button', { name: '打印我的小票' }).click()
  await modal.getByRole('button', { name: '跳过', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.receipt-moving-paper').dataset.renderer === 'mesh'
  )
  await modal
    .locator('canvas')
    .evaluate((canvas) =>
      canvas.getContext('webgl').getExtension('WEBGL_lose_context').loseContext()
    )
  await page.waitForFunction(
    () => document.querySelector('.receipt-moving-paper').dataset.renderer === 'fallback'
  )
  await modal.getByRole('button', { name: '撕下', exact: true }).click()
  await modal.locator('.receipt-scene').waitFor()
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '打印小票', exact: true }).click()
  await modal.getByRole('button', { name: '打印我的小票' }).click()
  await modal.locator('.receipt-scene').waitFor()
  assert.equal(
    await modal.getByRole('button', { name: '森林' }).getAttribute('aria-pressed'),
    'true'
  )
  assert.equal(await modal.locator('.receipt-print-stage').count(), 0)
  await page.keyboard.press('Escape')
  await application.evaluate(() => {
    globalThis.receiptEmpty = true
  })
  await page.getByRole('button', { name: '打印小票', exact: true }).click()
  await modal.getByRole('button', { name: '直接预览', exact: true }).click()
  await modal.locator('.receipt-scene').waitFor()
  assert.ok(
    decodeURIComponent(await modal.locator('.receipt-scene').getAttribute('src')).includes(
      '此期间暂无已报告用量'
    )
  )
  await modal.getByRole('button', { name: '复制图片', exact: true }).click()
  await modal.getByRole('status').filter({ hasText: '图片已复制' }).waitFor()
  await page.keyboard.press('Escape')
  // Validate the image boundary rejects malformed IPC input.
  assert.match(
    await page.evaluate(async () => {
      try {
        await window.navo.exportUsageReceipt({
          png: 'data:image/png;base64,AAAA',
          action: 'save',
          filename: '../bad.png'
        })
        return ''
      } catch (e) {
        return e.message
      }
    }),
    /小票/
  )
  assert.deepEqual(errors, [])
  console.log(
    '通过：统计失败重试、打印／跳过、拖拽回弹／撕下、双模式、背景记忆、深色／小窗口、减少动态、长小票完整导出、PNG 保存／复制／取消／重试及 IPC 校验。'
  )
} finally {
  if (application) await application.close()
  if (recording) await recording.saveAs(join(artifacts, 'paper-motion.webm'))
  await rm(directory, { recursive: true, force: true })
}
