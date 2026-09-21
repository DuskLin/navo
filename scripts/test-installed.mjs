import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, request } from 'playwright'

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'navo-installed-'))
const userData = join(root, 'user data')
const artifacts = resolve('artifacts/installed')
await mkdir(artifacts, { recursive: true })
const errors = []
const logs = []
let application
let executablePath
let uninstaller
let http
const env = { ...process.env, NAVO_TEST_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
// Only upstream transport is substituted. The installed app, preload, IPC,
// encryption, databases, HTTP gateway and packaged resources remain real.
const upstream = createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer installed-test-secret')
  res.setHeader('content-type', 'application/json')
  if (req.url.endsWith('/models')) {
    res.end(JSON.stringify({ data: [{ id: 'deepseek-test' }] }))
  } else if (req.url === '/user/balance') {
    res.end(JSON.stringify({ is_available: true, balance_infos: [] }))
  } else {
    res.end(
      JSON.stringify({
        id: 'installed-completion',
        choices: [{ message: { role: 'assistant', content: 'installed-ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      })
    )
  }
})
await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`

async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}

async function launch() {
  application = await electron.launch({ executablePath, args: [], env, timeout: 60000 })
  application.process().stdout?.on('data', (data) => logs.push(String(data)))
  application.process().stderr?.on('data', (data) => logs.push(String(data)))
  const page = await application.firstWindow({ timeout: 60000 })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '设置', exact: true, includeHidden: true }).waitFor()
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  await application.evaluate(async ({ session, net }, base) => {
    // Services capture fetch during construction; intercept its shared HTTP
    // dispatcher instead of replacing business logic or the saved credentials.
    // Account discovery now uses Electron's network stack; route its metadata
    // requests to the same local upstream as Node's gateway transport.
    session.defaultSession.protocol.handle('https', (request) => {
      const url = new URL(request.url)
      if (url.hostname !== 'api.deepseek.com')
        return net.fetch(request, { bypassCustomProtocolHandlers: true })
      return net.fetch(base + url.pathname + url.search, {
        method: request.method,
        headers: request.headers
      })
    })
    await fetch('data:text/plain,initialize-fetch')
    const key = Symbol.for('undici.globalDispatcher.1')
    const dispatcher = globalThis[key]
    if (!dispatcher?.dispatch) throw new Error('Node HTTP dispatcher is unavailable')
    const dispatch = dispatcher.dispatch.bind(dispatcher)
    dispatcher.dispatch = (options, handler) =>
      dispatch(
        new URL(String(options.origin)).hostname === 'api.deepseek.com'
          ? { ...options, origin: base }
          : options,
        handler
      )
  }, upstreamUrl)
  const welcome = page.getByRole('dialog', { name: '欢迎使用 Navo' })
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: '先体验一下' }).click()
  return page
}

try {
  if (process.env.NAVO_INSTALLED_EXECUTABLE) {
    // Allows the same checks to be exercised locally against an existing package.
    executablePath = resolve(process.env.NAVO_INSTALLED_EXECUTABLE)
  } else {
    assert.ok(['win32', 'linux'].includes(process.platform), 'Use a native Windows/Linux runner')
    const suffix = process.platform === 'win32' ? '.exe' : '.AppImage'
    const candidates = (await readdir('dist')).filter((name) => name.endsWith(suffix))
    assert.equal(candidates.length, 1, 'Expected exactly one native installer')
    const installer = resolve('dist', candidates[0])
    if (process.platform === 'win32') {
      const destination = join(root, 'installed app')
      await run(installer, ['/S', `/D=${destination}`], { timeout: 180000 })
      executablePath = join(destination, 'Navo.exe')
      uninstaller = join(destination, 'Uninstall Navo.exe')
    } else {
      await chmod(installer, 0o755)
      // Launch the actual AppImage through FUSE, not linux-unpacked or extracted files.
      executablePath = installer
    }
  }
  let page = await launch()
  const secure = await application.evaluate(({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null
  }))
  assert.equal(secure.available, true, 'System credential encryption must be available')
  assert.notEqual(secure.backend, 'basic_text', 'Plaintext keyring fallback is forbidden')
  const resources = await application.evaluate(() => process.resourcesPath)
  const binary = join(
    resources,
    'cloudflared',
    process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  )
  const manifest = JSON.parse(await readFile('scripts/cloudflared-manifest.json', 'utf8'))
  assert.ok(
    (await run(binary, ['--version'], { timeout: 15000 })).stdout.includes(manifest.version)
  )
  const port = await freePort()
  await page.evaluate(async (port) => {
    await window.navo.setGatewayRunning(false)
    const state = await window.navo.getGateway()
    await window.navo.saveGateway({ ...state.settings, port, autoStart: true })
    await window.navo.saveAccount({
      name: 'Installed account',
      provider: 'deepseek',
      kind: 'api-key',
      region: 'global',
      enabled: true,
      secret: 'installed-test-secret',
      memberships: [{ groupId: state.groups[0].id, priority: 1, weight: 1 }]
    })
    await window.navo.saveSettings({ theme: 'dark' })
    await window.navo.setGatewayRunning(true)
  }, port)
  assert.ok(
    !(await readFile(join(userData, 'gateway.json'), 'utf8')).includes('installed-test-secret')
  )

  async function completion() {
    await page.evaluate(async () => {
      const state = await window.navo.getGateway()
      await window.navo.copyConnection({ groupId: state.groups[0].id, format: 'key' })
    })
    const key = await application.evaluate(({ clipboard }) => clipboard.readText())
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-test',
        messages: [{ role: 'user', content: 'test' }]
      }),
      signal: AbortSignal.timeout(15000)
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).choices[0].message.content, 'installed-ok')
  }
  await completion()
  await application.close()
  application = undefined
  page = await launch()
  assert.equal((await page.evaluate(() => window.navo.getSettings())).theme, 'dark')
  const restored = await page.evaluate(() => window.navo.getGateway())
  assert.equal(restored.running, true)
  assert.equal(restored.accounts[0].name, 'Installed account')
  assert.equal(restored.accounts[0].hasCredential, true)
  assert.ok((await page.evaluate(() => window.navo.getRequestHistory())).total >= 1)
  await completion() // Proves the saved credential can actually be decrypted after restart.
  const dashboard = await page.evaluate(
    (port) =>
      window.navo.saveDashboard({
        enabled: true,
        lan: false,
        port,
        tunnelMode: 'off',
        hostname: ''
      }),
    await freePort()
  )
  assert.equal(dashboard.running, true)
  http = await request.newContext({ ignoreHTTPSErrors: true })
  const html = await http.get(dashboard.localUrl)
  assert.equal(html.status(), 200)
  const source = await html.text()
  const scripts = [...source.matchAll(/<script[^>]+src="([^"]+)"/g)]
  assert.ok(scripts.length > 0, 'Packaged mobile assets must exist')
  for (const [, asset] of scripts)
    assert.equal((await http.get(new URL(asset, dashboard.localUrl).href)).status(), 200)
  assert.equal((await http.get(new URL('/api/snapshot', dashboard.localUrl).href)).status(), 401)
  await page.screenshot({ path: join(artifacts, 'installed.png') })
  assert.deepEqual(errors, [])
  await writeFile(
    join(artifacts, 'result.json'),
    JSON.stringify({ platform: process.platform, secure, passed: true }, null, 2)
  )
  console.log(
    'Passed: installed app, encrypted credentials, restart, HTTP forwarding, SQLite history, dashboard assets, bundled cloudflared.'
  )
} finally {
  if (application) {
    await application
      .firstWindow()
      .then((page) => page.screenshot({ path: join(artifacts, 'last-window.png') }))
      .catch(() => {})
    await application.close()
  }
  if (http) await http.dispose()
  await writeFile(join(artifacts, 'process.log'), logs.join(''))
  await new Promise((done) => {
    upstream.close(done)
    upstream.closeAllConnections()
  })
  if (uninstaller) await run(uninstaller, ['/S'], { timeout: 120000 })
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
