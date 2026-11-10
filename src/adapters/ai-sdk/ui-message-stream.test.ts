// F29：运行 → AI SDK UI message stream（设计 §2）。用引擎实跑，断言片段序列、校正、续流与 SSE 响应；
// 组装消息用 AI SDK 自己的 readUIMessageStream，解析响应用它的 parseJsonEventStream。

import {
  UI_MESSAGE_STREAM_HEADERS,
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
} from 'ai'
import { describe, expect, it } from 'vitest'
import {
  ModelCallError,
  assembleEngine,
  defineAgent,
  defineTask,
  memoryArchive,
  modelHub,
  toolError,
  type AgentDef,
  type ApprovalAnswer,
  type ArchiveStore,
  type Assignment,
  type Delta,
  type ModelPort,
  type ModelProvider,
  type ModelResponse,
  type PermissionRule,
  type Run,
  type RunEvent,
  type ToolDef,
} from '../../sdk.js'
import { testDefaults } from '../../testing/engine.fixture.js'
import { fakeModel, type FakeReply } from '../../testing/fake-model.js'
import { fakeTool } from '../../testing/fake-tool.js'
import * as entry from './ai-sdk-provider.js'
import {
  runToUIMessageStream,
  runToUIMessageStreamResponse,
  type RunUIMessage,
  type RunUIMessageChunk,
} from './ui-message-stream.js'

// ── 装配 ──────────────────────────────────────────────────────────

const sys = { role: 'system' as const, parts: [{ type: 'text' as const, text: '你是助手' }] }
const ask = (text: string) =>
  defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text }] }] })

interface Setup {
  replies?: FakeReply[]
  provider?: ModelProvider & { ref: string }
  tools?: ToolDef[]
  permissions?: PermissionRule[]
  approve?: () => Promise<ApprovalAnswer>
  agent?: Partial<AgentDef>
}

function setup(o: Setup) {
  const model = o.provider ?? fakeModel({ model: 'main', replies: o.replies ?? [] })
  const archive = memoryArchive()
  const engine = assembleEngine(
    { services: { models: modelHub({ providers: [model], default: model.ref }), archive } },
    testDefaults(),
  )
  const env = engine.environment({
    name: 'web',
    principal: { reachable: true, ...(o.approve ? { approver: { approve: o.approve } } : {}) },
    permissions: o.permissions ?? [],
  })
  const agent = defineAgent({
    id: 'helper',
    instructions: [sys],
    capabilities: [
      {
        id: 'tools',
        version: '1',
        kind: 'tool',
        prepare: async () => ({ tools: o.tools ?? [], snapshot: { fingerprint: 'fp' } }),
      },
    ],
    ...o.agent,
  })
  return {
    archive,
    start: (text = '你好', assignment?: Assignment) => env.start(agent, ask(text), assignment),
  }
}

/** 需要审批的规则：只拦 `send`。 */
const askRule = (summary: string, extra: Partial<PermissionRule> = {}): PermissionRule => ({
  id: 'letters',
  version: '1',
  permit: async (call) => (call.toolName === 'send' ? { ask: { summary, risk: 'high' } } : 'allow'),
  ...extra,
})
const sendCall: FakeReply = { toolCalls: [{ id: 'm1', name: 'send', input: { to: '星河' } }] }
const lookupCall = { toolCalls: [{ id: 'l1', name: 'lookup', input: { q: '东京' } }] }

