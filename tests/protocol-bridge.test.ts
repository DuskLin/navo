import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  convertRequest,
  type Wire,
  type BridgeContext
} from '../src/main/services/protocol-request'
import { convertResponse } from '../src/main/services/protocol-response'
import type { UsageProtocol } from '../src/shared/usage'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Gateway } from '../src/main/services/gateway'
import { GatewayStore } from '../src/main/services/gateway-store'
import { openCodeGoRoute } from '../src/shared/opencode-go'

const protocols: UsageProtocol[] = ['chat-completions', 'messages', 'responses']
const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
const inputImage = 'data:image/png;base64,aGVsbG8='
function assertPairedTools(messages: Wire[]): void {
  let pending = new Set<string>()
  for (const message of messages) {
    if (pending.size) {
      assert.equal(
        message.role,
        'tool',
        'tool_calls must be followed immediately by all tool results'
      )
      assert.ok(pending.delete(message.tool_call_id), 'tool result must match a pending call')
    } else {
      assert.notEqual(message.role, 'tool', 'orphan tool result')
      if (message.tool_calls?.length)
        pending = new Set(message.tool_calls.map((call: Wire) => call.id))
    }
  }
  assert.equal(pending.size, 0, 'unanswered tool calls')
}
function parallelHistory(): Wire[] {
  return [
    { role: 'user', content: 'Read two files' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect both files first.' }] },
    { role: 'assistant', content: 'Reading the files.' },
    {
      type: 'function_call',
      call_id: 'parallel_a',
      name: 'read_file',
      arguments: '{"path":"a.ts"}'
    },
    {
      type: 'function_call',
      call_id: 'parallel_b',
      name: 'read_file',
      arguments: '{"path":"b.ts"}'
    },
    { role: 'developer', content: 'Approved command prefix saved' },
    { type: 'function_call_output', call_id: 'parallel_b', output: 'B result' },
    {
      type: 'function_call_output',
      call_id: 'parallel_a',
      output: [
        { type: 'input_text', text: 'A result' },
        { type: 'input_image', image_url: inputImage }
      ]
    },
    { role: 'user', content: 'Continue with both results' }
  ]
}

test('Responses parallel tool history is one assistant turn followed by ordered complete replies before notices or media', () => {
  const input = { ...request('responses'), model: 'deepseek-v4.1-flash', input: parallelHistory() }
  const original = structuredClone(input)
  const { body } = convertRequest(input, 'responses', 'chat-completions')
  assertPairedTools(body.messages)
  const index = body.messages.findIndex((m: Wire) => m.tool_calls?.length)
  assert.equal(body.messages[index].content, 'Reading the files.')
  assert.equal(body.messages[index].reasoning_content, 'Inspect both files first.')
  assert.deepEqual(
    body.messages[index].tool_calls.map((c: Wire) => c.id),
    ['parallel_a', 'parallel_b']
  )
  assert.deepEqual(
    body.messages.slice(index + 1, index + 3).map((m: Wire) => m.tool_call_id),
    ['parallel_a', 'parallel_b']
  )
  assert.ok(JSON.stringify(body.messages[index + 3]).includes(inputImage))
  assert.ok(JSON.stringify(body.messages).includes('Approved command prefix saved'))
  assert.deepEqual(input, original)
})

test('Responses interrupted tools, orphan/duplicate outputs and reasoning replay across chained calls', () => {
  const call = (id: string) => ({
    type: 'function_call',
    call_id: id,
    name: 'read_file',
    arguments: '{}'
  })
  const output = (id: string, text: string) => ({
    type: 'function_call_output',
    call_id: id,
    output: text
  })
  const { body } = convertRequest(
    {
      model: 'deepseek-v4.1-flash',
      input: [
        { role: 'user', content: 'start' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'same-turn thinking' }] },
        call('a'),
        call('interrupted'),
        output('a', 'old'),
        output('a', 'latest'),
        output('orphan', 'orphan result'),
        call('b'),
        output('b', 'B result'),
        { role: 'user', content: 'new turn' },
        call('c'),
        output('c', 'C result')
      ]
    },
    'responses',
    'chat-completions'
  )
  assertPairedTools(body.messages)
  const assistant = body.messages.filter((m: Wire) => m.tool_calls?.length)
  assert.deepEqual(
    assistant.map((m: Wire) => m.tool_calls.map((c: Wire) => c.id)),
    [['a'], ['b'], ['c']]
  )
  assert.equal(assistant[0].reasoning_content, 'same-turn thinking')
  assert.equal(assistant[1].reasoning_content, 'same-turn thinking')
  assert.equal(assistant[2].reasoning_content, undefined)
  assert.equal(body.messages.find((m: Wire) => m.tool_call_id === 'a').content, 'latest')
  assert.ok(!JSON.stringify(body).includes('orphan result'))
})
function request(protocol: UsageProtocol): Wire {
  const common = { model: 'test-model', stream: true, temperature: 0.3 }
  if (protocol === 'chat-completions')
    return {
      ...common,
      max_tokens: 2000,
      reasoning_effort: 'high',
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'Read', parameters: schema }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
      messages: [
        { role: 'system', content: 'system instructions' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: inputImage } }
          ]
        },
        {
          role: 'assistant',
          content: 'reading',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file result' },
        { role: 'user', content: 'continue' }
      ]
    }
  if (protocol === 'messages')
    return {
      ...common,
      max_tokens: 2000,
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'system instructions' }],
      tools: [{ name: 'read_file', description: 'Read', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'read_file' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reading' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'file result' },
            { type: 'text', text: 'continue' }
          ]
        }
      ]
    }
  return {
    ...common,
    instructions: 'system instructions',
    max_output_tokens: 2000,
    reasoning: { effort: 'high' },
    tools: [{ type: 'function', name: 'read_file', description: 'Read', parameters: schema }],
    tool_choice: { type: 'function', name: 'read_file' },
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: inputImage }
        ]
      },
      { role: 'assistant', content: [{ type: 'output_text', text: 'reading' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file result' },
      { role: 'user', content: 'continue' }
    ]
  }
}

