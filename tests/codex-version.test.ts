import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_FALLBACK_VERSION,
  CODEX_VERSION_URL,
  CodexClientVersion
} from '../src/main/services/codex-version'

const SIX_HOURS = 6 * 60 * 60 * 1000
const FIVE_MINUTES = 5 * 60 * 1000
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'navo-codex-version-'))
  return { dir, file: join(dir, 'version.json') }
}

test('官方稳定版本查询合并并发、持久化缓存，重启复用且过期自动刷新', async () => {
  const f = await fixture()
  let now = 1000
  let calls = 0
  let latest = '0.160.0'
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const request: typeof fetch = async (url, init) => {
    calls++
    assert.equal(String(url), CODEX_VERSION_URL)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('chatgpt-account-id'), null)
    assert.equal(init?.redirect, 'error')
    assert.ok(init?.signal)
    await gate
    return Response.json({ name: '@openai/codex', version: latest })
  }
  try {
    const service = new CodexClientVersion(f.file, request, () => now)
    const work = Promise.all([service.get(), service.get(), service.get()])
    release()
    assert.deepEqual(await work, [latest, latest, latest])
    assert.equal(calls, 1)
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), {
      version: 1,
      clientVersion: latest,
      checkedAt: now
    })
    const restarted = new CodexClientVersion(f.file, request, () => now)
    assert.equal(await restarted.get(), latest)
    assert.equal(calls, 1)
    now += SIX_HOURS
    latest = '0.161.0'
    assert.equal(await restarted.get(), latest)
    assert.equal(calls, 2)
    assert.equal(await restarted.get(), latest)
    assert.equal(calls, 2)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('网络失败保留上次成功版本，限制重试频率并在恢复后更新', async () => {
  const f = await fixture()
  let now = 1000
  let calls = 0
  let offline = false
  const request: typeof fetch = async () => {
    calls++
    if (offline) throw new DOMException('timeout', 'TimeoutError')
    return Response.json({ name: '@openai/codex', version: '0.160.0' })
  }
  try {
    const service = new CodexClientVersion(f.file, request, () => now)
    assert.equal(await service.get(), '0.160.0')
    const cache = await readFile(f.file, 'utf8')
    now += SIX_HOURS
    offline = true
    const restarted = new CodexClientVersion(f.file, request, () => now)
    assert.equal(await restarted.get(), '0.160.0')
    assert.equal(calls, 2)
    assert.equal(await restarted.get(), '0.160.0')
    assert.equal(calls, 2)
    assert.equal(await readFile(f.file, 'utf8'), cache)
    now += FIVE_MINUTES
    offline = false
    assert.equal(await restarted.get(), '0.160.0')
    assert.equal(calls, 3)
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).checkedAt, now)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('无缓存、损坏缓存或非法发布元数据回退到内置稳定版本', async () => {
  const f = await fixture()
  try {
    const invalid = [
      { name: '@openai/codex', version: '0.160.0-alpha.1' },
      { name: '@openai/codex', version: '0.160.0-darwin-arm64' },
      { name: '@openai/codex', version: '0.160.0\r\nx: bad' },
      { name: 'other', version: '0.160.0' },
      { name: '@openai/codex', version: 160 },
      null
    ]
    for (const data of invalid) {
      await writeFile(f.file, '{broken')
      const service = new CodexClientVersion(f.file, async () => Response.json(data))
      assert.equal(await service.get(), CODEX_FALLBACK_VERSION)
      assert.equal(await readFile(f.file, 'utf8'), '{broken')
    }
    for (const cache of [
      { version: 1, clientVersion: '0.160.0-alpha.1', checkedAt: 1000 },
      { version: 1, clientVersion: '0.160.0', checkedAt: 2000 },
      { version: 1, clientVersion: '0.160.0', checkedAt: '1000' }
    ]) {
      await writeFile(f.file, JSON.stringify(cache))
      const service = new CodexClientVersion(
        f.file,
        async () => new Response('unavailable', { status: 503 }),
        () => 1000
      )
      assert.equal(await service.get(), CODEX_FALLBACK_VERSION)
    }
    await rm(f.file)
    assert.equal(
      await new CodexClientVersion(f.file, async () => {
        throw new Error('offline')
      }).get(),
      CODEX_FALLBACK_VERSION
    )
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('缓存无法写入时继续使用在线版本与内存缓存，不遗留临时文件', async () => {
  const f = await fixture()
  let calls = 0
  try {
    const service = new CodexClientVersion(f.dir, async () => {
      calls++
      return Response.json({ name: '@openai/codex', version: '0.160.0' })
    })
    assert.equal(await service.get(), '0.160.0')
    assert.equal(await service.get(), '0.160.0')
    assert.equal(calls, 1)
    assert.deepEqual(await readdir(f.dir), [])
    assert.ok(
      !(await readdir(tmpdir())).some((name) => name.startsWith(f.dir.split('/').at(-1)! + '.'))
    )
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
