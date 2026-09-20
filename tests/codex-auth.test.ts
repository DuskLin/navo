import { parseCodexQuota } from '../src/shared/codex-quota'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import {
  CodexAuth,
  parseCodexAuth,
  codexRequest,
  sameCodexAccount
} from '../src/main/services/codex-auth'
import { readLocalCodexAuth } from '../src/main/services/codex-local'
import { GatewayStore } from '../src/main/services/gateway-store'
import { Gateway } from '../src/main/services/gateway'

const jwt = (exp = Math.floor(Date.now() / 1000) + 3600) =>
  'test.' +
  Buffer.from(
    JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })
  ).toString('base64url') +
  '.signature'
const auth = (access = jwt()) =>
  JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: access, refresh_token: 'refresh-secret', account_id: 'account-test' }
  })
const models: typeof fetch = async () =>
  Response.json({
    models: [
      { slug: 'gpt-test', supported_in_api: true },
      { slug: 'hidden', supported_in_api: false }
    ]
  })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'navo-codex-'))
  // 测试编码器仅用于检查完整存储往返；生产使用 Electron safeStorage。
  const codec = {
    encrypt: (s: string) => Buffer.from(s).toString('base64'),
    decrypt: (s: string) => Buffer.from(s, 'base64').toString()
  }
  const file = join(dir, 'gateway.json')
  const store = new GatewayStore(file, codec)
  await store.load()
  await writeFile(join(dir, 'auth.json'), auth())
  return { dir, file, codec, store }
}
test('Codex 认证解析兼容账号 claim，不在错误中暴露令牌', () => {
  const credential = parseCodexAuth(auth())
  assert.equal(credential.accountId, 'account-test')
  assert.equal(credential.refreshToken, 'refresh-secret')
  assert.ok(credential.expiresAt! > Date.now())
  assert.equal(
    parseCodexAuth(JSON.stringify({ tokens: { access_token: jwt() } })).accountId,
    'account-test'
  )
  assert.throws(
    () => parseCodexAuth('{"secret":"sensitive-token"'),
    (e) => e instanceof Error && !e.message.includes('sensitive-token')
  )
  assert.throws(() => parseCodexAuth('{"auth_mode":"apikey","OPENAI_API_KEY":"secret"}'), /ChatGPT/)
  assert.throws(
    () => parseCodexAuth(JSON.stringify({ tokens: { access_token: 'a\r\nb', account_id: 'id' } })),
    /格式无效/
  )
})
test('Codex 请求保留工具与推理，规范化无状态流式请求', () => {
  const body = {
    model: 'gpt-test',
    input: 'hello',
    stream: false,
    store: true,
    max_output_tokens: 99,
    reasoning: { effort: 'high' },
    tools: [{ type: 'function', name: 'tool' }]
  }
  const result = codexRequest(body)
  assert.equal(result.stream, true)
  assert.equal(result.store, false)
  assert.equal(result.instructions, '')
  assert.equal(result.max_output_tokens, undefined)
  assert.deepEqual(result.reasoning, body.reasoning)
  assert.deepEqual(result.tools, body.tools)
  assert.ok(Array.isArray(result.input))
  assert.equal(body.stream, false)
  assert.throws(() => codexRequest({ previous_response_id: 'resp-test' }), /完整历史/)
})
test('本地导入去重、保留设置、重启恢复 OAuth 且快照不含凭据', async () => {
  const f = await fixture()
  const gateway = new Gateway(f.store, models, models, models)
  try {
    const service = new CodexAuth(f.store, models, f.dir)
    const importedId = await service.importLocal()
    const first = f.store.get().accounts[0]
    assert.equal(importedId, first.id)
    await gateway.saveAccount({
      ...gateway.snapshot().accounts[0],
      name: '工作账号',
      manualModels: ['gpt-manual'],
      enabled: false,
      concurrencyOverride: 3
    })
    await service.importLocal()
    assert.equal(f.store.get().accounts.length, 1)
    assert.equal(f.store.get().accounts[0].id, first.id)
    assert.equal(f.store.get().accounts[0].name, '工作账号')
    assert.equal(f.store.get().accounts[0].enabled, false)
    assert.equal(f.store.get().accounts[0].maxConcurrency, 3)
    const loaded = new GatewayStore(f.file, f.codec)
    await loaded.load()
    assert.equal(loaded.get().accounts[0].kind, 'oauth')
    assert.equal(loaded.get().accounts[0].credential.refreshToken, 'refresh-secret')
    assert.deepEqual(loaded.get().accounts[0].models, ['gpt-test', 'hidden', 'gpt-manual'])
    assert.ok(!JSON.stringify(gateway.snapshot()).includes('refresh-secret'))
    assert.ok(!JSON.stringify(gateway.snapshot()).includes(first.credential.accessToken))
    assert.ok(!(await readFile(f.file, 'utf8')).includes('refresh-secret'))
    await assert.rejects(
      new CodexAuth(f.store, models, join(f.dir, 'missing')).importLocal(),
      /无法读取/
    )
  } finally {
    await gateway.shutdown()
    gateway.history.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})
test('并发刷新只发送一次请求并保存轮换的刷新令牌', async () => {
  const f = await fixture()
  try {
    const service = new CodexAuth(f.store, models, f.dir)
    await service.importLocal()
    const id = f.store.get().accounts[0].id
    await f.store.mutate((data) => {
      data.accounts[0].credential.expiresAt = 1
    })
    await rm(join(f.dir, 'auth.json'))
    let calls = 0
    const refresh: typeof fetch = async (url, init) => {
      calls++
      assert.equal(String(url), 'https://auth.openai.com/oauth/token')
      assert.equal(JSON.parse(String(init?.body)).refresh_token, 'refresh-secret')
      return Response.json({
        access_token: jwt(),
        refresh_token: 'rotated-secret',
        expires_in: 3600
      })
    }
    const renewing = new CodexAuth(f.store, refresh, f.dir)
    await Promise.all([renewing.credential(id), renewing.credential(id), renewing.credential(id)])
    assert.equal(calls, 1)
    assert.equal(f.store.get().accounts[0].credential.refreshToken, 'rotated-secret')
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
test('Codex 网关三协议转发、非流式原始响应与流式透传', async () => {
  const f = await fixture()
  const completed = {
    id: 'resp-test',
    object: 'response',
    model: 'gpt-test',
    status: 'completed',
    output: [
      {
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '你好', annotations: [] }]
      }
    ],
    usage: { input_tokens: 5, output_tokens: 2 },
    custom_field: 'preserved'
  }
  const events = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`
  let calls = 0
  const request: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('chatgpt-account-id'), 'account-test')
    assert.ok(headers.get('authorization')?.startsWith('Bearer test.'))
    assert.equal(headers.get('accept'), 'text/event-stream')
    const payload = JSON.parse(Buffer.from(init?.body as Uint8Array).toString())
    assert.equal(payload.model, 'gpt-manual')
    assert.equal(payload.stream, true)
    assert.equal(payload.store, false)
    assert.equal(typeof payload.instructions, 'string')
    calls++
    return new Response(events, { headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = new Gateway(f.store, request, models, models)
  try {
    await new CodexAuth(f.store, models, f.dir).importLocal()
    await gateway.saveAccount({ ...gateway.snapshot().accounts[0], manualModels: ['gpt-manual'] })
    const reserved = createServer()
    await new Promise<void>((resolve) => reserved.listen(0, '127.0.0.1', resolve))
    const port = (reserved.address() as { port: number }).port
    await new Promise<void>((resolve, reject) => reserved.close((e) => (e ? reject(e) : resolve())))
    await gateway.saveSettings({ ...f.store.get().settings, port })
    await gateway.setRunning(true)
    const catalog = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()
    assert.ok(catalog.data.some((model: { id: string }) => model.id === 'gpt-manual'))
    for (const route of ['responses', 'chat/completions', 'messages']) {
      const body =
        route === 'responses'
          ? { input: 'hello' }
          : { messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }
      const response = await fetch(`http://127.0.0.1:${port}/v1/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-manual', ...body })
      })
      assert.equal(response.status, 200)
      const result = await response.json()
      if (route === 'responses') assert.deepEqual(result, completed)
      else if (route === 'messages') assert.equal(result.content[0].text, '你好')
      else assert.equal(result.choices[0].message.content, '你好')
    }
    const stream = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-manual', input: 'hi', stream: true })
    })
    assert.equal(await stream.text(), events)
    assert.equal(calls, 4)
  } finally {
    await gateway.shutdown()
    gateway.history.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('默认目录读取钥匙串，自定义目录隔离账号并从文件读取', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const keychain = async () => {
      calls++
      return auth()
    }
    assert.equal(await readLocalCodexAuth(join(homedir(), '.codex'), keychain), auth())
    assert.equal(calls, 1)
    assert.equal(
      await readLocalCodexAuth(f.dir, keychain),
      await readFile(join(f.dir, 'auth.json'), 'utf8')
    )
    assert.equal(calls, 1)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('同一工作区不同用户不得去重或采纳对方令牌', () => {
  const base = { accessToken: 'old', refreshToken: 'same', accountId: 'workspace' }
  assert.equal(sameCodexAccount({ ...base, userId: 'alice' }, { ...base, userId: 'bob' }), false)
  assert.equal(
    sameCodexAccount(
      { ...base, userId: 'alice' },
      { ...base, userId: 'alice', refreshToken: 'rotated', accessToken: 'new' }
    ),
    true
  )
  assert.equal(
    sameCodexAccount(base, { ...base, refreshToken: 'other', accessToken: 'other' }),
    false
  )
})

test('Codex 额度按实际窗口归类，支持零用量、月窗口和重置时间', () => {
  const window = (seconds: number, used: number) => ({
    limit_window_seconds: seconds,
    used_percent: used,
    reset_at: 1893456000
  })
  const quota = parseCodexQuota({
    rate_limit: { primary_window: window(604800, 30), secondary_window: window(18000, 0) }
  })!
  assert.equal(quota.fiveHour?.remaining, 100)
  assert.equal(quota.weekly?.remaining, 70)
  assert.equal(quota.weekly?.resetAt, '2030-01-01T00:00:00.000Z')
  assert.equal(quota.unit, 'percent')
  assert.equal(
    parseCodexQuota({ rate_limit: { primary_window: window(2592000, 101) } })?.monthly?.remaining,
    0
  )
  assert.equal(
    parseCodexQuota(
      {
        rate_limit: {
          primary_window: { limit_window_seconds: 18000, used_percent: 20, reset_after_seconds: 60 }
        }
      },
      1000
    )?.fiveHour?.resetAt,
    '1970-01-01T00:01:01.000Z'
  )
  for (const value of [
    null,
    {},
    { rate_limit: { primary_window: window(123, 20) } },
    { rate_limit: { primary_window: window(18000, NaN) } },
    { rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: null } } }
  ])
    assert.equal(parseCodexQuota(value), null)
})

