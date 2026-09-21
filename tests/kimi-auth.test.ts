import { isKimiUserAgent, requiresKimiUserAgent } from '../src/shared/kimi-client-policy'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KimiAuth, kimiHeaders } from '../src/main/services/kimi-auth'
import { parseKimiAuth, readLocalKimiAuth } from '../src/main/services/kimi-local'
import { GatewayStore } from '../src/main/services/gateway-store'
import { Gateway } from '../src/main/services/gateway'

const auth = (access = 'access-secret', expires = Date.now() / 1000 + 3600) =>
  JSON.stringify({ access_token: access, refresh_token: 'refresh-secret', expires_at: expires })
const codec = {
  encrypt: (s: string) => Buffer.from(s).toString('base64'),
  decrypt: (s: string) => Buffer.from(s, 'base64').toString()
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'navo-kimi-auth-'))
  const store = new GatewayStore(join(dir, 'gateway.json'), codec)
  await store.load()
  return { dir, store }
}
const metadata: typeof fetch = async (url, init) => {
  const headers = new Headers(init?.headers)
  assert.equal(headers.get('x-msh-device-id'), 'device-test')
  assert.equal(headers.get('user-agent'), null)
  assert.equal(headers.get('x-msh-platform'), null)
  assert.equal(headers.get('x-msh-version'), null)
  if (String(url).endsWith('/me')) return Response.json({ user_id: 'user-test' })
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'kimi-test' }] })
  return Response.json({})
}

test('local Kimi parsing rejects invalid credentials without leaking secrets', () => {
  assert.equal(parseKimiAuth(auth(), 'device-test').kimiOAuth, true)
  for (const raw of ['{"secret":"do-not-leak"', auth('token\nsecret'), auth('valid', NaN)]) {
    assert.throws(() => parseKimiAuth(raw, 'device-test'), /本地 Kimi 登录凭据格式无效/)
  }
  assert.throws(() => parseKimiAuth(auth(), 'device\r\nheader'), /格式无效/)
})

