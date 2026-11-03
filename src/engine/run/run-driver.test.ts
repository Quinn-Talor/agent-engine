import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../contracts/agent.js'
import type { Capability } from '../../contracts/capability.js'
import type { LogEntry } from '../../contracts/common.js'
import type {
  Check,
  Corpus,
  Guard,
  Memory,
  NoticeProvider,
  PermissionRule,
} from '../../contracts/component.js'
import type { Environment, EnvironmentConfig } from '../../contracts/environment.js'
import type { RunEvent } from '../../contracts/events.js'
import type { ModelPrice } from '../../contracts/model.js'
import type { RunResult } from '../../contracts/run.js'
import type { Task } from '../../contracts/task.js'
import type { ToolCtx, ToolDef } from '../../contracts/tool.js'
import { createAdmission } from '../../services/admission.js'
import { checkInvariants } from '../../core/log/invariants.js'
import { strictReplay } from '../../core/log/replay.js'
import { sideEffects } from '../../core/log/projections.js'
import { memoryArchive } from '../../services/memory-archive.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { fakeModel, type FakeModel, type FakeReply } from '../../testing/fake-model.js'
import { fakeTool } from '../../testing/fake-tool.js'
import { agentOf, defaults, hubOf, passMemory, taskOf } from '../engine.fixture.js'
import { startRun, type EngineRuntime, type EnvironmentRuntime } from './run-driver.js'

/** 第 1 步告知、之后要求收尾的任务守卫。 */
const stall: Guard = {
  id: 'stall-check',
  version: '1',
  start: () => ({
    check: (facts) =>
      facts.step === 1
        ? { warn: { problem: '没有进展' } }
        : { end: { as: 'finalize', code: 'stall' } },
  }),
}
const lookup = (id: string) => ({ toolCalls: [{ id, name: 'lookup', input: { q: id } }] })

const toolsCap = (...tools: ToolDef[]): Capability => ({
  id: 'core',
  version: '1',
  kind: 'tool',
  prepare: async () => ({ tools, snapshot: { fingerprint: 'fp-core' } }),
})

function harness(opts: {
  replies: FakeReply[]
  memory?: Memory
  environment?: Partial<EnvironmentConfig>
  /** 另外的模型（子 agent 用 `model.prefer` 选择），共用测试时钟。 */
  models?: (clock: FakeClock) => FakeModel[]
  prices?: Record<string, ModelPrice>
}) {
  const clock = new FakeClock()
  const model = fakeModel({ model: 'main', clock, replies: opts.replies })
  const others = opts.models?.(clock) ?? []
  const archive = memoryArchive()
  const logs: LogEntry[] = []
  const envs = new Map<unknown, EnvironmentRuntime>()
  const engine: EngineRuntime = {
    hub: hubOf([model.port, ...others.map((m) => m.port)], {
      defaultModel: 'fake:main',
      ...(opts.prices ? { prices: opts.prices } : {}),
    }),
    archive,
    clock,
    logger: { log: (e) => logs.push(e) },
    admission: createAdmission({ clock }),
    hosts: new Map(),
    memory: opts.memory ?? passMemory(),
    guards: [],
    defaults: defaults(),
    fingerprint: 'engine-fp',
    environmentOf: (e) => envs.get(e),
    sessions: new Map(),
    recovered: Promise.resolve(),
  }
  const config: EnvironmentConfig = {
    name: 'test',
    principal: { reachable: true },
    ...opts.environment,
  }
  const env: EnvironmentRuntime = {
    config,
    fingerprint: 'env-fp',
    handle: { name: 'test', fingerprint: 'env-fp', start: () => undefined as never },
  }
  envs.set(env.handle, env)
  /** 再登记一个执行环境，供 `spawn(..., { environment })` 使用。 */
  const addEnvironment = (extra: EnvironmentConfig): Environment => {
    const handle: Environment = {
      name: extra.name,
      fingerprint: `${extra.name}-fp`,
      start: () => undefined as never,
    }
    envs.set(handle, { config: extra, fingerprint: handle.fingerprint, handle })
    return handle
  }
  const start = (agent: Agent = agentOf(), task: Task = taskOf()) =>
    startRun(engine, env, { agent, task })
  const read = async (runId: string) => {
    const out: RunEvent[] = []
    for await (const e of archive.read(runId)) out.push(e)
    return out
  }
  const children = async (runId: string) => {
    const summaries = await archive.query({ parentRunId: runId })
    return Promise.all(summaries.map(async (s) => ({ summary: s, events: await read(s.runId) })))
  }
  return { clock, model, others, archive, logs, engine, env, addEnvironment, start, read, children }
}

const types = (events: readonly RunEvent[]) => events.map((e) => e.t)

