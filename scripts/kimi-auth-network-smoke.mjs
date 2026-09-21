import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

// No real accounts or external network: the .invalid host is reachable only via this proxy.
const calls = []
const proxy = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
  const path = new URL(req.url).pathname
  if (path === '/redirect') {
    res.writeHead(302, { location: 'http://navo-auth.invalid/unexpected' }).end()
    return
  }
  if (path === '/slow') return
  const data = path.endsWith('/token')
    ? { access_token: 'renewed-test-token', refresh_token: 'renewed-refresh', expires_in: 3600 }
    : path.endsWith('/me')
      ? { user_id: 'proxy-user' }
      : path.endsWith('/models')
        ? { data: [{ id: 'kimi-test' }] }
        : {}
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data))
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const directory = await mkdtemp(join(tmpdir(), 'navo-auth-network-'))
const entry = join(directory, 'main.cjs')
await writeFile(
  entry,
  `
  globalThis.testRequire = require;
  const { app } = require('electron');
  app.setPath('userData', ${JSON.stringify(directory)});
  app.whenReady().then(() => {});
`
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let application
try {
  application = await electron.launch({ args: [entry], env })
  await application.evaluate(
    async ({ app, session }, { root, directory, port }) => {
      await app.whenReady()
      const require = globalThis.testRequire
      const assert = require('node:assert/strict')
      const { metadataRequest } = require(root + '/src/main/services/metadata-request.js')
      const { KimiAuth } = require(root + '/src/main/services/kimi-auth.js')
      const { parseKimiAuth } = require(root + '/src/main/services/kimi-local.js')
      const { GatewayStore } = require(root + '/src/main/services/gateway-store.js')
      await session.defaultSession.setProxy({ proxyRules: `http=127.0.0.1:${port}` })
      await session.defaultSession.cookies.set({
        url: 'http://navo-auth.invalid',
        name: 'unrelated-session',
        value: 'must-not-send'
      })
      // Verify that Node's stack cannot reach the test origin through the session proxy.
      await assert.rejects(
        fetch('http://navo-auth.invalid/me', { signal: AbortSignal.timeout(3000) })
      )
      const store = new GatewayStore(directory + '/gateway.json', {
        encrypt: (s) => Buffer.from(s).toString('base64'),
        decrypt: (s) => Buffer.from(s, 'base64').toString()
      })
      await store.load()
      const request = (input, init) => {
        const url = new URL(String(input))
        return metadataRequest(new URL('http://navo-auth.invalid' + url.pathname), init)
      }
      const service = new KimiAuth(store, request, async () =>
        parseKimiAuth(
          JSON.stringify({
            access_token: 'expired-test-token',
            refresh_token: 'test-refresh',
            expires_at: 1
          }),
          'test-device'
        )
      )
      for (const region of ['mainland-cn', 'global']) await service.importLocal(region)
      assert.equal(store.get().accounts.length, 2)
      assert.ok(
        store.get().accounts.every((a) => a.credential.accessToken === 'renewed-test-token')
      )
      await assert.rejects(
        metadataRequest('http://navo-auth.invalid/redirect', { redirect: 'error' })
      )
      await assert.rejects(
        metadataRequest('http://navo-auth.invalid/slow', {
          signal: AbortSignal.timeout(100)
        })
      )
    },
    { root: resolve('artifacts/tests'), directory, port: proxy.address().port }
  )
  for (const call of calls) assert.equal(call.headers.cookie, undefined)
  const refreshes = calls.filter((call) => call.url.endsWith('/api/oauth/token'))
  assert.equal(refreshes.length, 2)
  for (const call of refreshes) {
    assert.equal(new URLSearchParams(call.body).get('refresh_token'), 'test-refresh')
    assert.equal(call.headers['x-msh-device-id'], 'test-device')
  }
  const profiles = calls.filter((call) => call.url.endsWith('/me'))
  assert.equal(profiles.length, 2)
  for (const call of profiles) assert.equal(call.headers.authorization, 'Bearer renewed-test-token')
  assert.equal(calls.filter((call) => call.url.endsWith('/models')).length, 2)
  assert.equal(calls.filter((call) => call.url.endsWith('/usages')).length, 2)
  assert.equal(
    calls.some((call) => call.url.endsWith('/unexpected')),
    false
  )
  console.log(
    'Kimi network smoke passed: proxy, token refresh, import, cookies, redirects, timeout'
  )
} finally {
  await application?.close()
  proxy.closeAllConnections()
  await new Promise((resolve) => proxy.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