test('local Kimi credentials use the configured directory and device identity', async () => {
  const { dir } = await fixture()
  try {
    await mkdir(join(dir, 'credentials'))
    await writeFile(join(dir, 'credentials/kimi-code.json'), auth())
    await writeFile(join(dir, 'device_id'), 'device-test\n')
    const local = await readLocalKimiAuth([dir], async () => {
      throw new Error('must not read keychain')
    })
    assert.equal(local.deviceId, 'device-test')
    assert.equal(local.accessToken, 'access-secret')
    await writeFile(join(dir, 'credentials/kimi-code.json'), 'invalid-secret')
    await assert.rejects(readLocalKimiAuth([dir]), /格式无效/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Kimi import deduplicates, preserves edits and survives encrypted storage reload', async () => {
  const { dir, store } = await fixture()
  let gateway: Gateway | undefined
  try {
    const service = new KimiAuth(store, metadata, async () => parseKimiAuth(auth(), 'device-test'))
    const id = await service.importLocal('mainland-cn')
    await store.mutate((data) => {
      data.accounts[0].name = '我的账号'
      data.accounts[0].enabled = false
    })
    assert.equal(await service.importLocal('mainland-cn'), id)
    assert.equal(store.get().accounts.length, 1)
    assert.equal(store.get().accounts[0].name, '我的账号')
    assert.equal(store.get().accounts[0].enabled, false)
    const reload = new GatewayStore(join(dir, 'gateway.json'), codec)
    await reload.load()
    assert.deepEqual(reload.get().accounts[0].credential, store.get().accounts[0].credential)
    assert.equal(reload.get().accounts[0].kind, 'oauth')
    gateway = new Gateway(reload, metadata)
    const snapshot = gateway.snapshot()
    assert.equal(JSON.stringify(snapshot).includes('access-secret'), false)
    assert.equal(JSON.stringify(snapshot).includes('refresh-secret'), false)
    await gateway.saveAccount({ ...snapshot.accounts[0], name: '新名称' })
    await assert.rejects(gateway.saveAccount({ ...snapshot.accounts[0], region: 'global' }), /导入/)
    await assert.rejects(
      gateway.saveAccount({ ...snapshot.accounts[0], secret: 'new-secret' }),
      /导入/
    )
  } finally {
    gateway?.history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Kimi concurrent expiry refresh rotates once and stores new tokens', async () => {
  const { dir, store } = await fixture()
  try {
    let refreshes = 0
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/api/oauth/token')) {
        refreshes++
        assert.equal(String(url), 'https://auth.kimi.ai/api/oauth/token')
        const form = new URLSearchParams(String(init?.body))
        assert.equal(form.get('grant_type'), 'refresh_token')
        assert.equal(form.get('refresh_token'), 'refresh-secret')
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600
        })
      }
      return metadata(url, init)
    }
    const service = new KimiAuth(store, request, async () => parseKimiAuth(auth(), 'device-test'))
    const id = await service.importLocal('global')
    await store.mutate((data) => {
      data.accounts[0].credential.expiresAt = 1
    })
    const credentials = await Promise.all([
      service.credential(id),
      service.credential(id),
      service.credential(id)
    ])
    assert.equal(refreshes, 1)
    assert.ok(credentials.every((c) => c.accessToken === 'new-access'))
    assert.equal(store.get().accounts[0].credential.refreshToken, 'new-refresh')
    assert.equal(await service.importLocal('global'), id)
    assert.equal(store.get().accounts[0].credential.refreshToken, 'new-refresh')
    assert.equal(refreshes, 1)
    assert.equal(kimiHeaders(credentials[0])['x-msh-device-id'], 'device-test')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Kimi reuses a newer local login only when the profile identity matches', async () => {
  const { dir, store } = await fixture()
  try {
    let raw = auth()
    const service = new KimiAuth(store, metadata, async () => parseKimiAuth(raw, 'device-test'))
    const id = await service.importLocal('mainland-cn')
    raw = auth('local-new-access')
    await store.mutate((data) => {
      data.accounts[0].credential.expiresAt = 1
    })
    assert.equal((await service.credential(id)).accessToken, 'local-new-access')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Kimi failed import does not save partial account or expose upstream body', async () => {
  const { dir, store } = await fixture()
  try {
    const service = new KimiAuth(
      store,
      async () => new Response('secret upstream', { status: 401 }),
      async () => parseKimiAuth(auth(), 'device-test')
    )
    await assert.rejects(
      service.importLocal('mainland-cn'),
      (e) => e instanceof Error && e.message.includes('401') && !e.message.includes('secret')
    )
    assert.equal(store.get().accounts.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Kimi transport failures give safe diagnostics and allow import retry', async () => {
  const { dir, store } = await fixture()
  try {
    const failures: [Error, RegExp][] = [
      [new DOMException('secret-url', 'TimeoutError'), /请求超时/],
      [new Error('net::ERR_PROXY_CONNECTION_FAILED secret-token'), /系统代理连接失败/],
      [new Error('net::ERR_CERT_AUTHORITY_INVALID secret-token'), /证书校验失败/],
      [new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }), /请求超时/],
      [new Error('secret-token'), /网络和系统代理/]
    ]
    for (const [failure, expected] of failures) {
      let fail = true
      const service = new KimiAuth(
        store,
        async (url, init) => {
          if (fail) throw failure
          return metadata(url, init)
        },
        async () => parseKimiAuth(auth(), 'device-test')
      )
      await assert.rejects(service.importLocal('mainland-cn'), (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, expected)
        assert.doesNotMatch(error.message, /secret/)
        return true
      })
      fail = false
      await service.importLocal('mainland-cn')
      assert.equal(store.get().accounts.length, 1)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Kimi OAuth gateway forwards native protocols with sealed device headers', async () => {
  const { dir, store } = await fixture()
  const calls: string[] = []
  let expectedUA = 'KimiCLI/1.6'
  let expectedOAuth = true
  const request: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer access-secret')
    assert.equal(headers.get('x-msh-device-id'), expectedOAuth ? 'device-test' : null)
    assert.equal(headers.get('user-agent'), expectedUA)
    assert.equal(headers.get('x-msh-platform'), null)
    assert.equal(headers.get('x-msh-version'), null)
    calls.push(String(url))
    return Response.json({
      id: 'test',
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    })
  }
  const gateway = new Gateway(store, request, metadata, async () => Response.json({}))
  try {
    await new KimiAuth(store, metadata, async () =>
      parseKimiAuth(auth(), 'device-test')
    ).importLocal('mainland-cn')
    const { createServer } = await import('node:net')
    const reserved = createServer()
    await new Promise<void>((resolve) => reserved.listen(0, '127.0.0.1', resolve))
    const port = (reserved.address() as { port: number }).port
    await new Promise<void>((resolve, reject) => reserved.close((e) => (e ? reject(e) : resolve())))
    await gateway.saveSettings({ ...store.get().settings, port })
    await gateway.setRunning(true)
    const oauthId = store.get().accounts[0].id
    await assert.rejects(
      gateway.testAccountModel({
        id: oauthId,
        provider: 'kimi',
        region: 'mainland-cn',
        model: 'kimi-test',
        protocol: 'chat-completions'
      }),
      /仅允许 Kimi UA/
    )
    const post = (ua?: string) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ua !== undefined ? { 'user-agent': ua } : {}),
          'x-msh-platform': 'kimi_code_cli'
        },
        body: JSON.stringify({ model: 'kimi-test', messages: [{ role: 'user', content: 'hello' }] })
      })
    for (const ua of [undefined, '', 'arbitrary-client', 'not-kimi/1.0', 'curl/1.0 KimiCLI/1.6']) {
      const rejected = await post(ua)
      assert.equal(rejected.status, 403)
      assert.match(await rejected.text(), /Kimi User-Agent/)
    }
    assert.equal(calls.length, 0)
    for (const route of ['chat/completions', 'messages', 'responses']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': expectedUA,
          'x-msh-device-id': 'untrusted-device'
        },
        body: JSON.stringify({
          model: 'kimi-test',
          messages: [{ role: 'user', content: 'hello' }],
          input: 'hello',
          max_tokens: 16
        })
      })
      assert.equal(response.status, 200)
      await response.arrayBuffer()
    }
    assert.deepEqual(calls, [
      'https://api.kimi.com/coding/v1/chat/completions',
      'https://api.kimi.com/coding/v1/messages',
      'https://api.kimi.com/coding/v1/responses'
    ])
    await gateway.refreshAccount(oauthId)
    await gateway.saveAccount({ ...gateway.snapshot().accounts[0], kimiOAuthOnly: false })
    expectedUA = 'arbitrary-client'
    const allowed = await post(expectedUA)
    assert.equal(allowed.status, 200)
    await allowed.arrayBuffer()
    await new KimiAuth(store, metadata, async () =>
      parseKimiAuth(auth(), 'device-test')
    ).importLocal('mainland-cn')
    assert.equal(store.get().accounts[0].kimiOAuthOnly, false)
    const reload = new GatewayStore(join(dir, 'gateway.json'), codec)
    await reload.load()
    assert.equal(reload.get().accounts[0].kimiOAuthOnly, false)
    await gateway.saveAccount({ ...gateway.snapshot().accounts[0], kimiOAuthOnly: true })
    const blockedAgain = await post(expectedUA)
    assert.equal(blockedAgain.status, 403)
    await blockedAgain.arrayBuffer()
    // A sticky binding to the OAuth account cannot bypass the gate; an API key can still serve it.
    await store.mutate((data) => {
      data.accounts.push({
        ...data.accounts[0],
        id: 'api-account',
        kind: 'api-key',
        credential: { accessToken: 'access-secret' }
      })
    })
    expectedOAuth = false
    const fallback = await post(expectedUA)
    assert.equal(fallback.status, 200)
    await fallback.arrayBuffer()
  } finally {
    await gateway.shutdown()
    gateway.history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Kimi UA gate defaults on only for Kimi OAuth and matches client product names', () => {
  for (const ua of [
    'KimiCLI/1.6',
    'kimi-code-cli/0.42.0',
    'kimi-code-desktop/1.0 (macOS)',
    'kimi-code-vscode/2.0'
  ])
    assert.equal(isKimiUserAgent(ua), true)
  for (const ua of [undefined, '', 'Kimi', 'not-kimi/1', 'kimi-fake/1', 'curl/1 KimiCLI/1.6'])
    assert.equal(isKimiUserAgent(ua), false)
  assert.equal(requiresKimiUserAgent({ provider: 'kimi', kind: 'oauth' }), true)
  assert.equal(
    requiresKimiUserAgent({ provider: 'kimi', kind: 'oauth', kimiOAuthOnly: false }),
    false
  )
  assert.equal(requiresKimiUserAgent({ provider: 'kimi', kind: 'api-key' }), false)
  assert.equal(requiresKimiUserAgent({ provider: 'codex', kind: 'oauth' }), false)
})
