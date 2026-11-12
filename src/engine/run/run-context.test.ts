import { describe, expect, it } from 'vitest'
import type { CapabilityHost } from '../../contracts/capability.js'
import type { LogEntry } from '../../contracts/common.js'
import type { RunInfo } from '../../contracts/component.js'
import type { RunEventBody } from '../../contracts/events.js'
import { hashOf } from '../../core/definition/hash.js'
import { redactValue } from '../../core/log/redact.js'
import { initial, type RunState } from '../../core/run/state.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { fakeModel, type FakeReply } from '../../testing/fake-model.js'
import { hubOf } from '../engine.fixture.js'
import {
  createRunContext,
  placeExternalCalls,
  secretKeeper,
  type RunContextDeps,
} from './run-context.js'

const runInfo: RunInfo = {
  runId: 'run-1',
  rootRunId: 'run-1',
  environment: { name: 'test', principalReachable: true, approver: false },
  agent: { id: 'helper' },
  task: {},
  model: { ref: 'fake:main', contextLimit: 100_000 },
}

const usage = (input: number, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0 })

function setup(
  opts: { replies?: FakeReply[]; state?: Partial<RunState>; patch?: Partial<RunContextDeps> } = {},
) {
  const clock = new FakeClock()
  const main = fakeModel({
    model: 'main',
    clock,
    replies: opts.replies ?? [{ text: 'summary', usage: { input: 7, output: 3 } }],
  })
  const small = fakeModel({ model: 'small', clock, replies: [{ text: 'small says' }] })
  const logs: LogEntry[] = []
  const blobs = new Map<string, string>()
  let state: RunState = { ...initial({ runId: 'run-1' }), step: 2, ...opts.state }
  const hosts = new Map<string, CapabilityHost>([['mcp', { kind: 'mcp' }]])
  const deps: RunContextDeps = {
    run: runInfo,
    clock,
    hub: hubOf([main.port, small.port]),
    logger: { log: (e) => logs.push(e) },
    hosts,
    signal: new AbortController().signal,
    state: () => state,
    putBlob: async (data) => {
      const ref = `sha256:${hashOf(data)}`
      blobs.set(ref, data)
      return ref
    },
    redact: (value) => redactValue(value, ['hunter22']),
    ...opts.patch,
  }
  const context = createRunContext(deps)
  return {
    context,
    clock,
    logs,
    blobs,
    main,
    small,
    setState: (s: Partial<RunState>) => (state = { ...state, ...s }),
  }
}

