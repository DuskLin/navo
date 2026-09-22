import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGatewayReader } from '../src/shared/gateway-reader'
import type { GatewayUpdate } from '../src/shared/contracts'

test('价格目录仅首读或版本变化传输，乱序响应仍使用对应版本', async () => {
  const jobs: { version?: number; resolve: (value: GatewayUpdate) => void }[] = []
  const read = createGatewayReader(
    (version) => new Promise((resolve) => jobs.push({ version, resolve }))
  )
  const catalog = (n: number) => ({ entries: [], prices: [], updatedAt: n, error: '' })
  const first = read()
  jobs
    .shift()!
    .resolve({ catalogVersion: 1, modelPriceCatalog: catalog(1) } as unknown as GatewayUpdate)
  assert.equal((await first).modelPriceCatalog.updatedAt, 1)
  const older = read(),
    newer = read()
  const oldJob = jobs.shift()!,
    newJob = jobs.shift()!
  assert.equal(oldJob.version, 1)
  newJob.resolve({ catalogVersion: 2, modelPriceCatalog: catalog(2) } as unknown as GatewayUpdate)
  assert.equal((await newer).modelPriceCatalog.updatedAt, 2)
  oldJob.resolve({ catalogVersion: 1 } as unknown as GatewayUpdate)
  assert.equal((await older).modelPriceCatalog.updatedAt, 1)
  const last = read()
  assert.equal(jobs[0].version, 2)
  jobs.shift()!.resolve({ catalogVersion: 2 } as unknown as GatewayUpdate)
  assert.equal((await last).modelPriceCatalog.updatedAt, 2)
})