for (const source of protocols)
  for (const target of protocols)
    if (source !== target) {
      test(`request ${source} → ${target}: instructions, image, tool history, schema and generation options`, () => {
        const original = request(source)
        const snapshot = structuredClone(original)
        const { body } = convertRequest(original, source, target)
        assert.deepEqual(original, snapshot)
        assert.equal(body.stream, true)
        assert.equal(body.model, 'test-model')
        assert.equal(body.temperature, 0.3)
        assert.equal(body.max_tokens ?? body.max_output_tokens, 2000)
        const wire = JSON.stringify(body)
        for (const text of [
          'system instructions',
          'aGVsbG8=',
          'file result',
          'continue',
          'call_1',
          'read_file'
        ])
          assert.ok(wire.includes(text), text)
        const tool = body.tools[0]
        assert.deepEqual(
          target === 'messages'
            ? tool.input_schema
            : target === 'chat-completions'
              ? tool.function.parameters
              : tool.parameters,
          schema
        )
        if (target === 'messages') {
          assert.equal(body.tool_choice.type, 'tool')
          assert.ok(body.thinking.budget_tokens < body.max_tokens)
          const results = body.messages
            .flatMap((m: Wire) => (Array.isArray(m.content) ? m.content : []))
            .filter((p: Wire) => p.type === 'tool_result')
          assert.equal(results[0].tool_use_id, 'call_1')
        } else if (target === 'chat-completions') {
          assert.equal(body.messages.find((m: Wire) => m.role === 'tool').tool_call_id, 'call_1')
          assert.equal(body.stream_options.include_usage, true)
        } else {
          assert.equal(body.store, false)
          assert.equal(body.input.find((i: Wire) => i.type === 'function_call').call_id, 'call_1')
          assert.equal(body.tool_choice.type, 'function')
        }
      })
    }

