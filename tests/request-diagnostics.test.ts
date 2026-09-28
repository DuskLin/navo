import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  RequestDiagnostics,
  requestIssueUrl,
  requestIssueReport,
  diagnosticHeaders,
  diagnosticEndpoint,
  requestShape
} from '../src/main/services/request-diagnostics'
import { RequestHistory } from '../src/main/services/request-history'
import { canReportRequest } from '../src/shared/request-failure'
import type { RequestRecord } from '../src/shared/contracts'

const record = (id: string, status = 400): RequestRecord => ({
  id,
  status,
  time: Date.now(),
  group: 'private-group',
  account: 'private-account',
  model: 'private-model',
  attempts: 1,
  durationMs: 10,
  firstTokenMs: null,
  sessionId: 'private-session',
  upstreamRequestId: 'private-upstream-id',
  protocol: 'responses',
  inboundRoute: '/v1/responses',
  upstreamRoute: '/v1/chat/completions'
})

test('diagnostics preserve model IDs and complete error objects while redacting other request fields', () => {
  const d = new RequestDiagnostics()
  d.request({
    model: 'my-model',
    input: 'my private prompt',
    authorization: 'private-credential',
    metadata: { secret_key: 'private-value' },
    messages: [{ role: 'user', content: 'private-content' }],
    tools: [
      { name: 'private-tool', parameters: { properties: { private_property: { type: 'string' } } } }
    ],
    max_tokens: 42,
    stream: true
  })
  d.request({ model: 'upstream-model', input: 'my private prompt' }, true)
  const error = {
    type: 'invalid_request_error',
    code: 'invalid_value',
    param: 'model',
    message:
      'Invalid my-model: "my private prompt" https://private.host user@example.com sk-original-error-value',
    details: { supported_models: ['my-model', 'upstream-model'], nested: [1, false, null] },
    custom_field: 'keep-me'
  }
  d.error({ error, request: { secret: 'outside-error' } }, 1, 400)
  assert.deepEqual(d.log.errors[0].detail, error)
  assert.equal(JSON.stringify(d.log.errors).includes('outside-error'), false)
  const request = JSON.stringify(d.log.request)
  for (const secret of [
    'my private prompt',
    'private-credential',
    'private-content',
    'private-value'
  ])
    assert.ok(!request.includes(secret), secret)
  assert.match(request, /my-model/)
  assert.match(request, /private-tool/)
  assert.match(request, /private_property/)
  assert.match(request, /string: 17 chars/)
  assert.match(JSON.stringify(d.log.forwardedRequest), /upstream-model/)
  assert.match(request, /"max_tokens":42/)
  assert.match(request, /"role":"user"/)
  d.error({ response: { error } }, 2, 400)
  assert.deepEqual(d.log.errors[1].detail, error)
  d.error(new Error('unredacted native error'), 3)
  assert.equal((d.log.errors[2].detail as { message: string }).message, 'unredacted native error')
  const report = requestIssueReport(record('error'), d.log, '0.6.3')
  assert.ok(
    (report.clipboardBody ?? new URL(report.url).searchParams.get('body')!).includes(
      'sk-original-error-value'
    )
  )
  assert.deepEqual(JSON.parse(JSON.stringify(requestShape({ input: 123456 }))), {
    input: '[REDACTED number]'
  })
})

test('rejected body capture preserves non-JSON errors and bounds oversized bodies', async () => {
  const d = new RequestDiagnostics()
  await d.rejected(new Response('<html>private-error</html>', { status: 502 }), 1)
  await d.rejected(new Response('x'.repeat(300000), { status: 503 }), 2)
  await d.rejected(
    Response.json({ error: { code: 'overloaded', message: 'Try again' } }, { status: 429 }),
    3
  )
  const text = JSON.stringify(d.log)
  assert.ok(text.includes('private-error'))
  assert.match(text, /truncated/)
  assert.match(text, /overloaded/)
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'))
    }
  })
  const start = Date.now()
  await d.rejected(new Response(stream, { status: 500 }), 4)
  assert.ok(Date.now() - start < 3000)
})