/** 按脚本逐段推送增量的模型；`holdAt` 处挂起，`release` 后继续。 */
function scriptedModel(
  steps: Array<{
    deltas?: Delta[]
    text?: string
    reasoning?: string
    toolCalls?: ModelResponse['toolCalls']
    holdAt?: number
    error?: string
  }>,
) {
  const ref = 'script:main'
  let n = 0
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  let arrive = () => {}
  const reached = new Promise<void>((r) => (arrive = r))
  const port: ModelPort = {
    ref,
    capabilities: {
      contextLimit: 128_000,
      maxOutputTokens: 8192,
      inputs: [],
      toolCalls: true,
      reasoning: 'none',
      systemAfterUser: true,
      parallelToolCalls: true,
    },
    async call(_input, { onDelta }) {
      const s = steps[n++]!
      for (const [i, d] of (s.deltas ?? []).entries()) {
        if (s.holdAt === i) {
          arrive()
          await held
        }
        onDelta(d)
        await Promise.resolve()
      }
      if (s.error) {
        throw new ModelCallError({
          code: 'AUTH_FAILED',
          message: s.error,
          retryable: false,
          attempts: [],
        })
      }
      const toolCalls = s.toolCalls ?? []
      return {
        text: s.text ?? '',
        ...(s.reasoning ? { reasoning: { text: s.reasoning } } : {}),
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        warnings: [],
        attempts: [],
      }
    },
  }
  const provider = { id: 'script', ref, resolve: (r: string) => (r === ref ? port : undefined) }
  return { provider, reached, release: () => release() }
}

// ── 读取与组装 ──────────────────────────────────────────────────────

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  for (let r = await reader.read(); !r.done; r = await reader.read()) out.push(r.value)
  return out
}

/** 边读边记：随时可以看已经收到的片段。 */
function tap<T>(stream: ReadableStream<T>) {
  const seen: T[] = []
  const done = (async () => {
    const reader = stream.getReader()
    for (let r = await reader.read(); !r.done; r = await reader.read()) seen.push(r.value)
  })()
  return { seen, done }
}

const streamOf = <T>(items: T[]) =>
  new ReadableStream<T>({
    start(c) {
      for (const i of items) c.enqueue(i)
      c.close()
    },
  })

/** 用 AI SDK 的 readUIMessageStream 组装成前端看到的消息。 */
async function build(chunks: RunUIMessageChunk[]): Promise<RunUIMessage | undefined> {
  let last: RunUIMessage | undefined
  for await (const m of readUIMessageStream<RunUIMessage>({ stream: streamOf(chunks) })) last = m
  return last
}

const texts = (m: RunUIMessage | undefined) =>
  (m?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : []))
const toolChunks = (chunks: RunUIMessageChunk[]) => chunks.filter((c) => c.type.startsWith('tool-'))

async function eventsOf(archive: ArchiveStore, runId: string): Promise<RunEvent[]> {
  const out: RunEvent[] = []
  for await (const e of archive.read(runId)) out.push(e)
  return out
}

