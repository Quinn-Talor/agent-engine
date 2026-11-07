import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { APICallError } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { beforeAll, describe, expect, it } from 'vitest'
import { isModelCallError, type Delta, type ModelInput, type ModelPort } from '../../sdk.js'
import { aiSdkProvider, type AiSdkModelConfig } from './ai-sdk-provider.js'

beforeAll(() => {
  ;(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false
})

type Script = LanguageModelV4StreamPart[] | Error | ReadableStream<LanguageModelV4StreamPart>
const usage = {
  inputTokens: { total: 30, noCache: 20, cacheRead: 10, cacheWrite: 0 },
  outputTokens: { total: 6, text: 6, reasoning: 0 },
}
const finish = (
  unified: 'stop' | 'tool-calls' | 'length' | 'error' = 'stop',
): LanguageModelV4StreamPart => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage,
})
const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: t },
  { type: 'text-end', id: 't' },
]
const busy = (status = 503, headers: Record<string, string> = { 'retry-after-ms': '1' }) =>
  new APICallError({
    message: `status ${status}`,
    url: 'x',
    requestBodyValues: {},
    statusCode: status,
    isRetryable: status >= 500 || status === 429,
    responseHeaders: headers,
  })

function setup(scripts: Script[], config: Partial<AiSdkModelConfig> = {}, maxRetries?: number) {
  let n = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const script = scripts[Math.min(n, scripts.length - 1)]!
      n += 1
      if (script instanceof Error) throw script
      return {
        stream: script instanceof ReadableStream ? script : convertArrayToReadableStream(script),
      }
    },
  })
  const provider = aiSdkProvider({
    id: 'acme',
    models: { big: { model, capabilities: { contextLimit: 200_000 }, ...config } },
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  })
  const port = provider.resolve('acme:big')!
  return { model, port, calls: () => n }
}

const input = (patch: Partial<ModelInput> = {}): ModelInput => ({
  messages: [{ role: 'user', content: '你好' }],
  tools: [],
  ...patch,
})
const run = async (port: ModelPort, i = input(), signal = new AbortController().signal) => {
  const deltas: Delta[] = []
  const response = await port.call(i, { signal, onDelta: (d) => deltas.push(d) })
  return { response, deltas }
}
const failure = async (port: ModelPort, i = input()) => {
  try {
    await port.call(i, { signal: new AbortController().signal, onDelta: () => {} })
  } catch (error) {
    return error
  }
  throw new Error('expected a failure')
}