test('failure detail retention survives restart, limits to 300, and does not evict request summaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navo-failure-'))
  const file = join(dir, 'requests.sqlite')
  let history = new RequestHistory(file)
  try {
    const d = new RequestDiagnostics()
    d.request({ input: 'DO-NOT-PERSIST', stream: true })
    d.error({ message: 'original error message', details: { field: 'keep-original' } }, 1, 400)
    for (let i = 0; i < 301; i++) history.append(record(String(i)), d.log)
    history.append(record('success', 200), d.log)
    history.close()
    history = new RequestHistory(file)
    assert.equal(history.page().total, 302)
    assert.equal(history.failureReport('0').diagnostic, undefined)
    assert.deepEqual(history.failureReport('1').diagnostic, JSON.parse(JSON.stringify(d.log)))
    assert.deepEqual(history.failureReport('300').diagnostic, JSON.parse(JSON.stringify(d.log)))
    assert.equal(history.failureReport('success').diagnostic, undefined)
    assert.throws(() => history.failureReport({ id: '1' }), /无效/)
    assert.throws(() => history.failureReport('missing'), /不存在/)
    assert.ok(!(await readFile(file)).includes(Buffer.from('DO-NOT-PERSIST')))
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('reportability excludes cancellation; issue links omit identifiers, explain old logs, and bound URL size', () => {
  assert.equal(canReportRequest(record('ok', 200)), false)
  assert.equal(canReportRequest(record('cancelled', 499)), false)
  assert.equal(
    canReportRequest({ ...record('cancelled'), interruption: 'client_disconnect' }),
    false
  )
  assert.equal(canReportRequest({ ...record('stream', 200), interruption: 'upstream_error' }), true)
  const url = new URL(requestIssueUrl(record('old'), undefined, '0.6.3'))
  assert.equal(url.origin + url.pathname, 'https://github.com/DuskLin/navo/issues/new')
  assert.match(url.searchParams.get('body')!, /最近 300 条/)
  for (const value of ['private-account', 'private-group', 'private-model', 'private-upstream-id'])
    assert.ok(url.searchParams.get('body')!.includes(value))
  for (const value of ['private-session']) assert.ok(!url.searchParams.get('body')!.includes(value))
  const report = requestIssueReport(
    record('long'),
    {
      request: '中'.repeat(10000),
      errors: [{ attempt: 1, detail: { message: 'last-error-evidence' } }]
    },
    '0.6.3'
  )
  assert.ok(report.url.length <= 7500)
  assert.match(new URL(report.url).searchParams.get('body')!, /剪贴板/)
  assert.ok(report.clipboardBody!.includes('中'.repeat(10000)))
  assert.ok(report.clipboardBody!.includes('last-error-evidence'))
  assert.ok(!report.clipboardBody!.includes('已截断'))
})

test('diagnostic headers retain extension headers and hide sensitive values', () => {
  const headers = diagnosticHeaders(
    new Headers({
      authorization: 'Bearer secret',
      cookie: 'secret',
      'x-api-key': 'secret',
      'x-custom-mode': 'strict-v2',
      'anthropic-version': '2023-06-01',
      'x-request-id': 'req-123',
      'retry-after': '30'
    })
  )
  assert.equal(headers['x-custom-mode'], 'strict-v2')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['x-request-id'], 'req-123')
  for (const key of ['authorization', 'cookie', 'x-api-key']) assert.match(headers[key], /REDACTED/)
  assert.equal(
    diagnosticEndpoint('https://user:secret@example.com/custom/v1/responses?token=secret'),
    'https://example.com/custom/v1/responses'
  )
})

test('request capture defaults to preserving unknown fields, nested options and full arrays', () => {
  const source = {
    custom_option: 'experimental-mode',
    metadata: { deployment: 'region-two', secret_key: 'credential-value' },
    messages: Array.from({ length: 150 }, (_, index) => ({
      role: 'user',
      content: `private-text-${index}`
    })),
    vendor_config: {
      reasoning_mode: 'max',
      response_policy: 'adaptive',
      accessToken: 'hidden-token'
    },
    tools: [
      {
        name: 'lookup',
        description: 'Find a record',
        parameters: {
          type: 'object',
          properties: { email: { type: 'string', description: 'Contact address' } }
        }
      }
    ],
    max_tokens: 978090
  }
  const shape = JSON.parse(JSON.stringify(requestShape(source)))
  assert.equal(shape.custom_option, source.custom_option)
  assert.equal(shape.metadata.deployment, 'region-two')
  assert.equal(shape.vendor_config.reasoning_mode, 'max')
  assert.equal(shape.vendor_config.response_policy, 'adaptive')
  assert.equal(shape.messages.length, 150)
  assert.equal(shape.max_tokens, 978090)
  assert.deepEqual(shape.tools, source.tools)
  for (const text of ['credential-value', 'private-text-', 'hidden-token'])
    assert.ok(!JSON.stringify(shape).includes(text))
})

test('unknown URL options retain routing details while removing URL credentials', () => {
  const shape = requestShape({
    endpoint: 'https://user:pass@example.com/custom?mode=fast&api_key=secret',
    model: 'sk-model-id'
  }) as Record<string, string>
  assert.equal(shape.model, 'sk-model-id')
  const url = new URL(shape.endpoint)
  assert.equal(url.username, '')
  assert.equal(url.password, '')
  assert.equal(url.pathname, '/custom')
  assert.equal(url.searchParams.get('mode'), 'fast')
  assert.equal(url.searchParams.get('api_key'), '[REDACTED]')
})
