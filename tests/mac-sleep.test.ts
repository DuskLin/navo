import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { MacSleepProtection } from '../src/main/services/mac-sleep'
import {
  macSleepLaunchScript,
  macSleepAuthorizationScript,
  shellQuote
} from '../src/main/services/mac-sleep-helper'

const exec = promisify(execFile)

async function until(check: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await delay(50)
  }
  assert.fail('Timed out waiting for sleep helper')
}

async function fixture(initial = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'navo-mac-sleep-'))
  const state = join(directory, 'state')
  const commands = join(directory, 'commands')
  const binary = join(directory, "mock 'pmset")
  const fail = join(directory, 'fail')
  await writeFile(state, String(initial))
  await writeFile(commands, '')
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = -g ]; then
  /usr/bin/printf 'SleepDisabled %s\\n' "$(/bin/cat ${shellQuote(state)})"
else
  /usr/bin/printf '%s\\n' "$*" >> ${shellQuote(commands)}
  [ "$1 $2" = '-a disablesleep' ] || exit 2
  [ "$3" != 1 ] || [ ! -e ${shellQuote(fail)} ] || exit 1
  /usr/bin/printf '%s' "$3" > ${shellQuote(state)}
fi
`,
    { mode: 0o700 }
  )
  let session = ''
  const launch = async (pid = process.pid) => {
    session = (
      await exec('/bin/sh', ['-c', macSleepLaunchScript(pid, process.getuid!(), binary)])
    ).stdout.trim()
    return session
  }
  const protection = new MacSleepProtection(() => launch())
  return {
    protection,
    launch,
    state,
    fail,
    commands,
    session: () => session,
    async clean() {
      await protection.close()
      if (session) {
        try {
          await writeFile(join(session, 'control'), '0 0\n')
        } catch {}
        await until(async () => {
          try {
            await readFile(join(session, 'status'))
            return false
          } catch {
            return true
          }
        })
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test(
  'macOS helper disables system sleep and restores it, without touching display settings',
  { skip: process.platform !== 'darwin' },
  async () => {
    const f = await fixture()
    try {
      await f.protection.prepare()
      assert.equal(await readFile(f.state, 'utf8'), '0')
      f.protection.setWanted(true)
      await until(async () => (await readFile(f.state, 'utf8')) === '1')
      await until(async () => f.protection.snapshot().active)
      f.protection.setWanted(false)
      await until(async () => (await readFile(f.state, 'utf8')) === '0')
      f.protection.setWanted(true)
      await until(async () => (await readFile(f.state, 'utf8')) === '1')
      await f.protection.close()
      assert.equal(await readFile(f.state, 'utf8'), '0')
      assert.deepEqual((await readFile(f.commands, 'utf8')).trim().split('\n'), [
        '-a disablesleep 1',
        '-a disablesleep 0',
        '-a disablesleep 1',
        '-a disablesleep 0'
      ])
    } finally {
      await f.clean()
    }
  }
)

test(
  'existing system-wide sleep disable is preserved',
  { skip: process.platform !== 'darwin' },
  async () => {
    const f = await fixture(1)
    try {
      await f.protection.prepare()
      f.protection.setWanted(true)
      await until(async () => f.protection.snapshot().externallyDisabled)
      f.protection.setWanted(false)
      await f.protection.close()
      assert.equal(await readFile(f.state, 'utf8'), '1')
      assert.equal(await readFile(f.commands, 'utf8'), '')
    } finally {
      await f.clean()
    }
  }
)

test(
  'expired heartbeat restores sleep independently of the app',
  { skip: process.platform !== 'darwin' },
  async () => {
    const f = await fixture()
    try {
      const session = await f.launch()
      await writeFile(join(session, 'control'), `${Math.floor(Date.now() / 1000) + 2} 1\n`)
      await until(async () => (await readFile(f.state, 'utf8')) === '1')
      await until(async () => (await readFile(f.state, 'utf8')) === '0')
    } finally {
      await f.clean()
    }
  }
)

test(
  'helper restores sleep when its owning app dies',
  { skip: process.platform !== 'darwin' },
  async () => {
    const f = await fixture()
    const owner = spawn('/bin/sleep', ['30'])
    try {
      const session = await f.launch(owner.pid!)
      await writeFile(join(session, 'control'), `${Math.floor(Date.now() / 1000) + 10} 1\n`)
      await until(async () => (await readFile(f.state, 'utf8')) === '1')
      owner.kill('SIGKILL')
      await until(async () => (await readFile(f.state, 'utf8')) === '0')
    } finally {
      owner.kill()
      await f.clean()
    }
  }
)

test('authorization cancellation leaves sleep protection disabled and can be retried', async () => {
  let attempts = 0
  const protection = new MacSleepProtection(async () => {
    attempts++
    throw new Error('授权已取消')
  })
  await assert.rejects(protection.prepare(), /授权已取消/)
  assert.equal(protection.snapshot().authorized, false)
  assert.equal(protection.snapshot().error, '授权已取消')
  await assert.rejects(protection.prepare())
  assert.equal(attempts, 2)
  await protection.close()
})

test(
  'failed pmset activation is surfaced and rolled back',
  { skip: process.platform !== 'darwin' },
  async () => {
    const f = await fixture()
    try {
      await writeFile(f.fail, '')
      await f.protection.prepare()
      f.protection.setWanted(true)
      await until(async () => Boolean(f.protection.snapshot().error))
      assert.equal(f.protection.snapshot().authorized, false)
      assert.equal(await readFile(f.state, 'utf8'), '0')
    } finally {
      await f.clean()
    }
  }
)

test(
  'authorization script compiles without executing or prompting',
  { skip: process.platform !== 'darwin' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'navo-sleep-applescript-'))
    try {
      const script = join(dir, 'authorize.applescript')
      await writeFile(script, macSleepAuthorizationScript(process.pid, process.getuid!()))
      await exec('/usr/bin/osacompile', ['-o', join(dir, 'authorize.scpt'), script])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)

test(
  'actual AppleScript transport starts an idle helper without a console',
  { skip: process.platform !== 'darwin' },
  async () => {
    const script = macSleepAuthorizationScript(process.pid, process.getuid!()).split(
      ' with administrator privileges'
    )[0]
    const session = (await exec('/usr/bin/osascript', ['-e', script])).stdout.trim()
    try {
      assert.match(await readFile(join(session, 'status'), 'utf8'), /ready|external/)
      assert.equal(await readFile(join(session, 'helper.log'), 'utf8'), '')
    } finally {
      await writeFile(join(session, 'control'), '0 0\n')
      await until(async () => {
        try {
          await readFile(join(session, 'status'))
          return false
        } catch {
          return true
        }
      })
    }
  }
)