test('Codex 额度同步与持久化，接口失败保留旧值和真实采集时间', async () => {
  const f = await fixture()
  let status = 200
  const request: typeof fetch = async (url, init) => {
    if (!String(url).endsWith('/wham/usage')) return models(url, init)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('chatgpt-account-id'), 'account-test')
    assert.equal(headers.get('accept'), 'application/json')
    if (status !== 200) return new Response('sensitive-response', { status })
    return Response.json({
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: 25, reset_at: 1893456000 },
        secondary_window: { limit_window_seconds: 604800, used_percent: 40, reset_at: 1893456000 }
      }
    })
  }
  const service = new CodexAuth(f.store, request, f.dir)
  const gateway = new Gateway(f.store, request, request, request)
  try {
    const id = await service.importLocal()
    const checkedAt = f.store.get().accounts[0].capabilities!.checkedAt
    assert.equal(f.store.get().accounts[0].capabilities?.quota?.fiveHour?.remaining, 75)
    const restored = new GatewayStore(f.file, f.codec)
    await restored.load()
    assert.equal(restored.get().accounts[0].capabilities?.quota?.weekly?.remaining, 60)
    for (status of [429, 401, 403, 500]) {
      await gateway.refreshAccount(id)
      const caps = f.store.get().accounts[0].capabilities!
      assert.equal(caps.quota?.fiveHour?.remaining, 75)
      assert.equal(caps.checkedAt, checkedAt)
      assert.ok(caps.warning.includes(String(status)))
      assert.ok(!caps.warning.includes('sensitive-response'))
    }
    await service.importLocal()
    assert.equal(f.store.get().accounts[0].capabilities?.checkedAt, checkedAt)
    status = 200
    await gateway.refreshAccount(id)
    assert.equal(f.store.get().accounts[0].capabilities?.warning, '')
  } finally {
    await gateway.shutdown()
    gateway.history.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})
