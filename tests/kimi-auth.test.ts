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
  assert.equal(new Headers(init?.headers).get('x-msh-device-id'), 'device-test')
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
    const gateway = new Gateway(reload, metadata)
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

test('Kimi OAuth gateway forwards native protocols with sealed device headers', async () => {
  const { dir, store } = await fixture()
  const calls: string[] = []
  const request: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer access-secret')
    assert.equal(headers.get('x-msh-device-id'), 'device-test')
    assert.equal(headers.get('user-agent'), 'kimi-code-cli/0.42.0')
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
    for (const route of ['chat/completions', 'messages', 'responses']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'arbitrary-client',
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
    await gateway.refreshAccount(store.get().accounts[0].id)
  } finally {
    await gateway.shutdown()
    gateway.history.close()
    await rm(dir, { recursive: true, force: true })
  }
})
