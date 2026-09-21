import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestSleepBlocker } from '../src/main/services/request-sleep-blocker'
import { SettingsStore, validateSettings } from '../src/main/services/settings'

test('concurrent requests share one blocker; new work cancels delayed release', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const stops: number[] = []
  let starts = 0
  const blocker = new RequestSleepBlocker(
    {
      start: (type) => {
        assert.equal(type, 'prevent-app-suspension')
        return starts++
      },
      stop: (id) => {
        stops.push(id)
        return true
      }
    },
    { preventSleepDuringRequests: true, sleepReleaseDelaySeconds: 60 }
  )
  t.after(() => blocker.dispose())
  blocker.setActiveRequests(0)
  assert.equal(starts, 0)
  blocker.setActiveRequests(1)
  blocker.setActiveRequests(2)
  blocker.setActiveRequests(1)
  t.mock.timers.tick(120000)
  assert.equal(starts, 1)
  assert.deepEqual(stops, [])
  blocker.setActiveRequests(0)
  t.mock.timers.tick(59000)
  blocker.setActiveRequests(1)
  t.mock.timers.tick(60000)
  assert.deepEqual(stops, [])
  blocker.setActiveRequests(0)
  t.mock.timers.tick(59999)
  assert.deepEqual(stops, [])
  t.mock.timers.tick(1)
  assert.deepEqual(stops, [0])
  blocker.setActiveRequests(1)
  assert.equal(starts, 2)
})

test('enable mid-request, disable and dispose release immediately; idle setting updates retain deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let starts = 0
  const stops: number[] = []
  const preferences = { preventSleepDuringRequests: false, sleepReleaseDelaySeconds: 60 }
  const blocker = new RequestSleepBlocker(
    {
      start: () => starts++,
      stop: (id) => {
        stops.push(id)
        return true
      }
    },
    preferences
  )
  blocker.setActiveRequests(1)
  assert.equal(starts, 0)
  blocker.configure({ ...preferences, preventSleepDuringRequests: true })
  assert.equal(starts, 1)
  blocker.configure(preferences)
  assert.deepEqual(stops, [0])
  blocker.configure({ ...preferences, preventSleepDuringRequests: true })
  blocker.setActiveRequests(0)
  t.mock.timers.tick(40000)
  blocker.configure({ preventSleepDuringRequests: true, sleepReleaseDelaySeconds: 30 })
  assert.deepEqual(stops, [0, 1])
  blocker.setActiveRequests(1)
  blocker.setActiveRequests(0)
  blocker.dispose()
  t.mock.timers.tick(120000)
  blocker.setActiveRequests(1)
  assert.equal(starts, 3)
  assert.deepEqual(stops, [0, 1, 2])
})

test('power assertion failure does not throw into the gateway', () => {
  const blocker = new RequestSleepBlocker(
    {
      start: () => {
        throw new Error('Unavailable')
      },
      stop: () => true
    },
    { preventSleepDuringRequests: true, sleepReleaseDelaySeconds: 60 }
  )
  assert.doesNotThrow(() => blocker.setActiveRequests(1))
  blocker.setActiveRequests(0)
  blocker.dispose()
})

test('old settings receive defaults; invalid sleep preferences are rejected', () => {
  assert.deepEqual(validateSettings({ theme: 'dark' }), {
    theme: 'dark',
    preventSleepDuringRequests: false,
    sleepReleaseDelaySeconds: 60
  })
  for (const delay of [0, -1, 3601, 1.5, '60', NaN]) {
    assert.throws(() => validateSettings({ theme: 'light', sleepReleaseDelaySeconds: delay }))
  }
  assert.throws(() => validateSettings({ theme: 'light', preventSleepDuringRequests: 'true' }))
})

test('concurrent partial saves preserve theme and sleep preferences across reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'navo-sleep-'))
  try {
    const file = join(directory, 'settings.json')
    const store = new SettingsStore(file)
    await Promise.all([
      store.save({ preventSleepDuringRequests: true }),
      store.save({ theme: 'dark' }),
      store.save({ sleepReleaseDelaySeconds: 900 })
    ])
    const reloaded = new SettingsStore(file)
    await reloaded.load()
    assert.deepEqual(reloaded.get(), {
      theme: 'dark',
      preventSleepDuringRequests: true,
      sleepReleaseDelaySeconds: 900
    })
    await assert.rejects(store.save({ sleepReleaseDelaySeconds: -1 }))
    await store.save({ theme: 'light' })
    assert.equal(store.get().preventSleepDuringRequests, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