const rawUsage = {
  input_tokens: 120,
  output_tokens: 6,
  input_tokens_details: { cached_tokens: 20 },
  cache_creation_input_tokens: 10
}
const outputs = [
  { id: 'rs_native', type: 'reasoning', summary: [{ type: 'summary_text', text: '思考' }] },
  {
    id: 'msg_native',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: '你好', annotations: [] }]
  },
  {
    id: 'fc_a',
    type: 'function_call',
    call_id: 'call_a',
    name: 'read_file',
    arguments: '{"path":"a.ts"}'
  },
  {
    id: 'fc_b',
    type: 'function_call',
    call_id: 'call_b',
    name: 'read_file',
    arguments: '{"path":"b.ts"}'
  }
]
function response(protocol: UsageProtocol): Wire {
  if (protocol === 'responses')
    return {
      id: 'resp_native',
      object: 'response',
      model: 'test-model',
      status: 'completed',
      output: outputs,
      usage: rawUsage
    }
  if (protocol === 'messages')
    return {
      id: 'msg_native',
      type: 'message',
      model: 'test-model',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '思考', signature: 'signed' },
        { type: 'text', text: '你好' },
        ...outputs.slice(2).map((t) => ({
          type: 'tool_use',
          id: t.call_id,
          name: t.name,
          input: JSON.parse(t.arguments!)
        }))
      ],
      usage: {
        input_tokens: 90,
        output_tokens: 6,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10
      }
    }
  return {
    id: 'chat_native',
    object: 'chat.completion',
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '你好',
          reasoning_content: '思考',
          tool_calls: outputs.slice(2).map((t) => ({
            id: t.call_id,
            type: 'function',
            function: { name: t.name, arguments: t.arguments }
          }))
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 6,
      prompt_tokens_details: { cached_tokens: 20 },
      cache_creation_input_tokens: 10
    }
  }
}
const sse = (value: Wire) =>
  `event: ${value.type ?? 'chunk'}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`