describe('createRunContext', () => {
  it('F19 AC-015 gives components the run signal', () => {
    const controller = new AbortController()
    const { context } = setup({ patch: { signal: controller.signal } })
    expect(context.ctxFor('guard:x').signal).toBe(controller.signal)
  })

  it('AC-011 records a side model call and returns text, usage and model', async () => {
    const { context, blobs, main } = setup()
    const ctx = context.ctxFor('memory:compacting')
    const response = await ctx.callModel({
      purpose: 'memory:compaction',
      system: 'compress',
      messages: [{ role: 'user', content: 'long story' }],
      maxOutputTokens: 500,
    })
    expect(response).toEqual({
      text: 'summary',
      usage: usage(7, 3),
      model: 'fake:main',
      finishReason: 'stop',
    })
    expect(main.inputs[0]).toEqual({
      messages: [
        { role: 'system', content: 'compress' },
        { role: 'user', content: 'long story' },
      ],
      tools: [],
      maxOutputTokens: 500,
    })
    const [event] = context.drain() as Array<Extract<RunEventBody, { t: 'external_call' }>>
    expect(event).toMatchObject({
      t: 'external_call',
      source: 'memory:compacting/memory:compaction',
      kind: 'model',
      usage: usage(7, 3),
    })
    expect(JSON.parse(blobs.get(event!.request)!)).toMatchObject({
      purpose: 'memory:compaction',
      model: 'fake:main',
    })
    expect(blobs.get(event!.response)).toBe('summary')
    expect(context.drain()).toEqual([])
  })

  it('AC-011 uses the requested model and records failures before rethrowing', async () => {
    const { context, blobs } = setup({
      replies: [{ error: { code: 'MODEL_ERROR', message: 'bad gateway' } }],
      state: { usage: { ...initial({ runId: 'run-1' }).usage, main: usage(100) } },
    })
    const ctx = context.ctxFor('corrector:ladder')
    expect(await ctx.callModel({ purpose: 'x', messages: [], model: 'fake:small' })).toMatchObject({
      text: 'small says',
      model: 'fake:small',
    })
    await expect(ctx.callModel({ purpose: 'diagnose', messages: [] })).rejects.toThrow(
      'bad gateway',
    )
    const events = context.drain() as Array<Extract<RunEventBody, { t: 'external_call' }>>
    expect(events).toHaveLength(2)
    expect(events[1]).not.toHaveProperty('usage')
    expect(JSON.parse(blobs.get(events[1]!.response)!)).toEqual({
      error: 'MODEL_ERROR: bad gateway',
    })
    await expect(ctx.callModel({ purpose: 'x', messages: [], model: 'fake:nope' })).rejects.toThrow(
      '模型 fake:nope 不存在',
    )
  })

  it('tells components the window and output limit of a model', () => {
    const { context } = setup()
    const ctx = context.ctxFor('memory:compacting')
    expect(ctx.modelLimits?.()).toEqual({ contextLimit: 128_000, maxOutputTokens: 8192 })
    expect(ctx.modelLimits?.('fake:small')).toEqual({
      contextLimit: 128_000,
      maxOutputTokens: 8192,
    })
    expect(ctx.modelLimits?.('fake:nope')).toBeUndefined()
  })

  it('calls the model for guards without a supervision share (the advisor limits itself)', async () => {
    const heavy = {
      ...initial({ runId: 'run-1' }).usage,
      main: usage(100),
      supervision: usage(500),
    }
    const { context, main } = setup({ replies: [{ text: 'ok' }], state: { usage: heavy } })
    expect(
      await context
        .ctxFor('engine:advisor')
        .callModel({ purpose: 'supervision:advise', messages: [] }),
    ).toMatchObject({ text: 'ok' })
    expect(main.inputs).toHaveLength(1)
    expect(context).not.toHaveProperty('skipped')
  })

  it('AC-013 records other external calls with their kind', async () => {
    const { context, blobs } = setup()
    const ctx = context.ctxFor('permission:hooks')
    expect(
      await ctx.record('lookup', async () => ({ allowed: true, token: 'hunter22' }), {
        kind: 'hook',
      }),
    ).toEqual({
      allowed: true,
      token: 'hunter22',
    })
    await expect(
      ctx.record('broken', async () => {
        throw new Error('exit 2')
      }),
    ).rejects.toThrow('exit 2')
    const [hook, failed] = context.drain() as Array<Extract<RunEventBody, { t: 'external_call' }>>
    expect(hook).toMatchObject({ source: 'permission:hooks/lookup', kind: 'hook' })
    expect(blobs.get(hook!.response)).toBe('{"allowed":true,"token":"[REDACTED]"}')
    expect(JSON.parse(blobs.get(hook!.request)!)).toEqual({ name: 'lookup' })
    expect(failed).toMatchObject({ source: 'permission:hooks/broken', kind: 'record' })
    expect(JSON.parse(blobs.get(failed!.response)!)).toEqual({ error: 'exit 2' })
  })

  it('AC-014 logs with run id, step and source, redacted', () => {
    const { context, logs } = setup()
    context
      .ctxFor('check:grounding')
      .log('warn', 'key hunter22 leaked', { auth: 'Bearer abcdef123456' })
    expect(logs).toEqual([
      {
        level: 'warn',
        message: 'key [REDACTED] leaked',
        runId: 'run-1',
        step: 2,
        source: 'check:grounding',
        detail: { auth: 'Bearer [REDACTED]' },
      },
    ])
  })

  it('AC-014 leaves out the step before the first one', () => {
    const { context, logs } = setup({ state: { step: 0 } })
    context.ctxFor('provider:daily').log('info', 'hello')
    expect(logs[0]).toEqual({
      level: 'info',
      message: 'hello',
      runId: 'run-1',
      source: 'provider:daily',
    })
  })

  it('AC-014 finds hosts and seeds random from the run id', () => {
    const a = setup().context
    const b = setup().context
    expect(a.ctxFor('x').host('mcp')).toEqual({ kind: 'mcp' })
    expect(() => a.ctxFor('x').host('skills')).toThrow('能力宿主不存在：skills')
    const seq = (c: typeof a) => [
      c.ctxFor('x').random(),
      c.ctxFor('y').random(),
      c.ctxFor('x').random(),
    ]
    const first = seq(a)
    expect(seq(b)).toEqual(first)
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true)
    const other = createRunContext({ ...setupDeps(), run: { ...runInfo, runId: 'run-2' } })
    expect(other.ctxFor('x').random()).not.toBe(first[0])
  })

  it('aborts a side call that outlives its timeout', async () => {
    const { context, clock } = setup({ replies: [{ hang: true }] })
    const pending = context
      .ctxFor('memory:m')
      .callModel({ purpose: 'slow', messages: [], timeoutMs: 1000 })
    const rejected = expect(pending).rejects.toThrow('aborted')
    await clock.tick(1000)
    await rejected
    expect(context.drain()).toHaveLength(1)
  })

  it.each([
    ['check:completion', 30_000],
    ['memory:m', 120_000],
  ])(
    'gives a side call from %s the component time limit when it sets none',
    async (source, limit) => {
      const { context, clock } = setup({ replies: [{ hang: true }] })
      const pending = context.ctxFor(source).callModel({ purpose: 'slow', messages: [] })
      const rejected = expect(pending).rejects.toThrow('aborted')
      await clock.tick(limit - 1_001)
      expect(context.drain()).toHaveLength(0)
      await clock.tick(1)
      await rejected
      // 调用结束时就记进日志：不会在组件放弃之后还占着模型的并发名额。
      expect(context.drain()).toHaveLength(1)
    },
  )

  it('§3.14 aborts a timed side call at once when the run is cancelled while it starts', async () => {
    const run = new AbortController()
    const { context, main } = setup({
      replies: [{ hang: true }],
      patch: {
        signal: run.signal,
        // 写请求时运行被取消：此后才挂上的监听收不到 abort 事件。
        putBlob: async (data) => {
          run.abort()
          return `sha256:${data.length}`
        },
      },
    })
    await expect(
      context.ctxFor('memory:m').callModel({ purpose: 'slow', messages: [], timeoutMs: 1000 }),
    ).rejects.toThrow('aborted')
    expect(main.inputs).toHaveLength(0)
  })

  it('§3.14 starts no side call after the run is cancelled', async () => {
    const run = new AbortController()
    run.abort()
    const { context, main } = setup({ patch: { signal: run.signal } })
    await expect(
      context.ctxFor('memory:m').callModel({ purpose: 'late', messages: [] }),
    ).rejects.toThrow('aborted')
    expect(main.inputs).toHaveLength(0)
    expect(context.drain()).toEqual([])
  })

  it('reuses one context per source', () => {
    const { context } = setup()
    expect(context.ctxFor('a')).toBe(context.ctxFor('a'))
  })
})

