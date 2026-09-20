import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DashboardServer, validateDashboard } from '../src/main/services/dashboard-server'
import { tunnelCredentials } from '../src/main/services/dashboard-tunnel'
import { dashboardSource } from '../src/main/services/dashboard-source'
import type { Gateway } from '../src/main/services/gateway'
import type { UsageService } from '../src/main/services/usage-service'

test('dashboard validates hostnames and pinned named tunnel credentials', () => {
  const settings = {
    enabled: true,
    lan: true,
    port: 61948,
    tunnelMode: 'named',
    hostname: 'quota.example.com'
  }
  assert.equal(validateDashboard(settings).hostname, 'quota.example.com')
  for (const hostname of [
    'localhost',
    'http://example.com',
    '127.0.0.1',
    'app.local',
    'example.com/path',
    'a..com'
  ])
    assert.throws(() => validateDashboard({ ...settings, hostname }))
  const token = Buffer.from(
    JSON.stringify({
      a: 'a'.repeat(32),
      t: '11111111-2222-3333-4444-555555555555',
      s: Buffer.alloc(32).toString('base64')
    })
  ).toString('base64')
  assert.equal(tunnelCredentials(token).TunnelID, '11111111-2222-3333-4444-555555555555')
  assert.throws(() => tunnelCredentials('not-a-token'))
})