function stream(protocol: UsageProtocol): string {
  if (protocol === 'chat-completions') {
    const chunk = (delta: Wire, finish: string | null = null) =>
      sse({ choices: [{ index: 0, delta, finish_reason: finish }] })
    return (
      ': ping\r\n\r\n' +
      chunk({ role: 'assistant' }) +
      chunk({ reasoning_content: '思考' }) +
      chunk({ content: '你好' }) +
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":' }
          },
          {
            index: 1,
            id: 'call_b',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":' }
          }
        ]
      }) +
      chunk({
        tool_calls: [
          { index: 1, function: { arguments: '"b.ts"}' } },
          { index: 0, function: { arguments: '"a.ts"}' } }
        ]
      }) +
      chunk({}, 'tool_calls') +
      sse({ choices: [], usage: response(protocol).usage }) +
      'data: [DONE]\n\n'
    )
  }
  if (protocol === 'messages') {
    let result = sse({
      type: 'message_start',
      message: {
        ...response(protocol),
        content: [],
        usage: { ...response(protocol).usage, output_tokens: 0 }
      }
    })
    for (const [index, b] of response(protocol).content.entries()) {
      result += sse({
        type: 'content_block_start',
        index,
        content_block:
          b.type === 'tool_use'
            ? { ...b, input: {} }
            : b.type === 'thinking'
              ? { type: 'thinking', thinking: '' }
              : { type: 'text', text: '' }
      })
      result += sse({
        type: 'content_block_delta',
        index,
        delta:
          b.type === 'tool_use'
            ? { type: 'input_json_delta', partial_json: JSON.stringify(b.input) }
            : b.type === 'thinking'
              ? { type: 'thinking_delta', thinking: b.thinking }
              : { type: 'text_delta', text: b.text }
      })
      result += sse({ type: 'content_block_stop', index })
    }
    return (
      result +
      sse({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 6 }
      }) +
      sse({ type: 'message_stop' })
    )
  }
  let result = sse({
    type: 'response.created',
    response: { id: 'resp_native', status: 'in_progress' }
  })
  for (const [index, item] of outputs.entries()) {
    result += sse({
      type: 'response.output_item.added',
      output_index: index,
      item: { ...item, content: [], arguments: '', summary: [] }
    })
    result += sse({
      type:
        item.type === 'message'
          ? 'response.output_text.delta'
          : item.type === 'reasoning'
            ? 'response.reasoning_summary_text.delta'
            : 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: index,
      content_index: 0,
      summary_index: 0,
      delta: item.type === 'message' ? '你好' : item.type === 'reasoning' ? '思考' : item.arguments
    })
    result += sse({ type: 'response.output_item.done', output_index: index, item })
  }
  return result + sse({ type: 'response.completed', response: response(protocol) })
}
async function* chunks(text: string) {
  const data = Buffer.from(text)
  for (let i = 0; i < data.length; i += 7) yield data.subarray(i, i + 7)
}
async function translate(
  source: UsageProtocol,
  target: UsageProtocol,
  inputStream: boolean,
  outputStream: boolean,
  input?: string,
  context?: BridgeContext
) {
  const output: Buffer[] = []
  for await (const chunk of convertResponse(
    chunks(input ?? (inputStream ? stream(source) : JSON.stringify(response(source)))),
    {
      source,
      target,
      inputStream,
      outputStream,
      ok: true,
      context: context ?? { model: 'test-model', tools: new Map() }
    }
  ))
    output.push(chunk)
  return Buffer.concat(output).toString()
}
const events = (text: string): Wire[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))
for (const source of protocols)
  for (const target of protocols)
    if (source !== target)
      for (const inputStream of [false, true])
        for (const outputStream of [false, true]) {
          test(`response ${source} ${inputStream ? 'SSE' : 'JSON'} → ${target} ${outputStream ? 'SSE' : 'JSON'}: UTF-8, parallel tools, lifecycle and cache accounting`, async () => {
            const result = await translate(source, target, inputStream, outputStream)
            assert.ok(result.includes('你好'))
            assert.ok(result.includes('思考'))
            assert.ok(result.includes('call_a'))
            assert.ok(result.includes('call_b'))
            if (!outputStream) {
              const json = JSON.parse(result)
              if (target === 'messages') {
                assert.equal(json.stop_reason, 'tool_use')
                assert.equal(json.usage.input_tokens, 90)
                assert.deepEqual(
                  json.content
                    .filter((b: Wire) => b.type === 'tool_use')
                    .map((b: Wire) => b.input.path),
                  ['a.ts', 'b.ts']
                )
              } else if (target === 'responses') {
                assert.equal(json.status, 'completed')
                assert.equal(json.usage.input_tokens, 120)
                assert.equal(json.output.filter((b: Wire) => b.type === 'function_call').length, 2)
              } else {
                assert.equal(json.choices[0].finish_reason, 'tool_calls')
                assert.equal(json.usage.prompt_tokens, 120)
                assert.equal(json.choices[0].message.tool_calls.length, 2)
              }
              assert.equal(json.usage.output_tokens ?? json.usage.completion_tokens, 6)
            } else {
              const e = events(result)
              if (target === 'messages') {
                assert.equal(e[0].type, 'message_start')
                assert.equal(e.at(-1)!.type, 'message_stop')
                const starts = e.filter((v) => v.type === 'content_block_start')
                const stops = e.filter((v) => v.type === 'content_block_stop')
                assert.deepEqual(
                  starts.map((v) => v.index),
                  stops.map((v) => v.index)
                )
                assert.equal(e.find((v) => v.type === 'message_delta')!.usage.input_tokens, 90)
                for (const start of starts.filter((v) => v.content_block.type === 'tool_use')) {
                  const args = e
                    .filter((v) => v.type === 'content_block_delta' && v.index === start.index)
                    .map((v) => v.delta.partial_json)
                    .join('')
                  assert.ok(['a.ts', 'b.ts'].includes(JSON.parse(args).path))
                }
              } else if (target === 'responses') {
                assert.equal(e[0].type, 'response.created')
                assert.equal(e.at(-1)!.type, 'response.completed')
                assert.deepEqual(
                  e.map((v) => v.sequence_number),
                  e.map((_, i) => i)
                )
                const output = e.at(-1)!.response.output
                for (const added of e.filter((v) => v.type === 'response.output_item.added'))
                  assert.equal(added.item.id, output[added.output_index].id)
                assert.equal(e.at(-1)!.response.usage.input_tokens, 120)
                assert.equal(output.filter((v: Wire) => v.type === 'function_call').length, 2)
              } else {
                assert.ok(result.endsWith('data: [DONE]\n\n'))
                assert.equal(e.at(-1)!.usage.prompt_tokens, 120)
                const calls = new Map<number, string>()
                for (const event of e)
                  for (const c of event.choices?.[0]?.delta?.tool_calls ?? [])
                    calls.set(c.index, (calls.get(c.index) ?? '') + (c.function.arguments ?? ''))
                assert.deepEqual(
                  [...calls.values()].map((value) => JSON.parse(value).path),
                  ['a.ts', 'b.ts']
                )
              }
            }
          })
        }