/** 拆开 SSE 正文：每块的 `id` 与片段。 */
async function sse(res: Response): Promise<Array<{ id?: number; chunk: RunUIMessageChunk }>> {
  const blocks = (await res.text()).split('\n\n').filter((b) => b !== '')
  expect(blocks.at(-1)).toBe('data: [DONE]')
  return blocks.slice(0, -1).map((block) => {
    const lines = block.split('\n')
    const id = lines.find((l) => l.startsWith('id: '))
    const data = lines.find((l) => l.startsWith('data: '))!
    return {
      ...(id ? { id: Number(id.slice(4)) } : {}),
      chunk: JSON.parse(data.slice(6)) as RunUIMessageChunk,
    }
  })
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ── 映射 ──────────────────────────────────────────────────────────

describe('runToUIMessageStream: mapping', () => {
  it('AC-001 streams the reasoning and text of a step, then the outcome', async () => {
    const { start } = setup({ replies: [{ reasoning: { text: '想一想' }, text: '你好' }] })
    const run = start()
    const chunks = await collect(runToUIMessageStream(run))
    expect(chunks.slice(0, -1)).toEqual([
      { type: 'start', messageId: run.runId, messageMetadata: { runId: run.runId } },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'reasoning-1' },
      { type: 'reasoning-delta', id: 'reasoning-1', delta: '想一想' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: '你好' },
      { type: 'reasoning-end', id: 'reasoning-1' },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish-step' },
    ])
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: { runId: run.runId, status: 'completed' },
    })
    const message = await build(chunks)
    expect(message?.id).toBe(run.runId)
    expect(message?.parts.map((p) => p.type)).toEqual(['step-start', 'reasoning', 'text'])
  })

  it('AC-002 shows a tool call through its approval and result', async () => {
    const send = fakeTool({ name: 'send', result: '已发出' })
    const { start, archive } = setup({
      replies: [sendCall, { text: '函已发出' }],
      tools: [send],
      // 影子规则也写 permission_decided，但不进审批理由。
      permissions: [askRule('发函给星河'), askRule('影子', { id: 'mirror', mode: 'shadow' })],
      approve: async () => ({ approved: true }),
    })
    const chunks = await collect(runToUIMessageStream(start(), { archive }))
    expect(toolChunks(chunks)).toEqual([
      { type: 'tool-input-available', toolCallId: 'm1', toolName: 'send', input: { to: '星河' } },
      { type: 'tool-approval-request', approvalId: 'm1', toolCallId: 'm1', reason: '发函给星河' },
      { type: 'tool-approval-response', approvalId: 'm1', approved: true },
      { type: 'tool-output-available', toolCallId: 'm1', output: '已发出' },
    ])
    const message = await build(chunks)
    expect(message?.parts.find((p) => p.type === 'tool-send')).toMatchObject({
      state: 'output-available',
      output: '已发出',
      approval: { id: 'm1', approved: true },
    })
  })

  it('AC-003 marks denied calls, failed calls, and results without an archive', async () => {
    const send = fakeTool({ name: 'send', result: '已发出' })
    const denied = setup({
      replies: [sendCall, { text: '好的，不发了' }],
      tools: [send],
      permissions: [askRule('发函给星河')],
      approve: async () => ({ approved: false }),
    })
    expect(
      toolChunks(await collect(runToUIMessageStream(denied.start(), { archive: denied.archive }))),
    ).toEqual([
      { type: 'tool-input-available', toolCallId: 'm1', toolName: 'send', input: { to: '星河' } },
      { type: 'tool-approval-request', approvalId: 'm1', toolCallId: 'm1', reason: '发函给星河' },
      { type: 'tool-approval-response', approvalId: 'm1', approved: false },
      { type: 'tool-output-denied', toolCallId: 'm1' },
    ])

    const broken = fakeTool({ name: 'broken', result: toolError('TOOL_FAILED', 'boom') })
    const lookup = fakeTool({ name: 'lookup', result: '东京 晴' })
    const replies: FakeReply[] = [
      {
        toolCalls: [
          { id: 'b1', name: 'broken', input: {} },
          { id: 'l1', name: 'lookup', input: {} },
        ],
      },
      { text: '查到了' },
    ]
    const failed = setup({ replies, tools: [broken, lookup] })
    const outputs = (chunks: RunUIMessageChunk[]) =>
      chunks.filter((c) => c.type === 'tool-output-error' || c.type === 'tool-output-available')
    expect(
      outputs(await collect(runToUIMessageStream(failed.start(), { archive: failed.archive }))),
    ).toEqual([
      { type: 'tool-output-error', toolCallId: 'b1', errorText: 'ERROR [TOOL_FAILED]: boom' },
      { type: 'tool-output-available', toolCallId: 'l1', output: '东京 晴' },
    ])

    const bare = setup({ replies, tools: [broken, lookup] })
    expect(outputs(await collect(runToUIMessageStream(bare.start())))).toEqual([
      { type: 'tool-output-error', toolCallId: 'b1', errorText: 'TOOL_FAILED' },
      { type: 'tool-output-available', toolCallId: 'l1' },
    ])
  })

  it('AC-003 treats an unreadable result as one without an archive', async () => {
    const lookup = fakeTool({ name: 'lookup', result: '东京 晴' })
    const { start } = setup({
      replies: [{ toolCalls: [{ id: 'l1', name: 'lookup', input: {} }] }, { text: '晴' }],
      tools: [lookup],
    })
    const archive = {
      getBlob: async () => {
        throw new Error('gone')
      },
    }
    const chunks = await collect(runToUIMessageStream(start(), { archive }))
    expect(chunks.find((c) => c.type === 'tool-output-available')).toEqual({
      type: 'tool-output-available',
      toolCallId: 'l1',
    })
  })

  it('AC-004 leaves a deferred approval waiting and reports approval_pending', async () => {
    const send = fakeTool({ name: 'send', result: '已发出' })
    const { start, archive } = setup({
      replies: [sendCall, { text: '不会走到这里' }],
      tools: [send],
      permissions: [askRule('发函给星河')],
      approve: async () => ({ defer: '等律师复核' }),
    })
    const run = start()
    const chunks = await collect(runToUIMessageStream(run, { archive }))
    expect(toolChunks(chunks)).toEqual([
      { type: 'tool-input-available', toolCallId: 'm1', toolName: 'send', input: { to: '星河' } },
      { type: 'tool-approval-request', approvalId: 'm1', toolCallId: 'm1', reason: '发函给星河' },
    ])
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: { runId: run.runId, status: 'awaiting_input', code: 'approval_pending' },
    })
    const message = await build(chunks)
    expect(message?.parts.find((p) => p.type === 'tool-send')).toMatchObject({
      state: 'approval-requested',
    })
  })

  it('AC-005 reports the intent a run ended waiting on', async () => {
    const askUser = fakeTool({
      name: 'ask_user',
      effect: 'none',
      intent: { kind: 'await_input', code: 'ask_user' },
      result: '问题已发送给委托人',
    })
    const { start, archive } = setup({
      replies: [{ toolCalls: [{ id: 'q1', name: 'ask_user', input: { question: '几号入职？' } }] }],
      tools: [askUser],
    })
    const run = start()
    const chunks = await collect(runToUIMessageStream(run, { archive }))
    expect(chunks.find((c) => c.type === 'tool-output-available')).toEqual({
      type: 'tool-output-available',
      toolCallId: 'q1',
      output: '问题已发送给委托人',
    })
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: {
        runId: run.runId,
        status: 'awaiting_input',
        code: 'ask_user',
        intent: { tool: 'ask_user', input: { question: '几号入职？' } },
      },
    })
  })

  it('AC-006 drops a returned draft, and a draft replaced by the fallback', async () => {
    const strict = (bad: (text: string) => boolean): Partial<AgentDef> => {
      const defaults = testDefaults().deliverable
      return {
        deliverable: {
          ...defaults,
          output: {
            ...defaults.output,
            validate: async (c) =>
              bad(c.text ?? '') ? { ok: false, issues: ['不完整'], hint: '写完整' } : { ok: true },
          },
        },
      }
    }
    const returned = setup({
      replies: [{ text: '草稿' }, { text: '正式回答' }],
      agent: strict((t) => t === '草稿'),
    })
    const once = await collect(runToUIMessageStream(returned.start()))
    expect(once.map((c) => c.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'reset-step',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ])
    expect(texts(await build(once))).toEqual(['正式回答'])

    const fallback = setup({
      replies: [{ text: '草稿' }, { text: '草稿二' }, { text: '兜底说明' }],
      agent: strict(() => true),
    })
    const run = fallback.start()
    const chunks = await collect(runToUIMessageStream(run))
    expect(chunks.slice(-7)).toEqual([
      { type: 'reset-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-fallback' },
      { type: 'text-delta', id: 'text-fallback', delta: '兜底说明' },
      { type: 'text-end', id: 'text-fallback' },
      { type: 'finish-step' },
      expect.objectContaining({ type: 'finish', finishReason: 'stop' }),
    ])
    expect((await run.result).status).toBe('finalized')
    expect(texts(await build(chunks))).toEqual(['兜底说明'])
  })

  it('AC-007 ends failed runs with an error after the outcome', async () => {
    const { start } = setup({ replies: [{ error: { code: 'AUTH_FAILED', message: 'bad key' } }] })
    const run = start()
    const chunks = await collect(runToUIMessageStream(run))
    const result = await run.result
    expect(result.status).toBe('failed')
    expect(chunks.slice(-2)).toEqual([
      {
        type: 'finish',
        finishReason: 'error',
        messageMetadata: {
          runId: run.runId,
          status: 'failed',
          code: result.code,
          error: result.error,
        },
      },
      { type: 'error', errorText: `${result.error!.code}: ${result.error!.message}` },
    ])
  })

  it('AC-007 ends aborted runs with abort, then an interrupted finish', async () => {
    const { start } = setup({ replies: [{ hang: true }] })
    const run = start()
    const stream = tap(runToUIMessageStream(run))
    await tick()
    run.abort('user')
    await stream.done
    expect(stream.seen.slice(-2)).toEqual([
      { type: 'abort', reason: 'user' },
      {
        type: 'finish',
        finishReason: 'interrupted',
        messageMetadata: { runId: run.runId, status: 'aborted', code: 'user' },
      },
    ])
  })

  it('AC-007 ends stopped runs with finish reason other', async () => {
    const blocked = fakeTool({
      name: 'report_blocked',
      effect: 'none',
      intent: { kind: 'stop', code: 'blocked' },
      result: '已报告受阻',
    })
    const { start } = setup({
      replies: [{ toolCalls: [{ id: 'r1', name: 'report_blocked', input: { reason: '缺材料' } }] }],
      tools: [blocked],
    })
    const run = start()
    const chunks = await collect(runToUIMessageStream(run))
    expect((await run.result).status).toBe('stopped')
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'other',
      messageMetadata: { status: 'stopped', code: 'blocked' },
    })
  })

  it('AC-011 sends tool progress as a transient data part', async () => {
    const search = fakeTool({
      name: 'search',
      effect: 'none',
      run: (_input, ctx) => {
        ctx.progress('查到 3 条')
        return '3 条结果'
      },
    })
    const { start } = setup({
      replies: [{ toolCalls: [{ id: 's1', name: 'search', input: {} }] }, { text: '找到了' }],
      tools: [search],
    })
    const chunks = await collect(runToUIMessageStream(start()))
    expect(chunks).toContainEqual({
      type: 'data-tool-progress',
      id: 's1',
      data: { toolCallId: 's1', note: '查到 3 条' },
      transient: true,
    })
    const message = await build(chunks)
    expect(message?.parts.some((p) => p.type === 'data-tool-progress')).toBe(false)
  })

  it('AC-012 shows a delegated child run as one tool call of its parent', async () => {
    const child = defineAgent({ id: 'researcher', instructions: [sys] })
    const delegate = fakeTool({
      name: 'delegate',
      effect: 'none',
      run: async (_input, ctx) => (await ctx.spawn(child, ask('查类案'))).text ?? '',
    })
    const { start, archive } = setup({
      replies: [
        { toolCalls: [{ id: 'd1', name: 'delegate', input: { task: '查类案' } }] },
        { text: '子结果' },
        { text: '查完了' },
      ],
      tools: [delegate],
    })
    const run = start()
    const chunks = await collect(runToUIMessageStream(run, { archive }))
    expect((await run.result).status).toBe('completed')
    expect(chunks.filter((c) => c.type === 'start-step')).toHaveLength(2)
    expect(chunks.find((c) => c.type === 'tool-output-available')).toEqual({
      type: 'tool-output-available',
      toolCallId: 'd1',
      output: '子结果',
    })
    expect(texts(await build(chunks))).toEqual(['查完了'])
  })
})