test('dashboard HTTPS authentication, isolation, revocation and request limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navo-dashboard-'))
  const assets = join(directory, 'assets')
  await mkdir(assets)
  await writeFile(join(assets, 'mobile.html'), '<html>Login</html>')
  let reads = 0
  const server = new DashboardServer({
    file: join(directory, 'dashboard.json'),
    assets,
    binary: '/missing/binary',
    codec: {
      encrypt: (v) => Buffer.from(v).toString('base64'),
      decrypt: (v) => Buffer.from(v, 'base64').toString()
    },
    source: async () => {
      reads++
      return {
        accounts: [],
        points: [],
        generatedAt: Date.now(),
        totals: { active: 0, requests: 0, tokens: 0 },
        tunnel: 'off'
      }
    }
  })
  let port = 42000 + Math.floor(Math.random() * 10000)
  try {
    await server.load()
    assert.equal(server.state().running, false)
    for (let i = 0; i < 10; i++) {
      await server.save({ enabled: true, lan: true, port, tunnelMode: 'off', hostname: '' })
      if (server.state().running) break
      port += 2
    }
    assert.equal(server.state().running, true)
    const origin = `https://localhost:${port}`
    function call(
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
      plain = false
    ) {
      return new Promise<{
        status: number
        headers: import('node:http').IncomingHttpHeaders
        body: string
      }>((resolve, reject) => {
        const request = (plain ? httpRequest : httpsRequest)(
          {
            hostname: '127.0.0.1',
            port: plain ? port + 1 : port,
            path,
            method,
            rejectUnauthorized: false,
            headers: {
              host: `localhost:${port}`,
              ...(body ? { origin, 'content-type': 'application/json' } : {}),
              ...headers
            }
          },
          (response) => {
            let data = ''
            response.on('data', (chunk) => {
              data += chunk
            })
            response.on('end', () =>
              resolve({ status: response.statusCode!, headers: response.headers, body: data })
            )
          }
        )
        request.on('error', reject)
        request.end(body === undefined ? undefined : JSON.stringify(body))
      })
    }
    assert.equal((await call('/')).status, 200)
    assert.equal(
      (await call('/', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status,
      200
    )
    assert.equal((await call('/api/snapshot')).status, 401)
    assert.equal(reads, 0)
    assert.equal((await call('/api/snapshot', 'GET', undefined, {}, true)).status, 403)
    server.tunnel.url = 'https://quota.example.com'
    const publicHeaders = {
      host: 'quota.example.com',
      origin: 'https://quota.example.com',
      'x-forwarded-proto': 'https'
    }
    assert.equal((await call('/api/snapshot', 'GET', undefined, publicHeaders, true)).status, 401)
    const publicLogin = await call(
      '/api/login',
      'POST',
      { code: server.accessCode() },
      publicHeaders,
      true
    )
    assert.equal(publicLogin.status, 200)
    const publicCookie = publicLogin.headers['set-cookie']![0].split(';')[0]
    assert.equal(
      (
        await call(
          '/api/snapshot',
          'GET',
          undefined,
          { ...publicHeaders, cookie: publicCookie },
          true
        )
      ).status,
      200
    )
    assert.equal(
      (await call('/api/snapshot', 'GET', undefined, { cookie: publicCookie })).status,
      401
    )
    assert.equal(
      (
        await call(
          '/api/snapshot',
          'GET',
          undefined,
          { ...publicHeaders, 'x-forwarded-proto': 'http', cookie: publicCookie },
          true
        )
      ).status,
      403
    )
    server.tunnel.url = ''
    assert.equal(
      (
        await call(
          '/api/login',
          'POST',
          { code: server.accessCode() },
          { origin: 'https://evil.example' }
        )
      ).status,
      403
    )
    assert.equal(
      (
        await call(
          '/api/login',
          'POST',
          { code: server.accessCode() },
          { host: 'evil.example', origin: 'https://evil.example' }
        )
      ).status,
      403
    )
    assert.equal((await call('/api/login', 'POST', { code: 'incorrect' })).status, 401)
    const login = await call('/api/login', 'POST', { code: server.accessCode() })
    assert.equal(login.status, 200)
    const fullCookie = login.headers['set-cookie']![0]
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
      assert.ok(fullCookie.includes(flag))
    const cookie = fullCookie.split(';')[0]
    const snapshot = await call('/api/snapshot', 'GET', undefined, { cookie })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.headers['cache-control'], 'no-store')
    assert.equal(snapshot.headers['access-control-allow-origin'], undefined)
    assert.equal(
      (await call('/api/snapshot', 'GET', undefined, { cookie, origin: 'https://evil.example' }))
        .status,
      403
    )
    for (const path of [
      '/v1/models',
      '/v1/chat/completions',
      '/gateway.json',
      '/assets/../../dashboard.json',
      '/assets/main.js.map'
    ])
      assert.equal((await call(path, 'GET', undefined, { cookie })).status, 404)
    assert.equal((await call('/api/account/delete', 'POST', {}, { cookie })).status, 404)
    await server.rotate()
    assert.equal((await call('/api/snapshot', 'GET', undefined, { cookie })).status, 401)
    const logged = await call('/api/login', 'POST', { code: server.accessCode() })
    const nextCookie = logged.headers['set-cookie']![0].split(';')[0]
    assert.equal((await call('/api/logout', 'POST', {}, { cookie: nextCookie })).status, 200)
    assert.equal(
      (await call('/api/snapshot', 'GET', undefined, { cookie: nextCookie })).status,
      401
    )
    let result = 0
    for (let i = 0; i < 10; i++) result = (await call('/api/login', 'POST', { code: 'bad' })).status
    assert.equal(result, 429)
    const saved = await readFile(join(directory, 'dashboard.json'), 'utf8')
    assert.ok(!saved.includes(server.accessCode()))
    assert.ok(!JSON.stringify(server.state()).includes(server.accessCode()))
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('dashboard source projects only safe data and preserves user account names', async () => {
  const now = Date.now()
  const account = {
    id: 'account-1',
    name: '用户的账号名',
    enabled: true,
    provider: 'kimi',
    credential: { accessToken: 'SENTINEL_SECRET' },
    baseUrl: 'SENTINEL_INTERNAL',
    capabilities: {
      checkedAt: now,
      warning: 'SENTINEL_PROVIDER_ERROR',
      quota: {
        fiveHour: {
          limit: 100,
          used: 20,
          remaining: 80,
          resetAt: new Date(now + 3600000).toISOString()
        },
        weekly: null,
        total: null,
        totalUnlimited: false
      }
    }
  }
  const gateway = {
    store: { get: () => ({ accounts: [account], quotaCardOrder: ['account-1'] }) },
    scheduler: { state: () => ({ active: 2, authFailed: false }) }
  } as unknown as Gateway
  const usage = {
    usage: async () => ({
      accountTotals: [{ accountId: 'account-1', requests: 3, totalTokens: 120 }],
      summary: { requests: 3, totalTokens: 120 },
      points: []
    })
  } as unknown as UsageService
  const source = dashboardSource(gateway, usage)
  const result = await source()
  assert.equal(result.accounts[0].name, account.name)
  assert.equal(result.accounts[0].quota?.fiveHour?.remaining, 80)
  assert.equal(result.accounts[0].requests, 3)
  assert.equal(result.accounts[0].status, 'available')
  assert.ok(!JSON.stringify(result).includes('SENTINEL'))
  assert.throws(() => source('unknown'))
  for (const [provider, label] of Object.entries({
    kimi: 'Kimi',
    deepseek: 'DeepSeek',
    'opencode-go': 'Go',
    codex: 'Codex'
  })) {
    account.provider = provider
    const mapped = await dashboardSource(gateway, usage)()
    assert.equal(mapped.accounts[0].provider, label)
    assert.ok(!JSON.stringify(mapped).includes('SENTINEL'))
  }
})