test('custom and namespaced Responses tools round trip via function schema', async () => {
  const input = {
    model: 'minimax-test',
    input: 'edit',
    tools: [
      {
        type: 'namespace',
        name: 'functions',
        tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }]
      }
    ]
  }
  const { body, context } = convertRequest(input, 'responses', 'messages')
  assert.equal(body.tools[0].name, 'functions__apply_patch')
  assert.deepEqual(body.tools[0].input_schema.required, ['input'])
  const upstream = {
    type: 'message',
    content: [
      {
        type: 'tool_use',
        id: 'call_patch',
        name: 'functions__apply_patch',
        input: { input: '*** Begin Patch\n*** End Patch' }
      }
    ],
    stop_reason: 'tool_use'
  }
  const result = JSON.parse(
    await translate('messages', 'responses', false, false, JSON.stringify(upstream), context)
  )
  assert.equal(result.output[0].type, 'custom_tool_call')
  assert.equal(result.output[0].namespace, 'functions')
  assert.equal(result.output[0].name, 'apply_patch')
  assert.equal(result.output[0].input, '*** Begin Patch\n*** End Patch')
})

test('incomplete/error/disconnected streams never fabricate a successful terminal event', async () => {
  for (const target of protocols) {
    if (target !== 'messages') {
      const failure = await translate(
        'messages',
        target,
        true,
        true,
        sse({ type: 'error', error: { message: 'overloaded' } })
      )
      assert.ok(failure.includes('overloaded'))
      assert.ok(!failure.includes('response.completed'))
      assert.ok(!failure.includes('[DONE]'))
      await assert.rejects(
        translate('messages', target, true, true, sse({ type: 'message_start', message: {} })),
        /结束事件/
      )
    }
  }
  const limited = response('messages')
  limited.stop_reason = 'max_tokens'
  limited.content = [{ type: 'text', text: 'partial' }]
  const result = JSON.parse(
    await translate('messages', 'responses', false, false, JSON.stringify(limited))
  )
  assert.equal(result.status, 'incomplete')
  assert.equal(result.incomplete_details.reason, 'max_output_tokens')
  await assert.rejects(
    translate('chat-completions', 'responses', true, true, 'data: {not-json}\n\n'),
    /上游协议响应无效/
  )
  await assert.rejects(
    translate('chat-completions', 'messages', true, true, 'data: ' + 'x'.repeat(1024 * 1024 + 1)),
    /超过 1 MB/
  )
})

test('unsupported opaque history and hosted tools fail explicitly rather than dropping context', () => {
  assert.throws(
    () =>
      convertRequest(
        { model: 'm', input: 'hi', previous_response_id: 'resp_old' },
        'responses',
        'messages'
      ),
    /完整 input/
  )
  assert.throws(
    () =>
      convertRequest(
        { model: 'm', input: 'hi', tools: [{ type: 'web_search' }] },
        'responses',
        'chat-completions'
      ),
    /托管工具/
  )
  assert.throws(
    () => convertRequest({ ...request('chat-completions'), n: 2 }, 'chat-completions', 'messages'),
    /n=1/
  )
})