function setupDeps(): RunContextDeps {
  return {
    run: runInfo,
    clock: new FakeClock(),
    hub: hubOf([]),
    logger: { log: () => {} },
    hosts: new Map(),
    signal: new AbortController().signal,
    state: () => initial({ runId: 'run-2' }),
    putBlob: async () => 'sha256:0',
    redact: (v) => v,
  }
}

describe('placeExternalCalls', () => {
  const call = { t: 'external_call', source: 's' } as unknown as RunEventBody
  const ev = (t: string) => ({ t }) as unknown as RunEventBody
  it.each([
    [
      'before context_built',
      [ev('step_started'), ev('context_built')],
      ['step_started', 'external_call', 'context_built'],
    ],
    [
      'before evaluated',
      [ev('evaluated'), ev('step_ended')],
      ['external_call', 'evaluated', 'step_ended'],
    ],
    ['before run_started', [ev('run_started')], ['external_call', 'run_started']],
    ['first otherwise', [ev('tool_finished')], ['external_call', 'tool_finished']],
  ])('%s', (_name, stage, expected) => {
    expect(placeExternalCalls(stage, [call]).map((e) => e.t)).toEqual(expected)
  })
})

describe('secretKeeper', () => {
  it('redacts every value the vault resolved', async () => {
    const keeper = secretKeeper({ resolve: async (ref) => `value-of-${ref.secret}` })
    expect(await keeper.vault.resolve({ secret: 'db' })).toBe('value-of-db')
    expect(keeper.redact('password value-of-db sk-abcdefghijk')).toBe(
      'password [REDACTED] [REDACTED]',
    )
    expect(keeper.redactValue({ a: ['value-of-db'] })).toEqual({ a: ['[REDACTED]'] })
  })

  it('refuses to resolve without a vault', async () => {
    await expect(secretKeeper().vault.resolve({ secret: 'db' })).rejects.toThrow('没有配置凭据库')
  })
})

describe('model calls from tools', () => {
  it('AC-008 records a tool model call under the tool source', async () => {
    const { context } = setup()
    const response = await context.callModelFor('tool:summarize', {
      purpose: 'digest',
      messages: [{ role: 'user', content: '长文' }],
    })
    expect(response).toMatchObject({ text: 'summary', usage: usage(7, 3) })
    expect(context.drain()).toEqual([
      expect.objectContaining({
        t: 'external_call',
        source: 'tool:summarize/digest',
        kind: 'model',
        usage: usage(7, 3),
      }),
    ])
  })

  it('AC-009 follows the signal of the tool call and adds no component deadline', async () => {
    const { context, clock, blobs } = setup({ replies: [{ hang: true }] })
    const call = new AbortController()
    const pending = context.callModelFor(
      'tool:slow',
      { purpose: 'digest', messages: [] },
      call.signal,
    )
    const settled = pending.then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    )
    // 组件的时限（30 秒减 1 秒）对工具来源不生效：工具自己的超时经信号生效。
    await clock.tick(60_000)
    expect(context.drain()).toEqual([])
    call.abort()
    expect(await settled).toBe('AbortError')
    const [event] = context.drain() as Array<Extract<RunEventBody, { t: 'external_call' }>>
    expect(event).toMatchObject({ source: 'tool:slow/digest', kind: 'model' })
    expect(blobs.get(event!.response)).toContain('error')
  })
})