describe('startRun', () => {
  it('AC-016 runs a text reply end to end and replays events to late subscribers', async () => {
    const h = harness({ replies: [{ text: '你好！', usage: { input: 12, output: 4 } }] })
    const { run } = h.start()
    const live: string[] = []
    run.subscribe({ onEvent: (e) => void live.push(e.t) })
    const result = await run.result
    expect(result).toMatchObject({
      runId: run.runId,
      status: 'completed',
      text: '你好！',
      model: 'fake:main',
      steps: 1,
      toolCalls: 0,
    })
    expect(result.usage.main).toEqual({ input: 12, output: 4, cacheRead: 0, cacheWrite: 0 })
    const events = await h.read(run.runId)
    expect(types(events)).toEqual([
      'run_started',
      'step_started',
      'context_built',
      'model_responded',
      'evaluated',
      'step_ended',
      'delivery_checked',
      'run_ended',
    ])
    expect(live).toEqual(types(events))
    expect(events[0]).toMatchObject({
      t: 'run_started',
      agent: { id: 'helper' },
      environment: { name: 'test', fingerprint: 'env-fp', principalReachable: true },
      engine: { fingerprint: 'engine-fp' },
      model: 'fake:main',
      contextLimit: 128_000,
      outputReserve: 8192,
      queuedMs: 0,
      rootRunId: run.runId,
      schemaVersion: 1,
    })
    const late: RunEvent[] = []
    run.subscribe({ onEvent: (e) => void late.push(e) }, { fromSeq: 7 })
    await vi.waitFor(() => expect(types(late)).toEqual(['delivery_checked', 'run_ended']))
  })

  it('AC-007 reserves the declared output, at most half of a small window', async () => {
    const h = harness({
      replies: [{ text: 'unused' }],
      models: (clock) => [
        fakeModel({
          model: 'tiny',
          clock,
          replies: [{ text: 'ok' }],
          capabilities: { contextLimit: 10_000, maxOutputTokens: 8192 },
        }),
      ],
    })
    const { run } = h.start(agentOf({ model: { prefer: 'fake:tiny' } }))
    await run.result
    const [started] = await h.read(run.runId)
    expect(started).toMatchObject({ t: 'run_started', contextLimit: 10_000, outputReserve: 5000 })
    // 预留被压到窗口的一半时，请求的输出上限也跟着压，输入 + 输出才放得进窗口。
    expect(h.others[0]!.inputs[0]!.maxOutputTokens).toBe(5000)
  })

  it('AC-016 keeps running when a subscriber fails and forwards text deltas', async () => {
    const h = harness({ replies: [{ text: 'ok' }] })
    const { run } = h.start()
    const deltas: string[] = []
    const off = run.subscribe({
      onEvent: () => {
        throw new Error('ui crashed')
      },
      onNotice: (n) => {
        if (n.t === 'text_delta') deltas.push(n.text)
        if (n.t === 'delivered') throw new Error('notice crashed')
      },
    })
    expect((await run.result).status).toBe('completed')
    expect(deltas).toEqual(['ok'])
    expect(h.logs.some((l) => l.level === 'warn' && l.message === '订阅者出错')).toBe(true)
    off()
    run.steer('too late')
    expect(types(await h.read(run.runId))).not.toContain('steer_received')
  })

  it('AC-017 executes tool calls and sums steps, calls and usage', async () => {
    const lookup = fakeTool({ name: 'lookup', result: 'found it' })
    const h = harness({
      replies: [
        {
          toolCalls: [{ id: 'c1', name: 'lookup', input: { q: 'x' } }],
          usage: { input: 10, output: 5 },
        },
        { text: 'done', usage: { input: 20, output: 3 } },
      ],
    })
    const { run } = h.start(agentOf({ capabilities: [toolsCap(lookup)] }))
    const result = await run.result
    expect(result).toMatchObject({ status: 'completed', text: 'done', steps: 2, toolCalls: 1 })
    expect(result.usage.main).toEqual({ input: 30, output: 8, cacheRead: 0, cacheWrite: 0 })
    expect(lookup.calls).toHaveLength(1)
    expect(lookup.calls[0]!.ctx.idempotencyKey).toBe(`${run.runId}:c1`)
    const second = h.model.inputs[1]!.messages
    expect(second.at(-1)).toMatchObject({
      role: 'tool',
      content: [{ toolCallId: 'c1', toolName: 'lookup', isError: false }],
    })
  })

  it('AC-018 appends a steer after the tool results of the step it arrived in', async () => {
    let release!: () => void
    let started = false
    const slow = fakeTool({
      name: 'slow',
      run: () =>
        new Promise((resolve) => {
          started = true
          release = () => resolve('slow done')
        }),
    })
    const h = harness({
      replies: [{ toolCalls: [{ id: 'c1', name: 'slow' }] }, { text: 'ok' }],
    })
    const { run } = h.start(agentOf({ capabilities: [toolsCap(slow)] }))
    await vi.waitFor(() => expect(started).toBe(true))
    run.steer('换个方向')
    release()
    await run.result
    const events = await h.read(run.runId)
    expect(events.filter((e) => e.t === 'steer_received')).toEqual([
      expect.objectContaining({ text: '换个方向' }),
    ])
    const second = h.model.inputs[1]!.messages
    expect(second.slice(-2).map((m) => m.role)).toEqual(['tool', 'user'])
    expect(second.at(-1)).toEqual({ role: 'user', content: '换个方向' })
  })

  it('AC-019 aborts during a model call', async () => {
    const h = harness({ replies: [{ hang: true }] })
    const { run } = h.start()
    await vi.waitFor(() => expect(h.model.inputs).toHaveLength(1))
    run.abort('用户点了停止')
    const result = await run.result
    expect(result).toMatchObject({ status: 'aborted', code: 'user' })
    expect(types(await h.read(run.runId))).toContain('model_aborted')
    expect(types(await h.read(run.runId)).at(-1)).toBe('run_ended')
  })

  it('AC-019 answers pending tool calls with TOOL_ABORTED when aborted before acting', async () => {
    const a = fakeTool({ name: 'a' })
    const h = harness({
      replies: [
        {
          toolCalls: [
            { id: 'c1', name: 'a' },
            { id: 'c2', name: 'a' },
          ],
        },
      ],
    })
    const { run } = h.start(agentOf({ capabilities: [toolsCap(a)] }))
    run.subscribe({ onEvent: (e) => void (e.t === 'model_responded' && run.abort()) })
    const result = await run.result
    expect(result).toMatchObject({ status: 'aborted', code: 'user' })
    const finished = (await h.read(run.runId)).filter((e) => e.t === 'tool_finished')
    expect(finished.map((e) => [e.callId, e.errorCode])).toEqual([
      ['c1', 'TOOL_ABORTED'],
      ['c2', 'TOOL_ABORTED'],
    ])
    expect(a.calls).toHaveLength(0)
  })

  it('AC-019 stops with timeout when the deadline passes', async () => {
    const h = harness({ replies: [{ hang: true }] })
    const { run } = h.start(
      agentOf(),
      taskOf({ budget: { maxTotalMs: 200_000, finalizeReserveMs: 0 } }),
    )
    await vi.waitFor(() => expect(h.model.inputs).toHaveLength(1))
    await h.clock.tick(200_000)
    expect(await run.result).toMatchObject({ status: 'stopped', code: 'timeout' })
  })

  /** 推进时钟直到运行结束。 */
  const drive = async (h: ReturnType<typeof harness>, result: Promise<RunResult>) => {
    let done = false
    void result.then(() => (done = true))
    for (let i = 0; i < 200 && !done; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await h.clock.tick(1_000)
    }
    return result
  }

  it('cuts the last model call at the reserve line and finalizes with a fallback', async () => {
    const weather = fakeTool({ name: 'weather', effect: 'none', result: '晴' })
    const h = harness({
      replies: [
        {
          text: '我先查一下',
          toolCalls: [{ id: 'w1', name: 'weather', input: {} }],
          delayMs: 40_000,
        },
        { text: '北京明天晴，最高 20 度。', delayMs: 25_000 },
        { text: '阶段性：北京明天晴。', delayMs: 2_000 },
      ],
    })
    const agent = agentOf({ capabilities: [toolsCap(weather)] })
    const { run } = h.start(agent, taskOf({ budget: { maxTotalMs: 60_000 } }))
    const result = await drive(h, run.result)
    expect(result).toMatchObject({
      status: 'finalized',
      code: 'timeout',
      text: '阶段性：北京明天晴。',
    })
    const events = await h.read(run.runId)
    expect(events.find((e) => e.t === 'model_aborted')).toMatchObject({ step: 2, deadline: true })
    expect(checkInvariants(events)).toEqual([])
    expect(strictReplay(events).violations).toEqual([])
  })

  it('still delivers the fixed text when the deadline cuts the fallback', async () => {
    const weather = fakeTool({ name: 'weather', effect: 'none', result: '晴' })
    const h = harness({
      replies: [
        {
          text: '我先查一下',
          toolCalls: [{ id: 'w1', name: 'weather', input: {} }],
          delayMs: 40_000,
        },
        {
          text: '再查一下',
          toolCalls: [{ id: 'w2', name: 'weather', input: {} }],
          delayMs: 15_000,
        },
        // 兜底比收尾预留还慢：到截止时间仍拿不到文本。
        { text: '阶段性：北京明天晴。', delayMs: 20_000 },
      ],
    })
    const agent = agentOf({ capabilities: [toolsCap(weather)] })
    const { run } = h.start(agent, taskOf({ budget: { maxTotalMs: 60_000 } }))
    const result = await drive(h, run.result)
    expect(result).toMatchObject({ status: 'finalized', code: 'timeout', text: '任务未能完成' })
    expect(checkInvariants(await h.read(run.runId))).toEqual([])
  })

  it('does not return an intermediate sentence when the deadline stops the run', async () => {
    const weather = fakeTool({ name: 'weather', effect: 'none', result: '晴' })
    const h = harness({
      replies: [
        { text: '我先查一下', toolCalls: [{ id: 'w1', name: 'weather', input: {} }] },
        { hang: true },
      ],
    })
    const { run } = h.start(
      agentOf({ capabilities: [toolsCap(weather)] }),
      taskOf({ budget: { maxTotalMs: 200_000, finalizeReserveMs: 0 } }),
    )
    const result = await drive(h, run.result)
    expect(result).toMatchObject({ status: 'stopped', code: 'timeout' })
    expect(result.text).toBeUndefined()
  })

  it('§10.5 follows a steer that arrives while the final answer is being written', async () => {
    const h = harness({
      replies: [
        { text: '北京明天晴，最高 20 度。', delayMs: 5_000 },
        { text: '上海明天多云，最高 18 度。' },
      ],
    })
    const { run } = h.start()
    await vi.waitFor(() => expect(h.model.inputs).toHaveLength(1))
    run.steer('不要北京了，改查上海')
    const result = await drive(h, run.result)
    expect(result).toMatchObject({ status: 'completed', text: '上海明天多云，最高 18 度。' })
    expect(JSON.stringify(h.model.inputs[1]!.messages)).toContain('不要北京了，改查上海')
  })

  it('AC-020 fails with the classified model error', async () => {
    const h = harness({
      replies: [{ error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true } }],
    })
    const result = await h.start().run.result
    expect(result).toMatchObject({
      status: 'failed',
      code: 'model_error',
      error: { code: 'RATE_LIMITED', retryable: true },
    })
  })

  it('AC-020 fails an invalid agent with only run_ended in the log', async () => {
    const h = harness({ replies: [] })
    const agent = agentOf()
    const forged = { ...agent, id: 'other' }
    const { run } = h.start(forged)
    const result = await run.result
    expect(result).toMatchObject({
      status: 'failed',
      code: 'invalid_agent',
      error: { code: 'invalid_agent', retryable: false },
      model: '',
      steps: 0,
    })
    expect(types(await h.read(run.runId))).toEqual(['run_ended'])
  })

  it('AC-020 keeps going on the full view when memory throws', async () => {
    const failing: Memory = {
      id: 'failing',
      version: '1',
      start: () => ({
        recall: async () => {
          throw new Error('disk full')
        },
      }),
    }
    const h = harness({ replies: [{ text: '答案' }], memory: failing })
    const result = await h.start().run.result
    expect(result).toMatchObject({ status: 'completed', text: '答案' })
    expect(
      h.logs.some((l) => l.message.includes('记忆出错，沿用上一步的压缩：Error: disk full')),
    ).toBe(true)
  })

  it('AC-020 ignores a compaction outside the given messages and keeps running', async () => {
    const broken: Memory = {
      id: 'broken',
      version: '1',
      start: () => ({ recall: async () => ({ compaction: { upTo: 9, summary: 's' } }) }),
    }
    const h = harness({ replies: [{ text: '答案' }], memory: broken })
    const result = await h.start().run.result
    expect(result).toMatchObject({ status: 'completed', text: '答案' })
    expect(h.logs.some((l) => l.message.includes('记忆的压缩不合格，沿用上一步的压缩'))).toBe(true)
  })

  it('AC-020 fails capability conflicts at prepare', async () => {
    const h = harness({ replies: [] })
    const twice = agentOf({
      capabilities: [
        toolsCap(fakeTool({ name: 'x' })),
        { ...toolsCap(fakeTool({ name: 'x' })), id: 'more' },
      ],
    })
    const { run } = h.start(twice)
    expect(await run.result).toMatchObject({ status: 'failed', code: 'invalid_agent' })
    expect(types(await h.read(run.runId))).toEqual(['run_ended'])
  })

  it('AC-021 runs a delegated child with its own log and links it to the parent', async () => {
    const researcher = agentOf({ id: 'researcher' })
    const childTask = taskOf({ budget: { maxTotalMs: 60_000, finalizeReserveMs: 0 } })
    let child: RunResult | undefined
    const delegate = fakeTool({
      name: 'delegate',
      run: async (_input, ctx) => {
        child = await ctx.spawn(researcher, childTask)
        return child.text
      },
    })
    const h = harness({
      replies: [
        { toolCalls: [{ id: 'd1', name: 'delegate' }], usage: { input: 5, output: 1 } },
        { text: 'found', usage: { input: 7, output: 2 } },
        { text: 'done', usage: { input: 9, output: 3 } },
      ],
    })
    const { run } = h.start(agentOf({ id: 'lead', capabilities: [toolsCap(delegate)] }))
    expect(await run.result).toMatchObject({ status: 'completed', text: 'done' })
    expect(child).toMatchObject({ status: 'completed', text: 'found' })
    const [summary] = await h.archive.query({ parentRunId: run.runId })
    expect(summary).toMatchObject({
      runId: child!.runId,
      rootRunId: run.runId,
      agentId: 'researcher',
    })
    const finished = (await h.read(run.runId)).find((e) => e.t === 'tool_finished')
    expect(finished).toMatchObject({
      childRunId: child!.runId,
      usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 },
    })
    const parentResult = await run.result
    expect(parentResult.usage.children).toEqual({
      input: 7,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('AC-021 refuses a spawn that breaks the rules', async () => {
    const delegate = fakeTool({
      name: 'delegate',
      run: async (_input, ctx) => ctx.spawn(agentOf({ id: 'lead' }), taskOf()),
    })
    const h = harness({
      replies: [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: 'ok' }],
    })
    const { run } = h.start(agentOf({ id: 'lead', capabilities: [toolsCap(delegate)] }))
    await run.result
    const finished = (await h.read(run.runId)).find((e) => e.t === 'tool_finished')
    expect(finished).toMatchObject({ isError: true, errorCode: 'SPAWN_CYCLE' })
  })

  it('AC-021 aborts the child when the parent is aborted', async () => {
    const delegate = fakeTool({
      name: 'delegate',
      run: async (_input, ctx) =>
        ctx.spawn(
          agentOf({ id: 'researcher' }),
          taskOf({ budget: { maxTotalMs: 60_000, finalizeReserveMs: 0 } }),
        ),
    })
    const h = harness({
      replies: [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { hang: true }],
    })
    const { run } = h.start(agentOf({ id: 'lead', capabilities: [toolsCap(delegate)] }))
    await vi.waitFor(() => expect(h.model.inputs).toHaveLength(2))
    run.abort()
    expect(await run.result).toMatchObject({ status: 'aborted', code: 'user' })
    await vi.waitFor(async () =>
      expect(await h.archive.query({ parentRunId: run.runId })).toEqual([
        expect.objectContaining({ status: 'aborted', code: 'parent' }),
      ]),
    )
  })

  it('AC-022 delivers a fallback when a task guard finalizes', async () => {
    const h = harness({ replies: [lookup('l1'), lookup('l2'), { text: '阶段性总结' }] })
    const agent = agentOf({ capabilities: [toolsCap(fakeTool({ name: 'lookup' }))] })
    const { run } = h.start(agent, taskOf({ guards: [stall] }))
    expect(await run.result).toMatchObject({
      status: 'finalized',
      code: 'stall',
      text: '阶段性总结',
    })
    const events = await h.read(run.runId)
    expect(types(events).slice(-4)).toEqual([
      'external_call',
      'fallback_generated',
      'delivery_checked',
      'run_ended',
    ])
    expect(events.find((e) => e.t === 'external_call')).toMatchObject({
      source: 'deliver:fallback',
      kind: 'model',
    })
    expect(h.model.inputs[2]!.toolChoice).toBe('none')
  })

  it('gives the fallback the reply and tool results of the last step', async () => {
    const quote = fakeTool({ name: 'quote', effect: 'none', result: '每台 4999 元' })
    const h = harness({
      replies: [
        { text: '先查型号', toolCalls: [{ id: 'q1', name: 'quote', input: { item: '型号' } }] },
        { text: '再查报价', toolCalls: [{ id: 'q2', name: 'quote', input: { item: '报价' } }] },
        { text: '阶段性：X1 每台 4999 元' },
      ],
    })
    const agent = agentOf({ capabilities: [toolsCap(quote)] })
    const { run } = h.start(agent, taskOf({ budget: { maxSteps: 2 } }))
    expect(await run.result).toMatchObject({ status: 'finalized', code: 'max_steps' })
    const fallbackInput = JSON.stringify(h.model.inputs[2]!.messages)
    expect(fallbackInput).toContain('再查报价')
    expect(fallbackInput.match(/每台 4999 元/g)).toHaveLength(2)
    expect(h.model.inputs[2]!.messages.at(-1)).toMatchObject({ role: 'user' })
  })

  it('announces a delivery only after it is written to the log', async () => {
    const h = harness({ replies: [{ text: '答案' }] })
    const append = h.archive.append.bind(h.archive)
    h.archive.append = async (runId, events) => {
      if (events.some((e) => e.t === 'delivery_checked')) throw new Error('磁盘满')
      return append(runId, events)
    }
    const { run } = h.start()
    const notices: string[] = []
    run.subscribe({ onNotice: (n) => void notices.push(n.t) })
    const result = await run.result
    expect(result).toMatchObject({ status: 'failed', code: 'engine_error' })
    expect(result.text).toBeUndefined()
    expect(notices).not.toContain('delivered')
  })

  it('does not take a truncated or filtered fallback reply as the delivery', async () => {
    const h = harness({
      replies: [
        lookup('l1'),
        lookup('l2'),
        { text: '阶段性总结写到一半', finishReason: 'length' },
        { text: '被过滤', finishReason: 'content-filter' },
      ],
    })
    const agent = agentOf({ capabilities: [toolsCap(fakeTool({ name: 'lookup' }))] })
    const { run } = h.start(agent, taskOf({ guards: [stall] }))
    const result = await run.result
    expect(result).toMatchObject({ status: 'finalized', code: 'stall' })
    expect(result.text).toBe('任务未能完成')
    const events = await h.read(run.runId)
    expect(events.find((e) => e.t === 'fallback_generated')).toMatchObject({ degradation: 2 })
  })

  it('AC-032 gives guards and the log the task goal, or the first 200 characters of the input', async () => {
    const seen: Array<string | undefined> = []
    const spy: Guard = {
      id: 'spy',
      version: '1',
      start: (run) => (seen.push(run.task.goal), { check: () => undefined }),
    }
    const goalOf = async (task: Task) => {
      const h = harness({ replies: [{ text: 'ok' }] })
      const { run } = h.start(agentOf(), task)
      await run.result
      const started = (await h.read(run.runId)).find((e) => e.t === 'run_started')
      return started?.t === 'run_started' ? started.task.goal : undefined
    }
    expect(await goalOf(taskOf({ goal: '订一张去东京的机票', guards: [spy] }))).toBe(
      '订一张去东京的机票',
    )
    const long = 'x'.repeat(300)
    const input = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: long }] }]
    expect(await goalOf(taskOf({ input, guards: [spy] }))).toBe('x'.repeat(200))
    expect(seen).toEqual(['订一张去东京的机票', 'x'.repeat(200)])
  })

  it('AC-033 runs capability guards under the capability: source', async () => {
    const lookupTool = fakeTool({ name: 'lookup' })
    const guarded: Capability = {
      ...toolsCap(lookupTool),
      prepare: async () => ({
        tools: [lookupTool],
        guards: [
          { id: 'g', version: '1', start: () => ({ check: () => ({ warn: { problem: 'p' } }) }) },
        ],
        snapshot: { fingerprint: 'fp' },
      }),
    }
    const h = harness({ replies: [lookup('l1'), { text: 'ok' }] })
    const { run } = h.start(agentOf({ capabilities: [guarded] }), taskOf())
    await run.result
    const evaluated = (await h.read(run.runId)).find((e) => e.t === 'evaluated')
    expect(evaluated?.t === 'evaluated' && evaluated.opinions.map((o) => o.source)).toEqual([
      'capability:g',
      'guard:pressure',
    ])
  })

  it('tells subscribers which run each event belongs to', async () => {
    const h = harness({ replies: [{ text: 'ok' }] })
    const { run } = h.start()
    const ids: Array<string | undefined> = []
    run.subscribe({ onEvent: (_e, info) => void ids.push(info?.runId) })
    await run.result
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids)).toEqual(new Set([run.runId]))
  })

  it('A.3 ends with engine_error when the archive stops accepting writes', async () => {
    const h = harness({ replies: [{ text: 'ok' }] })
    const append = h.archive.append.bind(h.archive)
    let writes = 0
    h.engine.archive = {
      ...h.archive,
      append: async (id, events) => {
        writes += 1
        if (writes >= 2) throw new Error('disk full')
        return append(id, events)
      },
    }
    const result = await h.start().run.result
    expect(result).toMatchObject({
      status: 'failed',
      code: 'engine_error',
      error: { message: 'disk full' },
    })
    expect(h.logs.map((l) => l.message)).toEqual(
      expect.arrayContaining(['运行出错', '写入 run_ended 失败']),
    )
  })

  it('I2 records TOOL_MISSING_RESULT for calls whose results could not be written', async () => {
    const write = fakeTool({ name: 'write', effect: 'side_effect' })
    const h = harness({ replies: [lookup('l1'), { text: 'ok' }] })
    const append = h.archive.append.bind(h.archive)
    let failed = false
    h.engine.archive = {
      ...h.archive,
      append: async (id, events) => {
        if (!failed && events.some((e) => e.t === 'tool_finished')) {
          failed = true
          throw new Error('disk full')
        }
        return append(id, events)
      },
    }
    const agent = agentOf({
      capabilities: [toolsCap(fakeTool({ name: 'lookup', effect: 'side_effect' }), write)],
    })
    const { run } = h.start(agent, taskOf())
    expect(await run.result).toMatchObject({ status: 'failed', code: 'engine_error' })
    const events = await h.read(run.runId)
    expect(events.find((e) => e.t === 'tool_finished')).toMatchObject({
      callId: 'l1',
      isError: true,
      errorCode: 'TOOL_MISSING_RESULT',
    })
    expect(checkInvariants(events)).toEqual([])
    expect(sideEffects(events)).toEqual([
      expect.objectContaining({ callId: 'l1', status: 'possibly_executed' }),
    ])
  })

  it('degrades a broken exposure to all tools and logs release errors', async () => {
    const lookup = fakeTool({ name: 'lookup' })
    const broken = {
      id: 'broken',
      version: '1',
      start: () => {
        throw new Error('no exposure')
      },
    }
    const leaky: Capability = {
      ...toolsCap(lookup),
      prepare: async () => ({
        tools: [lookup],
        snapshot: { fingerprint: 'fp' },
        release: () => {
          throw new Error('release failed')
        },
      }),
    }
    const h = harness({ replies: [{ text: 'ok' }] })
    const { run } = h.start(agentOf({ capabilities: [leaky], toolbox: { exposure: broken } }))
    expect((await run.result).status).toBe('completed')
    expect(h.model.inputs[0]!.tools.map((t) => t.name)).toEqual(['lookup'])
    expect(h.logs.map((l) => l.message)).toEqual(
      expect.arrayContaining(['工具呈现启动出错，退回全部可见', '释放能力出错']),
    )
  })

  it('falls back to the fixed text when fallback generation fails', async () => {
    const h = harness({
      replies: [lookup('l1'), lookup('l2'), { error: { code: 'MODEL_ERROR', message: 'down' } }],
    })
    const agent = agentOf({ capabilities: [toolsCap(fakeTool({ name: 'lookup' }))] })
    const { run } = h.start(agent, taskOf({ guards: [stall] }))
    expect(await run.result).toMatchObject({ status: 'finalized', text: '任务未能完成' })
    const calls = (await h.read(run.runId)).filter((e) => e.t === 'external_call')
    expect(calls).toHaveLength(2)
    expect(calls.every((e) => e.t === 'external_call' && e.usage === undefined)).toBe(true)
  })

  it('lists executed side effects in the fallback prompt', async () => {
    const write = fakeTool({ name: 'write', effect: 'side_effect' })
    const h = harness({
      replies: [
        { toolCalls: [{ id: 'w1', name: 'write', input: { path: 'a.txt' } }] },
        { toolCalls: [{ id: 'w2', name: 'write', input: { path: 'b.txt' } }] },
        { text: '总结' },
      ],
    })
    const { run } = h.start(
      agentOf({ capabilities: [toolsCap(write)] }),
      taskOf({ guards: [stall] }),
    )
    await run.result
    const prompt = h.model.inputs[2]!.messages.at(-1)!
    expect(prompt.content).toContain('write {"path":"a.txt"}')
  })

  it('AC-010 gives checks a corpus with tool names, effects and errors', async () => {
    let seen: Corpus | undefined
    const spy: Check = {
      id: 'spy',
      version: '1',
      mode: 'annotate',
      start: () => ({
        accept: async (_c, corpus) => {
          seen = corpus
          return { pass: true }
        },
      }),
    }
    const write = fakeTool({ name: 'write', effect: 'side_effect' })
    const h = harness({
      replies: [
        {
          toolCalls: [
            { id: 'w1', name: 'write' },
            { id: 'x1', name: 'missing' },
          ],
        },
        { text: 'ok' },
      ],
      environment: { checks: [spy] },
    })
    await h.start(agentOf({ capabilities: [toolsCap(write)] })).run.result
    expect(seen?.sources.filter((s) => s.origin === 'tool')).toEqual([
      expect.objectContaining({
        callId: 'w1',
        toolName: 'write',
        effect: 'side_effect',
        isError: false,
      }),
      expect.objectContaining({ callId: 'x1', toolName: 'missing', effect: 'none', isError: true }),
    ])
  })
})