test('Responses done snapshots recover missing text deltas without duplication', async () => {
  const wire =
    sse({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] }
    }) +
    sse({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: '你'
    }) +
    sse({
      type: 'response.output_text.done',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      text: '你好'
    }) +
    sse({
      type: 'response.completed',
      response: {
        output: [
          { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: '你好' }] }
        ],
        status: 'completed'
      }
    })
  const result = JSON.parse(await translate('responses', 'messages', true, false, wire))
  assert.equal(result.content[0].text, '你好')
})

test('stop sequence maps to Chat stop; content starts flowing before upstream completes', async () => {
  const limited = {
    ...response('messages'),
    content: [{ type: 'text', text: 'partial' }],
    stop_reason: 'stop_sequence'
  }
  assert.equal(
    JSON.parse(
      await translate('messages', 'chat-completions', false, false, JSON.stringify(limited))
    ).choices[0].finish_reason,
    'stop'
  )
  let pulledTail = false
  const source = async function* () {
    yield Buffer.from(
      sse({ choices: [{ index: 0, delta: { content: 'live text' }, finish_reason: null }] })
    )
    pulledTail = true
    yield Buffer.from('data: [DONE]\n\n')
  }
  const iterator = convertResponse(source(), {
    source: 'chat-completions',
    target: 'messages',
    context: { model: 'm', tools: new Map() },
    inputStream: true,
    outputStream: true,
    ok: true
  })
  let content = ''
  while (!content.includes('live text')) content += (await iterator.next()).value?.toString() ?? ''
  assert.equal(pulledTail, false)
  await iterator.return(undefined)
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}
const route = (protocol: UsageProtocol) =>
  protocol === 'chat-completions' ? '/v1/chat/completions' : `/v1/${protocol}`

test('real HTTP gateway: all nine ingress/model combinations, JSON/SSE, headers, accounting, count_tokens and cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'protocol-gateway-test-'))
  const store = new GatewayStore(join(dir, 'gateway.json'), {
    encrypt: (v) => v,
    decrypt: (v) => v
  })
  const calls: { path: string; body: Wire; headers: Record<string, unknown> }[] = []
  let cancelled = false
  const upstream = createServer(async (req, res) => {
    const buffers: Buffer[] = []
    for await (const b of req) buffers.push(b)
    const body = JSON.parse(Buffer.concat(buffers).toString())
    calls.push({ path: req.url!, body, headers: req.headers })
    const protocol: UsageProtocol = req.url!.endsWith('/responses')
      ? 'responses'
      : req.url!.endsWith('/messages')
        ? 'messages'
        : 'chat-completions'
    if (!(protocol === 'responses' ? Array.isArray(body.input) : Array.isArray(body.messages))) {
      res.writeHead(400)
      res.end('{"error":{"message":"wrong wire format"}}')
      return
    }
    if (protocol === 'chat-completions') {
      try {
        assertPairedTools(body.messages)
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message:
                "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'."
            }
          })
        )
        return
      }
    }
    res.writeHead(200, {
      'content-type': body.stream ? 'text/event-stream' : 'application/json',
      'x-request-id': 'upstream-conversion-test'
    })
    if (req.headers['x-opencode-session'] === 'broken-test') {
      res.end('data: {invalid-json}\n\n')
      return
    }
    if (req.headers['x-opencode-session'] === 'cancel-test') {
      res.write(sse({ choices: [{ index: 0, delta: { content: 'live' }, finish_reason: null }] }))
      res.once('close', () => {
        cancelled = true
      })
      return
    }
    res.end(body.stream ? stream(protocol) : JSON.stringify(response(protocol)))
  })
  const port = await listen(upstream)
  const reservation = createServer()
  const gatewayPort = await listen(reservation)
  await close(reservation)
  const gateway = new Gateway(
    store,
    async (url, init) => {
      const parsed = new URL(String(url))
      assert.equal(parsed.origin, 'https://opencode.ai')
      return fetch(`http://127.0.0.1:${port}${parsed.pathname}`, init)
    },
    async (url) =>
      String(url).endsWith('/models')
        ? Response.json({
            data: ['glm-fixture', 'minimax-fixture', 'gpt-fixture', 'deepseek-v4.1-flash'].map(
              (id) => ({ id })
            )
          })
        : Response.json({
            usage: { rolling: { percent: 0 }, weekly: { percent: 0 }, monthly: { percent: 0 } }
          })
  )
  try {
    await gateway.saveAccount({
      name: 'go',
      provider: 'opencode-go',
      kind: 'api-key',
      region: 'global',
      enabled: true,
      secret: 'upstream-test-key',
      memberships: [{ groupId: 'default', priority: 0, weight: 1 }]
    })
    await gateway.saveSettings({ ...store.get().settings, port: gatewayPort })
    await gateway.setRunning(true)
    const base = `http://127.0.0.1:${gatewayPort}`
    const headers = {
      authorization: `Bearer ${store.get().groups[0].key}`,
      'content-type': 'application/json',
      'user-agent': 'test-client/1.0',
      'x-opencode-session': 'http-conversation'
    }
    for (const source of protocols)
      for (const model of ['glm-fixture', 'minimax-fixture', 'gpt-fixture'])
        for (const streaming of [false, true]) {
          const payload = { ...request(source), model, stream: streaming }
          const result = await fetch(base + route(source), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
          })
          assert.equal(result.status, 200)
          assert.equal(result.headers.get('x-request-id'), 'upstream-conversion-test')
          const output = await result.text()
          assert.ok(output.includes('你好'), `${source}/${model}`)
          assert.ok(output.includes('call_a'))
          if (streaming) assert.match(result.headers.get('content-type')!, /text\/event-stream/)
          else {
            const parsed = JSON.parse(output)
            assert.ok(
              source === 'messages'
                ? parsed.content
                : source === 'responses'
                  ? parsed.output
                  : parsed.choices
            )
          }
          const call = calls.at(-1)!
          assert.equal(call.path, '/zen/go' + openCodeGoRoute(model))
          assert.equal(call.headers.authorization, 'Bearer upstream-test-key')
          assert.equal(call.headers['x-opencode-session'], 'http-conversation')
          assert.equal(call.headers['user-agent'], 'test-client/1.0')
          if (openCodeGoRoute(model) === route(source)) assert.deepEqual(call.body, payload)
          if (call.path.endsWith('/messages'))
            assert.equal(call.headers['x-api-key'], 'upstream-test-key')
        }
    const tokenCount = await fetch(base + '/v1/messages/count_tokens', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'glm-fixture', messages: [{ role: 'user', content: 'hello' }] })
    })
    assert.equal(tokenCount.status, 200)
    assert.equal(tokenCount.headers.get('x-token-count-estimated'), 'true')
    assert.ok((await tokenCount.json()).input_tokens > 0)
    assert.equal(calls.length, 18)
    const bad = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'minimax-fixture',
        input: 'hi',
        previous_response_id: 'opaque'
      })
    })
    assert.equal(bad.status, 400)
    await bad.text()
    assert.equal(calls.length, 18)
    for (const streaming of [false, true]) {
      const result = await fetch(base + '/v1/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...request('responses'),
          model: 'deepseek-v4.1-flash',
          input: parallelHistory(),
          stream: streaming
        })
      })
      assert.equal(result.status, 200)
      if (streaming) assert.match(await result.text(), /response.completed/)
      else {
        const response = await result.json()
        assert.equal(response.status, 'completed')
        // Replay actual converted reasoning/tool output as a Responses client would.
        const replay = await fetch(base + '/v1/responses', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...request('responses'),
            model: 'deepseek-v4.1-flash',
            stream: false,
            input: [
              ...parallelHistory(),
              ...response.output,
              ...response.output
                .filter((item: Wire) => item.type === 'function_call')
                .map((item: Wire) => ({
                  type: 'function_call_output',
                  call_id: item.call_id,
                  output: 'completed'
                }))
            ]
          })
        })
        assert.equal(replay.status, 200)
        assert.equal((await replay.json()).status, 'completed')
      }
      assert.equal(calls.at(-1)!.path, '/zen/go/v1/chat/completions')
      assertPairedTools(calls.at(-1)!.body.messages)
    }
    const history = gateway.history.page(100).records // latest records include converted requests.
    const recorded = history.find((r) => r.usage)
    assert.ok(recorded)
    assert.equal(recorded.usage!.input, 90)
    assert.equal(recorded.usage!.cacheRead, 20)
    assert.equal(recorded.usage!.cacheWrite, 10)
    assert.equal(recorded.upstreamRequestId, 'upstream-conversion-test')
    const brokenBuffered = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { ...headers, 'x-opencode-session': 'broken-test' },
      body: JSON.stringify({
        model: 'glm-fixture',
        stream: false,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    assert.equal(
      brokenBuffered.status,
      502,
      'buffered conversion failure must return an HTTP error, not a premature 200'
    )
    assert.equal((await brokenBuffered.json()).type, 'error')
    gateway.scheduler.reset(store.get().accounts[0].id)
    await assert.rejects(async () => {
      const broken = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, 'x-opencode-session': 'broken-test' },
        body: JSON.stringify({
          model: 'glm-fixture',
          stream: true,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }]
        })
      })
      await broken.text()
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(gateway.history.page().records[0].status, 502)
    assert.equal(gateway.history.page().records[0].interruption, 'upstream_error')
    gateway.scheduler.reset(store.get().accounts[0].id)
    await gateway.saveAccount({
      ...store.get().accounts[0],
      modelProtocols: { 'gpt-fixture': ['messages', 'responses'] }
    })
    for (const client of ['messages', 'chat-completions'] as const) {
      const result = await fetch(base + route(client), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request(client), model: 'gpt-fixture', stream: false })
      })
      assert.equal(result.status, 200)
      const parsed = await result.json()
      assert.ok(client === 'messages' ? parsed.content : parsed.choices)
      assert.equal(
        calls.at(-1)!.path,
        client === 'messages' ? '/zen/go/v1/messages' : '/zen/go/v1/responses'
      )
    }
    const abort = new AbortController()
    const live = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { ...headers, 'x-opencode-session': 'cancel-test' },
      body: JSON.stringify({
        model: 'glm-fixture',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }]
      }),
      signal: abort.signal
    })
    const reader = live.body!.getReader()
    const first = await reader.read()
    assert.ok(Buffer.from(first.value!).toString().includes('message_start'))
    abort.abort()
    await reader.cancel().catch(() => {})
    const deadline = Date.now() + 2000
    while (
      (!cancelled || gateway.scheduler.state(store.get().accounts[0].id).active) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(cancelled, true)
    assert.equal(gateway.scheduler.state(store.get().accounts[0].id).active, 0)
  } finally {
    await gateway.shutdown()
    gateway.history.close()
    await close(upstream)
    await rm(dir, { recursive: true, force: true })
  }
})

test('MiniMax finish_reason without DONE converts at clean EOF and retains trailing usage', async () => {
  const body =
    sse({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] }) +
    sse({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }) +
    sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })
  for (const target of ['messages', 'responses'] as const) {
    const output = await translate('chat-completions', target, true, true, body)
    assert.ok(output.includes(target === 'messages' ? 'message_stop' : 'response.completed'))
    assert.ok(output.includes('thinking'))
    assert.ok(output.includes('OK'))
    const result = JSON.parse(await translate('chat-completions', target, true, false, body))
    assert.equal(result.usage.output_tokens, 2)
    await assert.rejects(
      translate(
        'chat-completions',
        target,
        true,
        true,
        sse({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })
      ),
      /结束事件/
    )
  }
})
