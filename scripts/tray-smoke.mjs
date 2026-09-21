import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, request } from 'node:http'
import { _electron as electron } from 'playwright'

const directory = await mkdtemp(join(tmpdir(), 'kimi-tray-smoke-'))
const entry = join(directory, 'main.cjs')
await writeFile(
  entry,
  `
  const { Tray } = require('electron');
  globalThis.frames = [];
  globalThis.tooltip = '';
  const setImage = Tray.prototype.setImage;
  Tray.prototype.setImage = function(image) {
    globalThis.frames.push(image.toPNG().toString('base64'));
    return setImage.call(this, image);
  };
  const setToolTip = Tray.prototype.setToolTip;
  Tray.prototype.setToolTip = function(text) {
    globalThis.tooltip = text;
    return setToolTip.call(this, text);
  };
  globalThis.fetch = async () => { throw new Error('Offline test'); };
  require('electron').net.fetch = globalThis.fetch;
  require(${JSON.stringify(resolve('out/main/index.js'))});
`
)
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const env = { ...process.env, NAVO_TEST_USER_DATA: directory }
delete env.ELECTRON_RUN_AS_NODE
let application
const requests = []
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Tray state timeout')
}
try {
  application = await electron.launch({ args: [entry], env })
  const page = await application.firstWindow()
  await page.waitForFunction(() => !!window.navo)
  await page.evaluate(async (port) => {
    const snapshot = await window.navo.getGateway()
    await window.navo.saveGateway({ ...snapshot.settings, port })
    await window.navo.setGatewayRunning(true)
  }, port)
  const idle = await application.evaluate(() => globalThis.frames.at(-1))
  for (let index = 0; index < 2; index++) {
    const pending = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' }
    })
    pending.on('error', () => {})
    pending.write('{')
    requests.push(pending)
  }
  await waitFor(() =>
    application.evaluate(
      () => globalThis.tooltip.includes('2 个请求') && new Set(globalThis.frames).size > 4
    )
  )
  const active = await application.evaluate(() => globalThis.frames.at(-1))
  assert.notEqual(active, idle)
  requests[0].destroy()
  await waitFor(() => application.evaluate(() => globalThis.tooltip.includes('1 个请求')))
  requests[1].destroy()
  await waitFor(() => application.evaluate(() => globalThis.tooltip.endsWith('空闲')))
  assert.equal(await application.evaluate(() => globalThis.frames.at(-1)), idle)
  const count = await application.evaluate(() => globalThis.frames.length)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(await application.evaluate(() => globalThis.frames.length), count)
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/tray-idle.png', Buffer.from(idle, 'base64'))
  await writeFile('artifacts/tray-active.png', Buffer.from(active, 'base64'))
  console.log('通过：真实请求触发蓝色流转、并发请求持续动画、断开后恢复白色并停止定时刷新。')
} finally {
  requests.forEach((request) => request.destroy())
  if (application) await application.close()
  await rm(directory, { recursive: true, force: true })
}