const childTask = (budget: Task['budget'] = {}) =>
  taskOf({ budget: { maxTotalMs: 60_000, finalizeReserveMs: 0, ...budget } })

/** 委托工具：等子运行结束，返回 `status:text`。 */
const spawner = (name: string, agent: Agent, task: Task, opts?: Parameters<ToolCtx['spawn']>[2]) =>
  fakeTool({
    name,
    run: async (_input, ctx) => {
      const r = await ctx.spawn(agent, task, opts)
      return `${r.status}:${r.text ?? r.code ?? ''}`
    },
  })

/** 不等子运行就返回的委托工具。 */
const detached = (agent: Agent, task: Task) =>
  fakeTool({
    name: 'delegate',
    run: (_input, ctx) => {
      void ctx.spawn(agent, task)
      return 'started'
    },
  })

const codes = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.t === 'tool_finished' ? [e.errorCode ?? 'ok'] : []))

describe('startRun delegation', () => {
  it('passes child run events and notices to subscribers that ask for them', async () => {
    const h = harness({
      replies: [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: '汇总完成' }],
      models: (clock) => [fakeModel({ model: 'worker', clock, replies: [{ text: '子任务完成' }] })],
    })
    const worker = agentOf({ id: 'worker', model: { prefer: 'fake:worker' } })
    const { run } = h.start(
      agentOf({ capabilities: [toolsCap(spawner('delegate', worker, childTask()))] }),
    )
    const all = { events: new Set<string>(), notices: [] as Array<[string, string]> }
    const own = new Set<string>()
    run.subscribe(
      {
        onEvent: (_e, r) => void all.events.add(r.runId),
        onNotice: (n, r) => void all.notices.push([r.runId, n.t]),
      },
      { children: true },
    )
    run.subscribe({ onEvent: (_e, r) => void own.add(r.runId) })
    expect(await run.result).toMatchObject({ status: 'completed', text: '汇总完成' })
    const [child] = await h.children(run.runId)
    const childId = child!.summary.runId
    await vi.waitFor(() => expect([...all.events].sort()).toEqual([run.runId, childId].sort()))
    expect(all.notices).toContainEqual([childId, 'text_delta'])
    expect(all.notices).toContainEqual([run.runId, 'delivered'])
    expect([...own]).toEqual([run.runId])
  })

  it('caps a child run before the parent reserve so the parent can still finalize', async () => {
    const h = harness({
      replies: [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: '阶段性：子任务超时' }],
      models: (clock) => [fakeModel({ model: 'worker', clock, replies: [{ hang: true }] })],
    })
    const worker = agentOf({ id: 'worker', model: { prefer: 'fake:worker' } })
    const delegate = fakeTool({
      name: 'delegate',
      timeoutMs: 600_000,
      run: async (_input, ctx) => {
        // 子任务自己不设时长：上限取父运行剩下的、扣掉收尾预留的时间。
        const r = await ctx.spawn(worker, taskOf({ budget: { finalizeReserveMs: 0 } }))
        return `${r.status}:${r.code ?? ''}`
      },
    })
    const { run } = h.start(
      agentOf({ capabilities: [toolsCap(delegate)] }),
      taskOf({ budget: { maxTotalMs: 100_000, finalizeReserveMs: 20_000 } }),
    )
    let done = false
    void run.result.then(() => (done = true))
    for (let i = 0; i < 200 && !done; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await h.clock.tick(1_000)
    }
    expect(await run.result).toMatchObject({
      status: 'finalized',
      code: 'timeout',
      text: '阶段性：子任务超时',
    })
    const [child] = await h.children(run.runId)
    expect(child!.summary).toMatchObject({ status: 'stopped', code: 'timeout' })
  })

  it('§5.3 runs nested delegation with a child concurrency of 1', async () => {
    const grand = agentOf({ id: 'grand' })
    const child = agentOf({
      id: 'child',
      capabilities: [toolsCap(spawner('spawn_grand', grand, childTask()))],
    })
    const h = harness({
      replies: [
        { toolCalls: [{ id: 'r1', name: 'spawn_child' }] },
        { toolCalls: [{ id: 'c1', name: 'spawn_grand' }] },
        { text: 'grand ok' },
        { text: 'child ok' },
        { text: 'root ok' },
      ],
      environment: { caps: { delegation: { concurrency: 1 } } },
    })
    const root = agentOf({
      id: 'root',
      capabilities: [toolsCap(spawner('spawn_child', child, childTask({ maxTotalMs: 600_000 })))],
    })
    const { run } = h.start(root)
    expect(await run.result).toMatchObject({ status: 'completed', text: 'root ok' })
    const [mid] = await h.children(run.runId)
    expect(codes(mid!.events)).toEqual(['ok'])
  })

  it('§5.3 counts the wait for a child slot as queue time', async () => {
    const h = harness({
      replies: [
        {
          toolCalls: [
            { id: 'd1', name: 'delegate' },
            { id: 'd2', name: 'delegate' },
          ],
        },
        { text: 'done' },
      ],
      models: (clock) => [
        fakeModel({
          model: 'worker',
          clock,
          replies: [{ text: 'one', delayMs: 500 }, { text: 'two' }],
        }),
      ],
      environment: { caps: { delegation: { concurrency: 1 } } },
    })
    const worker = agentOf({ id: 'worker', model: { prefer: 'fake:worker' } })
    const { run } = h.start(
      agentOf({ id: 'lead', capabilities: [toolsCap(spawner('delegate', worker, childTask()))] }),
    )
    await vi.waitFor(() => expect(h.others[0]!.inputs).toHaveLength(1))
    await h.clock.tick(500)
    expect(await run.result).toMatchObject({ status: 'completed', text: 'done' })
    const queued = (await h.children(run.runId)).map(({ events }) =>
      events[0]?.t === 'run_started' ? events[0].queuedMs : undefined,
    )
    expect(queued.sort()).toEqual([0, 500])
  })

  it('I4 keeps the parent permission rules in a child spawned into a looser environment', async () => {
    const write = fakeTool({ name: 'write', effect: 'side_effect' })
    const readOnly: PermissionRule = {
      id: 'read-only',
      version: '1',
      permit: async (call) => (call.toolName === 'write' ? { deny: '只读' } : 'allow'),
    }
    const h = harness({
      replies: [
        { toolCalls: [{ id: 'd1', name: 'delegate' }] },
        { toolCalls: [{ id: 'w1', name: 'write' }] },
        { text: 'child done' },
        { text: 'done' },
      ],
      environment: { permissions: [readOnly] },
    })
    const open = h.addEnvironment({ name: 'open', principal: { reachable: true } })
    const writer = agentOf({ id: 'writer', capabilities: [toolsCap(write)] })
    const { run } = h.start(
      agentOf({
        id: 'lead',
        capabilities: [toolsCap(spawner('delegate', writer, childTask(), { environment: open }))],
      }),
    )
    expect(await run.result).toMatchObject({ status: 'completed', text: 'done' })
    expect(write.calls).toHaveLength(0)
    const [child] = await h.children(run.runId)
    expect(child!.events[0]).toMatchObject({ environment: { name: 'open' } })
    expect(codes(child!.events)).toEqual(['PERMISSION_DENIED'])
    expect(child!.events.find((e) => e.t === 'permission_decided')).toMatchObject({
      source: 'read-only',
    })
  })

  it('I12 reserves the cost ceiling of running children before granting another', async () => {
    const h = harness({
      replies: [
        {
          toolCalls: [
            { id: 'd1', name: 'delegate' },
            { id: 'd2', name: 'delegate' },
          ],
        },
        { text: 'done' },
      ],
      models: (clock) => [
        fakeModel({
          model: 'worker',
          clock,
          replies: [
            { text: 'one', delayMs: 100 },
            { text: 'two', delayMs: 100 },
          ],
        }),
      ],
      prices: { 'fake:main': { input: 1, output: 1 }, 'fake:worker': { input: 1, output: 1 } },
    })
    const worker = agentOf({ id: 'worker', model: { prefer: 'fake:worker' } })
    const { run } = h.start(
      agentOf({
        id: 'lead',
        capabilities: [toolsCap(spawner('delegate', worker, childTask({ maxCost: 0.6 })))],
      }),
      taskOf({ budget: { maxCost: 1 } }),
    )
    await vi.waitFor(() => expect(h.others[0]!.inputs.length).toBeGreaterThan(0))
    await h.clock.tick(100)
    expect(await run.result).toMatchObject({ status: 'completed' })
    expect(codes(await h.read(run.runId)).sort()).toEqual(['SPAWN_BUDGET', 'ok'])
    expect(await h.children(run.runId)).toHaveLength(1)
  })

  it('I12 refuses a child whose model has no price when the parent has maxCost', async () => {
    const h = harness({
      replies: [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: 'done' }],
      models: (clock) => [fakeModel({ model: 'free', clock, replies: [{ text: 'free' }] })],
      prices: { 'fake:main': { input: 1, output: 1 } },
    })
    const free = agentOf({ id: 'free', model: { prefer: 'fake:free' } })
    const { run } = h.start(
      agentOf({ id: 'lead', capabilities: [toolsCap(spawner('delegate', free, childTask()))] }),
      taskOf({ budget: { maxCost: 1 } }),
    )
    expect(await run.result).toMatchObject({ status: 'completed' })
    expect(codes(await h.read(run.runId))).toEqual(['SPAWN_BUDGET'])
    expect(h.others[0]!.inputs).toHaveLength(0)
  })

  it('§3.14 aborts a child when the caller signal aborts', async () => {
    const caller = new AbortController()
    const h = harness({
      replies: [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: 'done' }],
      models: (clock) => [fakeModel({ model: 'slow', clock, replies: [{ hang: true }] })],
    })
    const slow = agentOf({ id: 'slow', model: { prefer: 'fake:slow' } })
    const { run } = h.start(
      agentOf({
        id: 'lead',
        capabilities: [toolsCap(spawner('delegate', slow, childTask(), { signal: caller.signal }))],
      }),
    )
    await vi.waitFor(() => expect(h.others[0]!.inputs).toHaveLength(1))
    caller.abort()
    expect(await run.result).toMatchObject({ status: 'completed', text: 'done' })
    const [child] = await h.children(run.runId)
    expect(child!.summary).toMatchObject({ status: 'aborted', code: 'parent' })
  })

  it('§3.14 detaches child abort listeners when children end', async () => {
    let runSignal: AbortSignal | undefined
    const caller = new AbortController()
    const researcher = agentOf({ id: 'researcher' })
    const probe: Capability = {
      id: 'probe',
      version: '1',
      kind: 'tool',
      prepare: async ({ signal }) => {
        runSignal = signal
        return {
          tools: [spawner('delegate', researcher, childTask(), { signal: caller.signal })],
          snapshot: { fingerprint: 'probe' },
        }
      },
    }
    const h = harness({
      replies: [
        { toolCalls: [{ id: 'd1', name: 'delegate' }] },
        { text: 'found' },
        { text: 'done' },
      ],
    })
    const { run } = h.start(agentOf({ id: 'lead', capabilities: [probe] }))
    expect(await run.result).toMatchObject({ status: 'completed', text: 'done' })
    expect(getEventListeners(runSignal!, 'abort')).toHaveLength(0)
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
  })

  it('§8.3 counts a child that ends after its calling tool returned', async () => {
    const h = harness({
      replies: [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: 'done' }],
      models: (clock) => [
        fakeModel({
          model: 'slow',
          clock,
          replies: [{ text: 'late', usage: { input: 7, output: 2 }, delayMs: 1_000 }],
        }),
      ],
    })
    const slow = agentOf({ id: 'slow', model: { prefer: 'fake:slow' } })
    const { run } = h.start(
      agentOf({ id: 'lead', capabilities: [toolsCap(detached(slow, childTask()))] }),
    )
    await vi.waitFor(() => expect(h.others[0]!.inputs).toHaveLength(1))
    await h.clock.tick(1_000)
    const result = await run.result
    expect(result.usage.children).toEqual({ input: 7, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect((await h.read(run.runId)).find((e) => e.t === 'tool_finished')).toMatchObject({
      usage: { input: 7, output: 2 },
    })
  })

  it('§3.14 waits childDeliveryWaitMs for a running child, then aborts it', async () => {
    const h = harness({
      replies: [{ toolCalls: [{ id: 'd1', name: 'delegate' }] }, { text: 'done' }],
      models: (clock) => [fakeModel({ model: 'slow', clock, replies: [{ hang: true }] })],
      environment: { caps: { childDeliveryWaitMs: 2_000 } },
    })
    const slow = agentOf({ id: 'slow', model: { prefer: 'fake:slow' } })
    const { run } = h.start(
      agentOf({ id: 'lead', capabilities: [toolsCap(detached(slow, childTask()))] }),
    )
    await vi.waitFor(() => expect(h.others[0]!.inputs).toHaveLength(1))
    let ended = false
    void run.result.then(() => (ended = true))
    await h.clock.tick(1_999)
    expect(ended).toBe(false)
    await h.clock.tick(1)
    expect(await run.result).toMatchObject({ status: 'completed', text: 'done' })
    const [child] = await h.children(run.runId)
    expect(child!.summary).toMatchObject({ status: 'aborted', code: 'parent' })
  })
})

