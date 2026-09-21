import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandCodeDate, parseCommandCodeQuota } from '../src/shared/commandcode'
import { hasCommandCodeExtraCredits, storedQuota, QUOTA_MAX_AGE_MS } from '../src/shared/kimi-quota'
import { KimiCapabilities, CapabilityError } from '../src/main/services/kimi-capabilities'

const credits = {
  credits: { monthlyCredits: 0, purchasedCredits: 3, freeCredits: 2 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 14, cap: 14, exceeded: true, resetAt: 1893456000000 },
    weekly: { used: 12.5, cap: 35, exceeded: false, resetAt: 1893456000000 }
  }
}
const subscription = {
  data: {
    planId: 'individual-goat',
    status: 'active',
    currentPeriodStart: '2029-12-01T00:00:00Z',
    currentPeriodEnd: '2030-01-01T00:00:00Z'
  }
}

test('Command Code preserves real balances, window limits and resets without inventing monthly cap', () => {
  const quota = parseCommandCodeQuota(credits, subscription, { totalCost: 70 })!
  assert.equal(quota.unit, 'USD')
  assert.deepEqual(quota.fiveHour, {
    limit: 14,
    used: 14,
    remaining: 0,
    resetAt: '2030-01-01T00:00:00.000Z'
  })
  assert.equal(quota.weekly?.remaining, 22.5)
  assert.deepEqual(quota.monthly, {
    limit: null,
    used: null,
    remaining: 0,
    resetAt: '2030-01-01T00:00:00.000Z'
  })
  assert.equal(quota.extraCredits, 5)
  assert.equal(quota.total?.remaining, 5)
  assert.equal(quota.total?.used, 70)
  assert.deepEqual(storedQuota(quota), quota)
  assert.equal(hasCommandCodeExtraCredits('commandcode-goat', quota, 1000, 1001), true)
  assert.equal(hasCommandCodeExtraCredits('kimi', quota, 1000, 1001), false)
  assert.equal(
    hasCommandCodeExtraCredits('commandcode-goat', quota, 1000, 1001 + QUOTA_MAX_AGE_MS),
    false
  )
  assert.equal(parseCommandCodeQuota({}), null)
  assert.equal(parseCommandCodeQuota({ credits: { monthlyCredits: 'bad' } }), null)
  assert.equal(
    parseCommandCodeQuota({ ...credits, windowLimits: { ...credits.windowLimits, limited: false } })
      ?.fiveHour,
    null
  )
  assert.equal(
    parseCommandCodeQuota({
      windowLimits: { fiveHour: { used: 2, cap: 10, exceeded: true, resetAt: 'bad' } }
    })?.fiveHour?.remaining,
    0
  )
})

test('Command Code scopes credits and billing-period summary to whoami org and authenticates alpha calls', async () => {
  const calls: URL[] = []
  const reader = new KimiCapabilities(async (url, init) => {
    const endpoint = new URL(String(url))
    calls.push(endpoint)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret')
    if (endpoint.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'm' }] })
    assert.equal(new Headers(init?.headers).get('user-agent'), 'cli')
    if (endpoint.pathname.endsWith('/whoami')) return Response.json({ org: { id: 'org & 1' } })
    assert.equal(endpoint.searchParams.get('orgId'), 'org & 1')
    if (endpoint.pathname.endsWith('/credits')) return Response.json(credits)
    if (endpoint.pathname.endsWith('/subscriptions')) return Response.json(subscription)
    assert.equal(endpoint.pathname, '/alpha/usage/summary')
    assert.equal(endpoint.searchParams.get('since'), '2029-12-01T00:00:00.000Z')
    return Response.json({ totalCost: 70 })
  })
  const cap = await reader.get('global', 'secret', false, 'commandcode-goat')
  assert.equal(calls.length, 5)
  assert.equal(cap.quota?.weekly?.remaining, 22.5)
  assert.equal(cap.quota?.total?.used, 70)
})

test('Command Code fails closed on alpha auth errors but tolerates missing billing metadata', async () => {
  for (const status of [401, 403, 500]) {
    const reader = new KimiCapabilities(async (url) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'm' }] })
      if (String(url).endsWith('/whoami')) return Response.json({ user: { id: 'u' } })
      if (String(url).endsWith('/credits')) return Response.json(credits)
      if (String(url).endsWith('/subscriptions'))
        return new Response('secret upstream text', { status })
      throw new Error('Must not fetch unbounded summary')
    })
    if (status !== 500) {
      await assert.rejects(
        reader.get('global', 'secret', false, 'commandcode-goat'),
        (error: unknown) =>
          error instanceof CapabilityError &&
          error.status === status &&
          !error.message.includes('secret')
      )
    } else {
      const cap = await reader.get('global', 'secret', false, 'commandcode-goat')
      assert.equal(cap.quota?.weekly?.remaining, 22.5)
      assert.equal(cap.quota?.monthly?.resetAt, null)
      assert.equal(cap.quota?.total?.used, null)
      assert.match(cap.warning, /订阅账期暂不可用/)
    }
  }
})

test('Command Code reset timestamps handle empty windows, seconds and milliseconds', () => {
  for (const value of [0, '0', null, undefined, -1, '', 'invalid'])
    assert.equal(commandCodeDate(value), null)
  for (const value of [
    1893456000,
    '1893456000',
    1893456000000,
    '1893456000000',
    '2030-01-01T00:00:00Z'
  ])
    assert.equal(commandCodeDate(value), '2030-01-01T00:00:00.000Z')
})
