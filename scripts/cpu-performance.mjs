import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
const require = createRequire(import.meta.url)
const { GatewayStore } = require('../artifacts/tests/src/main/services/gateway-store.js')
const { Gateway } = require('../artifacts/tests/src/main/services/gateway.js')
const {
  createRequestCostCalculator,
  requestCost
} = require('../artifacts/tests/src/shared/request-cost.js')

// 全部为合成数据；不读取或改写安装版配置、凭据和历史。
const directory = await mkdtemp(join(tmpdir(), 'navo-cpu-performance-'))
const store = new GatewayStore(join(directory, 'gateway.json'), {
  encrypt: (s) => Buffer.from(s).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString()
})
const reservation = createServer()
await new Promise((r) => reservation.listen(0, '127.0.0.1', r))
const port = reservation.address().port
await new Promise((r) => reservation.close(r))
const now = Date.now()
const quota = {
  limit: 100,
  remaining: 50,
  used: 50,
  resetAt: new Date(now + 3600000).toISOString()
}
const entries = Array.from({ length: Number(process.env.NAVO_PERF_CATALOG ?? 8000) }, (_, i) => ({
  provider: 'kimi-for-coding',
  providerName: 'Kimi',
  model: `model-${i}`,
  name: `Model ${i}`,
  currency: 'USD',
  input: 1,
  output: 3,
  cacheRead: 0.1,
  cacheWrite: null,
  tiered: false
}))
const record = (i) => ({
  id: String(i),
  accountId: `a${i % 10}`,
  account: `Account ${i % 10}`,
  provider: 'kimi',
  model: `model-${i % 14}`,
  group: '',
  time: now - 60000 + i,
  durationMs: 10,
  firstTokenMs: 1,
  status: 200,
  attempts: 1,
  usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 0, cost: null }
})
let gateway, application
const report = {
  records: Number(process.env.NAVO_PERF_RECORDS ?? 2000),
  catalogEntries: entries.length
}
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]
try {
  await store.mutate((data) => {
    data.settings = { ...data.settings, port, autoStart: false }
    data.accounts = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      name: `Account ${i}`,
      provider: 'kimi',
      kind: 'api-key',
      region: 'mainland-cn',
      enabled: true,
      credential: { accessToken: 'synthetic-key' },
      memberships: [{ groupId: 'default', priority: 0, weight: 1 }],
      maxConcurrency: 10,
      models: ['model-0'],
      capabilities: {
        checkedAt: now,
        models: ['model-0'],
        maxConcurrency: 10,
        warning: '',
        quota: { fiveHour: quota, weekly: quota }
      }
    }))
  })
  await writeFile(store.priceCachePath, JSON.stringify({ version: 4, entries, updatedAt: now }))
  gateway = new Gateway(store, async () => {
    throw new Error('离线性能测试')
  })
  const db = new DatabaseSync(store.historyPath)
  db.exec('BEGIN')
  const insert = db.prepare('INSERT INTO requests (id, record) VALUES (?, ?)')
  for (let i = 0; i < report.records; i++) insert.run(String(i), JSON.stringify(record(i)))
  db.exec('COMMIT')
  db.close()
  await gateway.pricing.load()
  const pricing = gateway.getRequestPricing().value
  const records = Array.from({ length: report.records }, (_, i) => record(i))
  let at = performance.now()
  const before = process.argv.includes('--skip-baseline')
    ? undefined
    : records.map((r) => requestCost(r, pricing))
  if (before) report.originalCalculationMs = performance.now() - at
  at = performance.now()
  const calculate = createRequestCostCalculator(pricing)
  const after = records.map(calculate)
  report.indexedCalculationMs = performance.now() - at
  if (before) assert.deepEqual(after, before)
  await gateway.setRunning(true)
  const snapshots = []
  const cpu = process.cpuUsage()
  at = performance.now()
  for (let i = 0; i < 1000; i++) {
    const t = performance.now()
    const update = gateway.snapshotUpdate(gateway.pricing.revision)
    assert.equal(update.modelPriceCatalog, undefined)
    snapshots.push(performance.now() - t)
  }
  report.snapshotP95Ms = p95(snapshots)
  report.thousandSnapshotsCpuMs =
    Object.values(process.cpuUsage(cpu)).reduce((a, b) => a + b, 0) / 1000
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()
  await store.saveModelPrice({
    provider: 'kimi',
    model: 'model-0',
    currency: 'USD',
    input: 2,
    output: null,
    cacheRead: null,
    cacheWrite: null
  })
  const computing = gateway.snapshotReady()
  const requests = []
  for (let i = 0; i < 30; i++) {
    at = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`)
    assert.equal(response.status, 200)
    await response.text()
    requests.push(performance.now() - at)
  }
  await computing
  lag.disable()
  report.httpP95Ms = p95(requests)
  report.eventLoopP95Ms = lag.percentile(95) / 1e6
  assert.ok(report.snapshotP95Ms < 50)
  assert.ok(report.httpP95Ms < 100)
  await gateway.shutdown()
  gateway.history.close()
  gateway = undefined

  if (process.argv.includes('--electron')) {
    const { _electron: electron } = await import('playwright')
    const entry = join(directory, 'performance-main.cjs')
    await writeFile(
      entry,
      `
      const { safeStorage } = require('electron');
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.encryptString = (s) => Buffer.from(s);
      safeStorage.decryptString = (b) => b.toString();
      globalThis.fetch = async () => { throw new Error('离线性能测试'); };
      require('electron').net.fetch = globalThis.fetch;
      require(${JSON.stringify(resolve('out/main/index.js'))});
    `
    )
    const env = { ...process.env, NAVO_TEST_USER_DATA: directory }
    delete env.ELECTRON_RUN_AS_NODE
    application = await electron.launch({ args: [entry], env })
    application.process().stderr.on('data', (data) => process.stderr.write(data))
    const page = await application.firstWindow()
    await page.waitForFunction(() => !!window.navo)
    await page
      .waitForFunction(
        async () =>
          (await window.navo.getGateway()).accounts.every(
            (a) => a.quotaEstimates?.fiveHour?.amounts.length
          ),
        undefined,
        { timeout: 15000 }
      )
      .catch(async (error) => {
        console.error(
          await page.evaluate(async () =>
            (await window.navo.getGateway()).accounts.map((a) => ({
              id: a.id,
              estimates: a.quotaEstimates
            }))
          )
        )
        throw error
      })
    // 统计真实 Electron 主进程（包括 Worker）的进程 CPU 时间，而非瞬时 ps 数字。
    const measure = async (visible) => {
      await application.evaluate(({ BrowserWindow }, visible) => {
        const w = BrowserWindow.getAllWindows()[0]
        visible ? w.show() : w.hide()
      }, visible)
      await new Promise((r) => setTimeout(r, 1000))
      const start = await application.evaluate(() => ({
        cpu: process.cpuUsage(),
        at: performance.now()
      }))
      await new Promise((r) => setTimeout(r, Number(process.env.NAVO_PERF_SAMPLE_MS ?? 10000)))
      return application.evaluate((_electron, start) => {
        const cpu = process.cpuUsage(start.cpu)
        return {
          cpuPercent: ((cpu.user + cpu.system) / 1000 / (performance.now() - start.at)) * 100,
          memoryMb: process.memoryUsage().rss / 1024 / 1024
        }
      }, start)
    }
    report.electronVisible = await measure(true)
    report.electronHidden = await measure(false)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    assert.equal((await page.evaluate(() => window.navo.getGateway())).accounts.length, 10)
    await application.close()
    application = undefined
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/cpu-performance.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (application) await application.close()
  if (gateway) {
    await gateway.shutdown()
    gateway.history.close()
  }
  await rm(directory, { recursive: true, force: true })
}