// ── 实时增量与校正 ──────────────────────────────────────────────────

describe('runToUIMessageStream: live deltas', () => {
  it('AC-009 ends with the same message live as in a replay, resetting a step that drifted', async () => {
    const lookup = fakeTool({ name: 'lookup', effect: 'none', result: '东京 晴' })
    const { provider } = scriptedModel([
      {
        // 模型适配器清掉了泄漏的工具标记：增量拼起来不是最终文本的前缀。
        deltas: [
          { type: 'text', text: '我' },
          { type: 'text', text: '查<tool_call>{}</tool_call>' },
        ],
        text: '我查',
        toolCalls: [{ id: 'l1', name: 'lookup', input: {} }],
      },
      {
        deltas: [
          { type: 'reasoning', text: '看结果' },
          { type: 'text', text: '东' },
          { type: 'text', text: '京晴' },
        ],
        reasoning: '看结果',
        text: '东京晴',
      },
    ])
    const { start, archive } = setup({ provider, tools: [lookup] })
    const run = start()
    const live = await collect(runToUIMessageStream(run, { archive }))
    const replay = await collect(runToUIMessageStream(run, { archive }))
    expect(live.filter((c) => c.type === 'reset-step')).toHaveLength(1)
    expect(live.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual([
      '我',
      '查<tool_call>{}</tool_call>',
      '我查',
      '东',
      '京晴',
    ])
    expect(replay.some((c) => c.type === 'reset-step')).toBe(false)
    expect(await build(live)).toEqual(await build(replay))
    expect(texts(await build(live))).toEqual(['我查', '东京晴'])
  })

  it('AC-009 removes the text of a model call that failed after streaming', async () => {
    const { provider } = scriptedModel([
      { deltas: [{ type: 'text', text: '半句' }], error: 'bad key' },
    ])
    const { start } = setup({ provider })
    const run = start()
    const chunks = await collect(runToUIMessageStream(run))
    expect(chunks.map((c) => c.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'reset-step',
      'finish',
      'error',
    ])
    expect(texts(await build(chunks))).toEqual([])
  })

  it('AC-010 converges when a stream joins a model call halfway', async () => {
    const { provider, reached, release } = scriptedModel([
      {
        deltas: [
          { type: 'text', text: '前半' },
          { type: 'text', text: '后半' },
        ],
        text: '前半后半',
        holdAt: 1,
      },
    ])
    const { start, archive } = setup({ provider })
    const run = start()
    const first = tap(runToUIMessageStream(run))
    await reached
    await tick()
    // 原连接此刻已收到的片段：模拟断线前的前端。
    const received = [...first.seen]
    expect(received.at(-1)).toEqual({ type: 'text-delta', id: 'text-1', delta: '前半' })
    const stepStarted = (await eventsOf(archive, run.runId)).find((e) => e.t === 'step_started')!
    const replay = tap(runToUIMessageStream(run))
    const resumed = tap(runToUIMessageStream(run, { fromSeq: stepStarted.seq + 1 }))
    await tick()
    release()
    await Promise.all([first.done, replay.done, resumed.done])

    const final = await build(await collect(runToUIMessageStream(run)))
    expect(texts(final)).toEqual(['前半后半'])
    expect(await build(replay.seen)).toEqual(final)
    // 续流不转发这一步的实时增量：落定时先清掉旧连接的半截，再整段发出。
    expect(resumed.seen.slice(0, 4)).toEqual([
      { type: 'reset-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: '前半后半' },
      { type: 'text-end', id: 'text-1' },
    ])
    expect(await build([...received, ...resumed.seen])).toEqual(final)
  })
})

// ── 续流与响应 ──────────────────────────────────────────────────────

describe('runToUIMessageStream: resume', () => {
  it('AC-008 continues from any seq without duplicates or gaps', async () => {
    const send = fakeTool({ name: 'send', result: '已发出' })
    const lookup = fakeTool({ name: 'lookup', effect: 'none', result: '东京 晴' })
    const { start, archive } = setup({
      replies: [
        { reasoning: { text: '先查' }, text: '我先查一下', ...lookupCall },
        sendCall,
        { text: '函已发出' },
      ],
      tools: [send, lookup],
      permissions: [askRule('发函给星河')],
      approve: async () => ({ approved: true }),
    })
    const run = start()
    await run.result
    const full = await sse(runToUIMessageStreamResponse(run, { archive }))
    const expected = await build(full.map((f) => f.chunk))
    const last = (await eventsOf(archive, run.runId)).at(-1)!.seq
    for (let k = 1; k <= last + 1; k++) {
      // 前端已完整收到 seq < k 的事件产生的片段（截到最后一个 id < k 的片段为止）。
      const cut = full.findLastIndex((f) => f.id !== undefined && f.id < k)
      const prefix = full.slice(0, cut + 1).map((f) => f.chunk)
      const rest = await collect(runToUIMessageStream(run, { archive, fromSeq: k }))
      if (k > 1) expect(rest.some((c) => c.type === 'start')).toBe(false)
      expect(await build([...prefix, ...rest]), `fromSeq ${k}`).toEqual(expected)
    }
  })

  it('AC-013 rejects a fromSeq that is not a positive integer', () => {
    const { start } = setup({ replies: [{ text: '你好' }] })
    const run = start()
    expect(() => runToUIMessageStream(run, { fromSeq: 0 })).toThrow(RangeError)
    expect(() => runToUIMessageStream(run, { fromSeq: 1.5 })).toThrow(RangeError)
  })
})

describe('runToUIMessageStreamResponse', () => {
  it('AC-013 writes SSE that the AI SDK parses, with the event seq as id', async () => {
    const { start, archive } = setup({ replies: [{ text: '你好' }] })
    const run = start()
    await run.result
    const res = runToUIMessageStreamResponse(run, { headers: { 'x-run-id': run.runId } })
    expect(res.status).toBe(200)
    for (const [name, value] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) {
      expect(res.headers.get(name)).toBe(value)
    }
    expect(res.headers.get('x-run-id')).toBe(run.runId)

    const [parsedBody, rawBody] = res.body!.tee()
    const parsed = await collect(
      parseJsonEventStream({ stream: parsedBody, schema: uiMessageChunkSchema }),
    )
    expect(parsed.every((p) => p.success)).toBe(true)

    const blocks = await sse(new Response(rawBody))
    const seqOf = Object.fromEntries(
      (await eventsOf(archive, run.runId)).map((e) => [e.t, e.seq] as const),
    )
    expect(blocks.map((b) => [b.chunk.type, b.id])).toEqual([
      ['start', seqOf.run_started],
      ['start-step', seqOf.step_started],
      ['text-start', undefined],
      ['text-delta', undefined],
      ['text-end', seqOf.model_responded],
      ['finish-step', seqOf.step_ended],
      ['finish', seqOf.run_ended],
    ])
  })

  it('AC-013 lets go of the run when the reader cancels, without stopping it', async () => {
    const { provider, reached, release } = scriptedModel([
      {
        deltas: [
          { type: 'text', text: '你' },
          { type: 'text', text: '好' },
        ],
        text: '你好',
        holdAt: 1,
      },
    ])
    const { start } = setup({ provider })
    const run = start()
    let detached = false
    const watched: Run = {
      runId: run.runId,
      result: run.result,
      subscribe: (sub, opts) => {
        const off = run.subscribe(sub, opts)
        return () => {
          detached = true
          off()
        }
      },
      steer: (text) => run.steer(text),
      abort: (reason) => run.abort(reason),
    }
    const reader = runToUIMessageStreamResponse(watched).body!.getReader()
    await reader.read()
    await reached
    await reader.cancel()
    // 取消沿管道向上游传递是异步的。
    await tick()
    expect(detached).toBe(true)
    release()
    expect((await run.result).status).toBe('completed')
  })

  it('AC-014 is exported from the ai-sdk subpath entry', () => {
    expect(entry.runToUIMessageStream).toBe(runToUIMessageStream)
    expect(entry.runToUIMessageStreamResponse).toBe(runToUIMessageStreamResponse)
  })
})