describe('aiSdkProvider', () => {
  it('AC-001 resolves configured models with default capabilities', () => {
    const { port } = setup([[...text('x'), finish()]])
    expect(port.ref).toBe('acme:big')
    expect(port.capabilities).toEqual({
      contextLimit: 200_000,
      maxOutputTokens: 8192,
      inputs: [],
      toolCalls: true,
      reasoning: 'none',
      systemAfterUser: true,
      parallelToolCalls: true,
    })
    const provider = aiSdkProvider({ id: 'acme', models: {} })
    expect(provider.id).toBe('acme')
    expect(provider.resolve('acme:other')).toBeUndefined()
    expect(provider.resolve('other:big')).toBeUndefined()
  })

  it('AC-002 streams deltas and returns text, reasoning, tool calls and warnings', async () => {
    const { port } = setup([
      [
        { type: 'stream-start', warnings: [{ type: 'other', message: '温度被忽略' }] },
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: '想' },
        { type: 'reasoning-end', id: 'r', providerMetadata: { anthropic: { signature: 'sig' } } },
        ...text('你好'),
        { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: '{"q":"x"}' },
        finish('tool-calls'),
      ],
    ])
    const { response, deltas } = await run(
      port,
      input({ tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }] }),
    )
    expect(deltas).toEqual([
      { type: 'reasoning', text: '想' },
      { type: 'text', text: '你好' },
    ])
    expect(response).toMatchObject({
      text: '你好',
      reasoning: {
        text: '想',
        providerData: {
          parts: [{ text: '想', providerMetadata: { anthropic: { signature: 'sig' } } }],
        },
      },
      toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }],
      finishReason: 'tool-calls',
      usage: { input: 20, output: 6, cacheRead: 10, cacheWrite: 0 },
      warnings: ['温度被忽略'],
    })
    expect(response.attempts).toHaveLength(1)
  })

  it('AC-003 passes tools as JSON Schema without execute and stops after one step', async () => {
    const { port, model, calls } = setup([
      [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: '{}' },
        finish('tool-calls'),
      ],
      [...text('never'), finish()],
    ])
    await run(
      port,
      input({
        tools: [
          {
            name: 'search',
            description: '搜索',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      }),
    )
    expect(calls()).toBe(1)
    expect(model.doStreamCalls[0]!.tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: '搜索',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ])
    expect(model.doStreamCalls[0]!.toolChoice).toEqual({ type: 'auto' })
    const { model: bare } = setup([[...text('x'), finish()]])
    const p = aiSdkProvider({
      id: 'acme',
      models: { big: { model: bare, capabilities: { contextLimit: 1 } } },
    }).resolve('acme:big')!
    await run(p)
    expect(bare.doStreamCalls[0]!.tools).toBeUndefined()
  })

  it('AC-004 records every request including SDK retries', async () => {
    const { port, calls } = setup([busy(503), [...text('ok'), finish()]])
    const { response } = await run(port)
    expect(calls()).toBe(2)
    expect(response.attempts).toHaveLength(2)
    expect(response.attempts[0]!.error).toContain('503')
    expect(response.attempts[1]).not.toHaveProperty('error')
  })

  it('AC-005 fails with a classified ModelCallError', async () => {
    const { port, calls } = setup([busy(401)])
    const error = await failure(port)
    expect(isModelCallError(error) && error.detail).toMatchObject({
      code: 'AUTH_FAILED',
      status: 401,
      retryable: false,
    })
    expect(isModelCallError(error) && error.detail.attempts).toHaveLength(1)
    expect(calls()).toBe(1)
  })

  it('AC-006 classifies by the last error once retries run out', async () => {
    const { port, calls } = setup([busy(429)], {}, 1)
    const error = await failure(port)
    expect(isModelCallError(error) && error.detail).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
    })
    // 建连阶段只有 SDK 的重试（1 次初始 + maxRetries 1 次），适配器不再追加一轮。
    expect(calls()).toBe(2)
    expect(isModelCallError(error) && error.detail.attempts).toHaveLength(2)
  })

  it('AC-007 adds no retry of its own to connect-phase failures', async () => {
    const { port, calls } = setup([busy(503), [...text('ok'), finish()]], {}, 0)
    const error = await failure(port)
    expect(isModelCallError(error) && error.detail).toMatchObject({
      code: 'MODEL_ERROR',
      status: 503,
      retryable: true,
    })
    expect(calls()).toBe(1)
  })

  // undici 在连接中途断开时让响应体流报错 TypeError('terminated')，不是流里的 error 片段。
  const dropping = (before: LanguageModelV4StreamPart[]) => {
    const queue = [...before]
    return new ReadableStream<LanguageModelV4StreamPart>({
      // 逐个交出片段，交完再报错：error() 会丢弃还在队列里的片段。
      pull(c) {
        const next = queue.shift()
        if (next) return c.enqueue(next)
        c.error(
          new TypeError('terminated', {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
          }),
        )
      },
    })
  }

  it('AC-007 retries once when the connection drops mid-stream before any content', async () => {
    const { port, calls } = setup(
      [dropping([{ type: 'stream-start', warnings: [] }]), [...text('ok'), finish()]],
      {},
      0,
    )
    const { response } = await run(port)
    expect(response.text).toBe('ok')
    expect(calls()).toBe(2)
    expect(response.attempts).toHaveLength(2)
  })

  it('AC-007 fails as a retryable connection error when the connection drops after content', async () => {
    const { port, calls } = setup([dropping(text('半')), [...text('ok'), finish()]], {}, 0)
    const error = await failure(port)
    expect(isModelCallError(error) && error.detail).toMatchObject({
      code: 'MODEL_CONNECTION',
      retryable: true,
    })
    expect(calls()).toBe(1)
  })

  it('AC-007 tries once more when the stream fails before any content', async () => {
    const { port, calls } = setup([
      [
        { type: 'stream-start', warnings: [] },
        { type: 'error', error: busy(503) },
      ],
      [...text('ok'), finish()],
    ])
    expect((await run(port)).response.text).toBe('ok')
    expect(calls()).toBe(2)
  })

  it('AC-007 fails without retrying once content has arrived', async () => {
    const { port, calls } = setup([
      [...text('半'), { type: 'error', error: busy(503) }],
      [...text('ok'), finish()],
    ])
    const error = await failure(port)
    expect(isModelCallError(error) && error.detail.code).toBe('MODEL_ERROR')
    expect(calls()).toBe(1)
  })

  it('AC-008 rejects with a cancellation when aborted mid-stream', async () => {
    let push!: (part: LanguageModelV4StreamPart) => void
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (c) => void (push = (p) => c.enqueue(p)),
    })
    const { port } = setup([stream])
    const controller = new AbortController()
    const pending = port.call(input(), {
      signal: controller.signal,
      onDelta: () => controller.abort(),
    })
    push({ type: 'stream-start', warnings: [] })
    push({ type: 'text-start', id: 't' })
    push({ type: 'text-delta', id: 't', delta: 'x' })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('AC-009 sends the reasoning options of the vendor', async () => {
    const { port, model } = setup([[...text('x'), finish()]], {
      vendor: 'anthropic',
      reasoning: 'medium',
    })
    await run(port)
    expect(model.doStreamCalls[0]!.providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
    })
    const plain = setup([[...text('x'), finish()]])
    await run(plain.port)
    expect(plain.model.doStreamCalls[0]!.providerOptions).toBeUndefined()
  })

  it('F20 AC-001 merges the app provider options over the vendor reasoning options per key', async () => {
    const { port, model } = setup([[...text('x'), finish()]], {
      vendor: 'openai',
      reasoning: 'high',
      callSettings: {
        providerOptions: {
          openai: { user: 'u', reasoningEffort: 'low', parallelToolCalls: false },
          custom: { a: 1 },
        },
      },
    })
    await run(port)
    expect(model.doStreamCalls[0]!.providerOptions).toEqual({
      openai: { reasoningEffort: 'low', parallelToolCalls: false, user: 'u' },
      custom: { a: 1 },
    })
  })

  it('AC-007 sends the sampling settings of the input and nothing when they are absent', async () => {
    const { port, model } = setup([[...text('x'), finish()]])
    await run(port, input({ temperature: 0.3, topP: 0.8 }))
    expect(model.doStreamCalls[0]).toMatchObject({ temperature: 0.3, topP: 0.8 })
    await run(port)
    expect(model.doStreamCalls[1]!.temperature).toBeUndefined()
    expect(model.doStreamCalls[1]!.topP).toBeUndefined()
  })

  it('AC-006 declares its settings with header names only', () => {
    const settingsOf = (config: Partial<AiSdkModelConfig>) => setup([[]], config).port.settings
    const configured = settingsOf({
      vendor: 'openai',
      reasoning: 'high',
      callSettings: {
        providerOptions: { openai: { user: 'u' } },
        headers: { 'x-b': '1', 'x-a': '2' },
      },
    })
    expect(configured).toEqual({
      vendor: 'openai',
      reasoning: 'high',
      dropReasoningHistory: false,
      providerOptions: { openai: { user: 'u' } },
      sdkReasoning: null,
      headers: ['x-a', 'x-b'],
    })
    const rotated = settingsOf({
      vendor: 'openai',
      reasoning: 'high',
      callSettings: {
        providerOptions: { openai: { user: 'u' } },
        headers: { 'x-b': '9', 'x-a': '8' },
      },
    })
    expect(rotated).toEqual(configured)
    expect(settingsOf({})).toEqual({
      vendor: 'other',
      reasoning: null,
      dropReasoningHistory: false,
      providerOptions: null,
      sdkReasoning: null,
      headers: [],
    })
  })

  it('F20 AC-002 sends the app headers', async () => {
    const { port, model } = setup([[...text('x'), finish()]], {
      callSettings: { headers: { 'x-a': '1' } },
    })
    await run(port)
    expect(model.doStreamCalls[0]!.headers).toMatchObject({ 'x-a': '1' })
  })

  it('F20 AC-003 sends the top-level AI SDK reasoning setting', async () => {
    const { port, model } = setup([[...text('x'), finish()]], {
      callSettings: { reasoning: 'none' },
    })
    await run(port)
    expect(model.doStreamCalls[0]!.reasoning).toBe('none')
  })

  it('rejects a model that sets both reasoning and callSettings.reasoning, whatever the vendor', () => {
    for (const vendor of ['anthropic', 'openai', 'other'] as const) {
      const both = () =>
        aiSdkProvider({
          id: 'acme',
          models: {
            big: {
              model: new MockLanguageModelV4({}),
              vendor,
              capabilities: { contextLimit: 1000 },
              reasoning: 'off',
              callSettings: { reasoning: 'high' },
            },
          },
        })
      expect(both).toThrow(/^模型 acme:big 同时设置了 reasoning 与 callSettings\.reasoning/)
    }
  })

  it('F20 AC-004 leaves the call unchanged without call settings', async () => {
    const plain = setup([[...text('x'), finish()]])
    await run(plain.port)
    const empty = setup([[...text('x'), finish()]], { callSettings: { providerOptions: {} } })
    await run(empty.port)
    for (const call of [plain.model.doStreamCalls[0]!, empty.model.doStreamCalls[0]!]) {
      expect(call.providerOptions).toBeUndefined()
      expect(call.headers ?? {}).not.toHaveProperty('x-a')
      expect(call.reasoning).not.toBe('none')
    }
    expect(empty.model.doStreamCalls[0]!.reasoning).toBe(plain.model.doStreamCalls[0]!.reasoning)
  })

  it('AC-012 and AC-016 normalize messages for the vendor', async () => {
    const { port, model } = setup([[...text('x'), finish()]], {
      vendor: 'anthropic',
      capabilities: { contextLimit: 1, systemAfterUser: false },
    })
    await run(
      port,
      input({
        messages: [
          { role: 'system', content: '准则' },
          { role: 'user', content: '问题' },
          { role: 'system', content: '[hint] 提示' },
        ],
        cacheBreakpoints: [0],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    expect(prompt[0]).toMatchObject({
      role: 'system',
      content: '准则',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    })
    expect(prompt[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '[system] [hint] 提示' }],
    })
  })

  it('AC-017 places tool result images by the provider of the model instance', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
    const messages: ModelInput['messages'] = [
      { role: 'user', content: '截图' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'shot', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'shot',
            output: '好了',
            images: [{ type: 'image', image: png, mediaType: 'image/png' }],
          },
        ],
      },
    ]
    const promptOf = async (provider: string) => {
      const model = new MockLanguageModelV4({
        provider,
        doStream: async () => ({ stream: convertArrayToReadableStream([...text('x'), finish()]) }),
      })
      const { port } = setup([], { model, capabilities: { contextLimit: 1, inputs: ['image'] } })
      await run(port, input({ messages }))
      return model.doStreamCalls[0]!.prompt
    }

    const chat = await promptOf('openai.chat')
    expect(chat.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(chat[2]).toMatchObject({
      content: [{ output: { type: 'text', value: '好了\n[图片 1 张：见下一条消息]' } }],
    })
    expect(chat[3]).toMatchObject({
      content: [
        { type: 'text', text: '[工具 shot（调用 c1）返回的图片 1 张，不是用户发送的]' },
        { type: 'file', mediaType: 'image/png' },
      ],
    })

    const responses = await promptOf('openai.responses')
    expect(responses.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(responses[2]).toMatchObject({
      content: [{ output: { type: 'content', value: [{ type: 'text' }, { type: 'file' }] } }],
    })
  })

  it('AC-013 drops reasoning history when configured', async () => {
    const { port, model } = setup([[...text('x'), finish()]], { dropReasoningHistory: true })
    await run(
      port,
      input({
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'old' },
              { type: 'text', text: 'a' },
            ],
          },
          { role: 'user', content: 'q2' },
        ],
      }),
    )
    expect(model.doStreamCalls[0]!.prompt[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'a' }],
    })
  })

  it('AC-014 cleans leaked tool call markup from the reply', async () => {
    const { port } = setup([[...text('结论<tool_call>{"name":"x"}</tool_call>'), finish()]])
    expect((await run(port)).response.text).toBe('结论')
  })

  it('AC-015 forbids tool calls during fallback delivery and ignores any returned', async () => {
    const { port, model } = setup([
      [
        ...text('总结'),
        { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: '{}' },
        finish('tool-calls'),
      ],
    ])
    const { response } = await run(
      port,
      input({
        tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }],
        toolChoice: 'none',
      }),
    )
    expect(model.doStreamCalls[0]!.toolChoice).toEqual({ type: 'none' })
    expect(model.doStreamCalls[0]!.tools).toHaveLength(1)
    expect(response).toMatchObject({ text: '总结', toolCalls: [], finishReason: 'stop' })
  })

  it('merges reasoning metadata from start, delta and end and keeps tool call metadata', async () => {
    const { port } = setup([
      [
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: '0' },
        { type: 'reasoning-delta', id: '0', delta: 'think' },
        {
          type: 'reasoning-delta',
          id: '0',
          delta: '',
          providerMetadata: { anthropic: { signature: 'SIG' } },
        },
        { type: 'reasoning-end', id: '0' },
        {
          type: 'reasoning-start',
          id: '1',
          providerMetadata: { anthropic: { redactedData: 'RED' } },
        },
        { type: 'reasoning-end', id: '1' },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'search',
          input: '{}',
          providerMetadata: { google: { thoughtSignature: 'TS' } },
        },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'search', input: '{}' },
        finish('tool-calls'),
      ],
    ])
    const { response } = await run(
      port,
      input({ tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }] }),
    )
    expect(response.reasoning?.providerData).toEqual({
      parts: [
        { text: 'think', providerMetadata: { anthropic: { signature: 'SIG' } } },
        { text: '', providerMetadata: { anthropic: { redactedData: 'RED' } } },
      ],
    })
    expect(response.toolCalls).toEqual([
      { id: 'c1', name: 'search', input: {}, providerData: { google: { thoughtSignature: 'TS' } } },
      { id: 'c2', name: 'search', input: {} },
    ])
  })

  it('makes duplicate tool call ids unique within one response', async () => {
    const call = (id: string, q: string): LanguageModelV4StreamPart => ({
      type: 'tool-call',
      toolCallId: id,
      toolName: 'search',
      input: JSON.stringify({ q }),
    })
    const { port } = setup([
      [call('c1', 'a'), call('c1', 'b'), call('c1_2', 'c'), call('c1', 'd'), finish('tool-calls')],
    ])
    const { response } = await run(
      port,
      input({ tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }] }),
    )
    expect(response.toolCalls.map((c) => [c.id, (c.input as { q: string }).q])).toEqual([
      ['c1', 'a'],
      ['c1_2', 'b'],
      ['c1_2_2', 'c'],
      ['c1_3', 'd'],
    ])
  })

  it('sends the declared output limit when the request sets none, and nothing when undeclared', async () => {
    const declared = setup([text('x')], {
      capabilities: { contextLimit: 100_000, maxOutputTokens: 64_000 },
    })
    await run(declared.port, input())
    expect(declared.model.doStreamCalls[0]!.maxOutputTokens).toBe(64_000)
    const plain = setup([text('x')])
    await run(plain.port, input())
    expect(plain.model.doStreamCalls[0]!.maxOutputTokens).toBeUndefined()
  })

  it('maps other finish reasons and passes the output limit', async () => {
    const { port, model } = setup([[...text('x'), finish('error')]])
    const { response } = await run(port, input({ maxOutputTokens: 100 }))
    expect(response.finishReason).toBe('other')
    expect(model.doStreamCalls[0]!.maxOutputTokens).toBe(100)
  })
})
