import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseRegistryCapabilities,
  mergeRegistryCapabilities
} from '../src/main/services/registry-capabilities'
import { ModelPriceCatalog, parseCatalogEntries } from '../src/main/services/model-price-catalog'
import { registryModels } from '../src/main/services/model-registry'

const metadata = {
  name: 'Kimi K3',
  reasoning: true,
  tool_call: true,
  reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
  modalities: { input: ['text', 'image', 'video'], output: ['text'] }
}
const payload = { 'kimi-for-coding': { models: { k3: metadata } } }

test('registry exports catalog reasoning efforts and image/video capabilities alongside tool use', () => {
  const model = registryModels(
    [{ provider: 'kimi', models: ['k3'] }],
    parseCatalogEntries(payload),
    []
  ).k3
  assert.equal(model.default_effort, undefined)
  assert.deepEqual(model, {
    id: 'k3',
    name: 'Kimi K3',
    reasoning: true,
    tool_call: true,
    support_efforts: ['low', 'high', 'max'],
    modalities: { input: ['text', 'image', 'video'], output: ['text'] }
  })
})

test('missing, disabled and malformed capabilities do not invent effort levels or modalities', () => {
  assert.equal(parseRegistryCapabilities({}), undefined)
  assert.deepEqual(
    parseRegistryCapabilities({ reasoning: true, reasoning_options: [{ type: 'toggle' }] }),
    { reasoning: true }
  )
  assert.deepEqual(
    parseRegistryCapabilities({
      reasoning: false,
      tool_call: false,
      support_efforts: ['high'],
      default_effort: 'high'
    }),
    { reasoning: false, tool_call: false }
  )
  assert.equal(
    parseRegistryCapabilities({
      reasoning: 'true',
      tool_call: 1,
      modalities: { input: ['text', 4] },
      support_efforts: 'high'
    }),
    undefined
  )
  assert.deepEqual(
    parseRegistryCapabilities({ support_efforts: ['low', 'high', 'high'], default_effort: 'high' }),
    { support_efforts: ['low', 'high'], default_effort: 'high' }
  )
  assert.deepEqual(
    parseRegistryCapabilities({ support_efforts: ['high'], default_effort: 'max' }),
    { support_efforts: ['high'] }
  )
  assert.deepEqual(parseRegistryCapabilities({ modalities: { input: [], output: ['text'] } }), {
    modalities: { input: [], output: ['text'] }
  })
})

test('shared models advertise common capabilities and unresolved explicit metadata stays unknown', () => {
  const rich = parseRegistryCapabilities(metadata)!
  const limited = parseRegistryCapabilities({
    ...metadata,
    support_efforts: ['high'],
    modalities: { input: ['text', 'image'], output: ['text'] }
  })!
  assert.deepEqual(mergeRegistryCapabilities([rich, limited]), {
    reasoning: true,
    tool_call: true,
    support_efforts: ['high'],
    modalities: { input: ['text', 'image'], output: ['text'] }
  })
  assert.deepEqual(mergeRegistryCapabilities([rich, undefined]), {})
  const disabled = mergeRegistryCapabilities([rich, { reasoning: false, tool_call: false }])
  assert.deepEqual(disabled, { reasoning: false, tool_call: false })
  const entries = parseCatalogEntries(payload)
  const shared = registryModels(
    [
      { provider: 'kimi', models: ['k3'] },
      { provider: 'opencode-go', models: ['k3'] }
    ],
    entries,
    [
      {
        provider: 'opencode-go',
        model: 'k3',
        currency: 'USD',
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        catalogMatch: { provider: 'missing', model: 'k3' }
      }
    ]
  ).k3
  assert.equal(shared.modalities, undefined)
  assert.equal(shared.support_efforts, undefined)
})

test('fresh v3 caches upgrade to capabilities, persist offline, and reuse saved model matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'registry-capabilities-'))
  const file = join(dir, 'catalog.json')
  const now = 1000000000000
  try {
    const entries = parseCatalogEntries(payload).map(
      ({ capabilities: _capabilities, ...entry }) => entry
    )
    await writeFile(file, JSON.stringify({ version: 3, updatedAt: now, entries }))
    let calls = 0
    const catalog = new ModelPriceCatalog(
      file,
      async () => {
        calls++
        return Response.json(payload)
      },
      () => now
    )
    await catalog.load()
    await catalog.refresh()
    assert.equal(calls, 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 4)
    const restored = new ModelPriceCatalog(
      file,
      async () => {
        throw new Error('offline')
      },
      () => now
    )
    await restored.load()
    await restored.refresh(true)
    assert.deepEqual(restored.snapshot().entries, catalog.snapshot().entries)
    const model = registryModels(
      [{ provider: 'kimi', models: ['alias'] }],
      restored.snapshot().entries,
      [
        {
          provider: 'kimi',
          model: 'alias',
          currency: 'USD',
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          catalogMatch: { provider: 'kimi-for-coding', model: 'k3' }
        }
      ]
    ).alias
    assert.equal(model.id, 'alias')
    assert.deepEqual(model.support_efforts, ['low', 'high', 'max'])
    assert.deepEqual(model.modalities?.input, ['text', 'image', 'video'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