describe('startRun ending', () => {
  it('§4.4 does not let a hung subscriber hold the run or its admission slot', async () => {
    const h = harness({
      replies: [{ text: 'one' }, { text: 'two' }],
      environment: { caps: { maxConcurrentRuns: 1 } },
    })
    const first = h.start()
    first.run.subscribe({ onEvent: () => new Promise<void>(() => {}) })
    const second = h.start()
    expect(await second.run.result).toMatchObject({ status: 'completed', text: 'two' })
    let ended = false
    void first.run.result.then(() => (ended = true))
    await h.clock.tick(4_999)
    expect(ended).toBe(false)
    await h.clock.tick(1)
    expect(await first.run.result).toMatchObject({ status: 'completed', text: 'one' })
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', message: '订阅者 5000ms 内没有处理完事件' }),
    )
  })

  it('§3.14 ends aborted when cancelled during a slow gate check', async () => {
    let started = false
    const slowGate: Check = {
      id: 'slow-gate',
      version: '1',
      mode: 'gate',
      start: () => ({
        accept: () => {
          started = true
          return new Promise(
            (resolve) => void h.clock.setTimer(1_000, () => resolve({ pass: true })),
          )
        },
      }),
    }
    const h = harness({ replies: [{ text: 'answer' }], environment: { checks: [slowGate] } })
    const { run } = h.start()
    await vi.waitFor(() => expect(started).toBe(true))
    run.abort()
    await h.clock.tick(1_000)
    expect(await run.result).toMatchObject({ status: 'aborted', code: 'user' })
  })

  it('§3.14 delivers nothing when cancelled during an annotating check', async () => {
    let started = false
    const slowNote: Check = {
      id: 'slow-note',
      version: '1',
      mode: 'annotate',
      start: () => ({
        accept: () => {
          started = true
          return new Promise(
            (resolve) => void h.clock.setTimer(1_000, () => resolve({ pass: true })),
          )
        },
      }),
    }
    const h = harness({ replies: [{ text: 'answer' }], environment: { checks: [slowNote] } })
    const { run } = h.start()
    const notices: string[] = []
    run.subscribe({ onNotice: (n) => void notices.push(n.t) })
    await vi.waitFor(() => expect(started).toBe(true))
    run.abort()
    await h.clock.tick(1_000)
    const result = await run.result
    expect(result).toMatchObject({ status: 'aborted', code: 'user' })
    expect(result.text).toBeUndefined()
    expect(notices).not.toContain('delivered')
    expect(strictReplay(await h.read(run.runId)).violations).toEqual([])
  })

  it('§3.14 starts no fallback model call once cancelled', async () => {
    const h = harness({ replies: [lookup('l1'), lookup('l2'), { hang: true }, { hang: true }] })
    const putBlob = h.archive.putBlob.bind(h.archive)
    h.engine.archive = {
      ...h.archive,
      putBlob: async (data) => {
        if (typeof data === 'string' && data.includes('说明进展并提问')) run.abort()
        return putBlob(data)
      },
    }
    const agent = agentOf({ capabilities: [toolsCap(fakeTool({ name: 'lookup' }))] })
    const { run } = h.start(agent, taskOf({ guards: [stall] }))
    expect(await run.result).toMatchObject({ status: 'aborted', code: 'user' })
    expect(h.model.inputs).toHaveLength(2)
  })

  it('§3.14 scales the default finalize reserve to a short maxTotalMs', async () => {
    const h = harness({ replies: [lookup('l1'), { text: 'final answer' }] })
    const agent = agentOf({ capabilities: [toolsCap(fakeTool({ name: 'lookup' }))] })
    const { run } = h.start(agent, taskOf({ budget: { maxTotalMs: 60_000 } }))
    expect(await run.result).toMatchObject({ status: 'completed', text: 'final answer', steps: 2 })
    expect((await h.read(run.runId))[0]).toMatchObject({
      t: 'run_started',
      task: { budget: { maxTotalMs: 60_000, finalizeReserveMs: 12_000 } },
    })
  })

  it('§5.3 starts the hard deadline where time pressure starts: run_started minus queue time', async () => {
    const h = harness({ replies: [{ hang: true }] })
    const slowPrepare: Capability = {
      ...toolsCap(),
      prepare: () =>
        new Promise(
          (resolve) =>
            void h.clock.setTimer(10_000, () =>
              resolve({ tools: [], snapshot: { fingerprint: 'slow' } }),
            ),
        ),
    }
    const { run } = h.start(
      agentOf({ capabilities: [slowPrepare] }),
      taskOf({ budget: { maxTotalMs: 100_000, finalizeReserveMs: 0 } }),
    )
    await h.clock.tick(10_000)
    await vi.waitFor(() => expect(h.model.inputs).toHaveLength(1))
    let ended = false
    void run.result.then(() => (ended = true))
    await h.clock.tick(90_000)
    expect(ended).toBe(false)
    await h.clock.tick(10_000)
    expect(await run.result).toMatchObject({ status: 'stopped', code: 'timeout' })
  })

  it('§9.10 stops with notice_blocked before any model call when a notice provider blocks', async () => {
    const release = vi.fn()
    const hook: NoticeProvider = {
      id: 'prompt-hook',
      version: '1',
      provide: async () => ({ block: '包含敏感信息' }),
    }
    const h = harness({ replies: [{ text: 'never' }], environment: { notice: [hook] } })
    const leased: Capability = {
      ...toolsCap(),
      prepare: async () => ({ tools: [], snapshot: { fingerprint: 'fp' }, release }),
    }
    const { run } = h.start(agentOf({ capabilities: [leased] }))
    expect(await run.result).toMatchObject({
      status: 'stopped',
      code: 'notice_blocked',
      text: '包含敏感信息',
    })
    expect(h.model.inputs).toHaveLength(0)
    expect(types(await h.read(run.runId))).toEqual(['run_ended'])
    expect(release).toHaveBeenCalledTimes(1)
    // 没有 run_started 也能按状态查到：run_ended 带上归属。
    expect(await h.archive.query({ status: 'stopped' })).toEqual([
      expect.objectContaining({
        runId: run.runId,
        rootRunId: run.runId,
        code: 'notice_blocked',
        environment: 'test',
        agentId: 'helper',
      }),
    ])
  })

  it('AC-018 records a steer that arrives while the final steers are being written', async () => {
    const h = harness({ replies: [{ text: 'ok' }] })
    const append = h.archive.append.bind(h.archive)
    h.engine.archive = {
      ...h.archive,
      append: async (id, events) => {
        if (events.some((e) => e.t === 'delivery_checked')) run.steer('first')
        if (events.some((e) => e.t === 'steer_received' && e.text === 'first')) run.steer('second')
        return append(id, events)
      },
    }
    const { run } = h.start()
    expect(await run.result).toMatchObject({ status: 'completed' })
    const steers = (await h.read(run.runId)).flatMap((e) =>
      e.t === 'steer_received' ? [e.text] : [],
    )
    expect(steers).toEqual(['first', 'second'])
  })
})
