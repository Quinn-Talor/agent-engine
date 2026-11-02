import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ComponentCtx, RunInfo } from '../contracts/component.js'
import { toolError } from '../contracts/errors.js'
import type { RunEventBody } from '../contracts/events.js'
import type { Notice, RunResult } from '../contracts/run.js'
import type { ToolDef } from '../contracts/tool.js'
import { inputHash } from '../core/hash.js'
import { emptyRunUsage } from '../core/state.js'
import { FakeClock } from '../testing/fake-clock.js'
import { fakeTool } from '../testing/fake-tool.js'
import { act, type ActDeps, type ToolCallRequest } from './act.js'
import { Mutex } from './mutex.js'
import { prepareTool, type PreparedTool } from './tools.js'

const run: RunInfo = {
  runId: 'r1',
  rootRunId: 'r1',
  environment: { name: 'env', principalReachable: true },
  agent: { id: 'a' },
  task: {},
  model: { ref: 'fake:m', contextLimit: 1000 },
}

function setup(defs: ToolDef[], patch: Partial<ActDeps> = {}) {
  const clock = new FakeClock()
  const blobs = new Map<string, string>()
  const notices: Notice[] = []
  const toolset = new Map<string, PreparedTool>(
    defs.map((d) => [d.name, prepareTool(d, `cap-${d.name}`)]),
  )
  const deps: ActDeps = {
    step: 1,
    toolset,
    visible: new Set(toolset.keys()),
    blocks: [],
    permissions: {
      rules: [],
      principalReachable: true,
      approvalTimeoutMs: 300_000,
      run,
      ctxFor: () => ({ log: () => {} }) as unknown as ComponentCtx,
      clock,
      approvals: new Mutex(),
    },
    toolConcurrency: 5,
    clock,
    signal: new AbortController().signal,
    runId: 'r1',
    scope: { workspace: '/repo' },
    task: { subject: 's-1' },
    spawn: async () => {
      throw new Error('no spawn')
    },
    notify: (n) => notices.push(n),
    redact: (text) => text.replaceAll('sk-abcdefgh1234', '[REDACTED]'),
    putBlob: async (data) => {
      const ref = `sha256:${String(blobs.size).padStart(64, '0')}`
      blobs.set(ref, data)
      return ref
    },
    ...patch,
  }
  return { clock, blobs, notices, deps }
}

const call = (id: string, name: string, input: unknown = {}): ToolCallRequest => ({
  id,
  name,
  input,
})
const finished = (events: RunEventBody[]) =>
  events.filter((e): e is Extract<RunEventBody, { t: 'tool_finished' }> => e.t === 'tool_finished')

describe('act', () => {
  it('runs a call through every stage and records the result', async () => {
    const tool = fakeTool({
      name: 'write',
      effect: 'side_effect',
      inputSchema: z.object({ path: z.string() }),
      run: (_input, ctx) => {
        ctx.progress('halfway')
        return `key sk-abcdefgh1234 for ${ctx.idempotencyKey} in ${ctx.scope.workspace} of ${ctx.task.subject}`
      },
    })
    const s = setup([tool], {
      permissions: {
        ...setup([]).deps.permissions,
        rules: [{ id: 'sandbox', version: '1', permit: async () => 'allow' }],
      },
    })
    const events = await act([call('c1', 'write', { path: '/a' })], s.deps)
    expect(events.map((e) => e.t)).toEqual(['permission_decided', 'tool_finished'])
    const [result] = finished(events)
    expect(result).toMatchObject({
      callId: 'c1',
      capability: 'cap-write',
      effect: 'side_effect',
      isError: false,
      startedAt: 0,
      durationMs: 0,
    })
    expect(s.blobs.get(result!.shown)).toBe(
      '<tool_output>\nkey [REDACTED] for r1:c1 in /repo of s-1\n</tool_output>',
    )
    expect(s.notices).toEqual([{ t: 'tool_progress', callId: 'c1', note: 'halfway' }])
  })

  it('stops at the first failing stage', async () => {
    const search = fakeTool({ name: 'search', inputSchema: z.object({ q: z.string() }) })
    const guarded = fakeTool({
      name: 'guarded',
      validate: () => ({ error: toolError('UNSAFE', 'dangerous command') }),
    })
    const s = setup([search, guarded], {
      blocks: [
        {
          tool: 'search',
          inputHash: inputHash({ q: 'loop' }),
          code: 'repeat',
          reason: '重复',
          source: 'engine:roadblock',
          since: 1,
          until: Infinity,
        },
      ],
    })
    const events = await act(
      [
        call('c1', 'missing'),
        call('c2', 'search', { q: 'loop' }),
        call('c3', 'search', {}),
        call('c4', 'guarded'),
      ],
      s.deps,
    )
    expect(finished(events).map((e) => [e.callId, e.errorCode, e.capability])).toEqual([
      ['c1', 'TOOL_NOT_AVAILABLE', ''],
      ['c2', 'TOOL_BLOCKED', 'cap-search'],
      ['c3', 'INVALID_INPUT', 'cap-search'],
      ['c4', 'UNSAFE', 'cap-guarded'],
    ])
    expect(search.calls).toHaveLength(0)
    expect(guarded.calls).toHaveLength(0)
  })

  it('AC-014 writes redacted shown and raw blobs', async () => {
    const tool = fakeTool({
      name: 'dump',
      maxOutputChars: 20,
      result: `sk-abcdefgh1234 ${'x'.repeat(40)}`,
    })
    const s = setup([tool])
    const [result] = finished(await act([call('c1', 'dump')], s.deps))
    expect(s.blobs.get(result!.shown)).not.toContain('sk-abcdefgh1234')
    expect(s.blobs.get(result!.raw!)).toBe(`[REDACTED] ${'x'.repeat(40)}`)
  })

  it('AC-015 respects the concurrency limit and keeps call order', async () => {
    let running = 0
    let peak = 0
    const clock = new FakeClock()
    const slow = fakeTool({
      name: 'slow',
      run: () =>
        new Promise((resolve) => {
          running += 1
          peak = Math.max(peak, running)
          clock.setTimer(100, () => {
            running -= 1
            resolve('done')
          })
        }),
    })
    const s = setup([slow], { toolConcurrency: 2, clock })
    s.deps.permissions.clock = clock
    const pending = act([call('c1', 'slow'), call('c2', 'slow'), call('c3', 'slow')], s.deps)
    await clock.tick(300)
    const events = await pending
    expect(peak).toBe(2)
    expect(finished(events).map((e) => e.callId)).toEqual(['c1', 'c2', 'c3'])
  })

  it('AC-016 never overlaps an exclusive tool with other executions', async () => {
    const clock = new FakeClock()
    const spans: Array<[string, number, number]> = []
    const timed = (name: string, exclusive: boolean) =>
      fakeTool({
        name,
        exclusive,
        run: () =>
          new Promise((resolve) => {
            const start = clock.now()
            clock.setTimer(100, () => {
              spans.push([name, start, clock.now()])
              resolve('ok')
            })
          }),
      })
    const s = setup([timed('lock', true), timed('free', false)], { clock })
    const pending = act([call('c1', 'lock'), call('c2', 'free')], s.deps)
    await clock.tick(300)
    await pending
    expect(spans).toEqual([
      ['lock', 0, 100],
      ['free', 100, 200],
    ])
  })

  it('AC-017 rejects an intent tool called with other tools', async () => {
    const finish = fakeTool({ name: 'finish', intent: { kind: 'complete', code: 'finish' } })
    const search = fakeTool({ name: 'search' })
    const s = setup([finish, search])
    const events = await act([call('c1', 'finish'), call('c2', 'search')], s.deps)
    expect(finished(events).map((e) => [e.callId, e.errorCode])).toEqual([
      ['c1', 'INTENT_NOT_ALONE'],
      ['c2', undefined],
    ])
    expect(finish.calls).toHaveLength(0)
    expect(search.calls).toHaveLength(1)
  })

  it('lets a lone intent tool run', async () => {
    const finish = fakeTool({
      name: 'finish',
      intent: { kind: 'complete', code: 'finish' },
      result: '已记录',
    })
    const s = setup([finish])
    const [result] = finished(await act([call('c1', 'finish')], s.deps))
    expect(result!.isError).toBe(false)
  })

  it('AC-018 aborts the running call and skips the waiting one', async () => {
    const clock = new FakeClock()
    const controller = new AbortController()
    const slow = fakeTool({ name: 'slow', delayMs: 1_000, clock })
    const s = setup([slow], { toolConcurrency: 1, clock, signal: controller.signal })
    const pending = act([call('c1', 'slow'), call('c2', 'slow')], s.deps)
    await clock.tick(10)
    controller.abort()
    const events = await pending
    expect(finished(events).map((e) => [e.callId, e.errorCode])).toEqual([
      ['c1', 'TOOL_ABORTED'],
      ['c2', 'TOOL_ABORTED'],
    ])
    expect(slow.calls).toHaveLength(1)
  })

  it('records every child run of a call and sums child usage', async () => {
    const usage = { ...emptyRunUsage(), input: 10, output: 2 }
    const child = (runId: string, cost: number): RunResult => ({
      runId,
      status: 'completed',
      model: 'fake:m',
      usage,
      cost,
      steps: 1,
      toolCalls: 0,
    })
    let n = 0
    const delegate = fakeTool({
      name: 'delegate',
      run: async (_input, ctx) => {
        await ctx.spawn({} as never, {} as never)
        await ctx.spawn({} as never, {} as never)
        return 'delegated'
      },
    })
    const s = setup([delegate], {
      spawn: async () => {
        n += 1
        return child(`child-${n}`, 0.5)
      },
    })
    const [result] = finished(await act([call('c1', 'delegate')], s.deps))
    expect(result).toMatchObject({
      childRunId: 'child-2',
      childRunIds: ['child-1', 'child-2'],
      usage: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0 },
      cost: 1,
    })
  })

  it('surfaces a throwing validate as an exception envelope', async () => {
    const broken = fakeTool({
      name: 'broken',
      validate: () => {
        throw new Error('validator crashed')
      },
    })
    const s = setup([broken])
    const [result] = finished(await act([call('c1', 'broken')], s.deps))
    expect(result).toMatchObject({ isError: true, errorCode: 'TOOL_EXCEPTION' })
  })

  it('denies through permissions and keeps the decision events in the call group', async () => {
    const tool = fakeTool({ name: 'rm', risk: 'high' })
    const base = setup([tool])
    const s = setup([tool], {
      permissions: {
        ...base.deps.permissions,
        rules: [{ id: 'no-rm', version: '1', permit: async () => ({ deny: 'rm 被禁止' }) }],
      },
    })
    const events = await act([call('c1', 'rm')], s.deps)
    expect(events.map((e) => e.t)).toEqual(['permission_decided', 'tool_finished'])
    expect(finished(events)[0]).toMatchObject({ errorCode: 'PERMISSION_DENIED' })
    expect(tool.calls).toHaveLength(0)
  })

  it('ends a pending approval when the run is aborted', async () => {
    const controller = new AbortController()
    const tool = fakeTool({ name: 'rm' })
    const base = setup([tool])
    const s = setup([tool], {
      signal: controller.signal,
      permissions: {
        ...base.deps.permissions,
        rules: [
          {
            id: 'ask',
            version: '1',
            permit: async () => ({ ask: { summary: '删除？', risk: 'high' } }),
          },
        ],
        approver: { approve: () => new Promise(() => {}) },
      },
    })
    const pending = act([call('c1', 'rm')], s.deps)
    await s.clock.tick(10)
    controller.abort()
    const events = await pending
    expect(events.map((e) => e.t)).toEqual([
      'permission_decided',
      'approval_answered',
      'tool_finished',
    ])
    expect(finished(events)[0]).toMatchObject({ errorCode: 'TOOL_ABORTED' })
    expect(tool.calls).toHaveLength(0)
  })

  describe('I5: failures outside execute still produce a result for every call', () => {
    it('wraps a throwing safety.access', async () => {
      const bad = fakeTool({
        name: 'bad',
        access: () => {
          throw new Error('bad path')
        },
      })
      const ok = fakeTool({ name: 'ok', result: 'fine' })
      const s = setup([bad, ok])
      const events = await act([call('c1', 'bad'), call('c2', 'ok')], s.deps)
      expect(finished(events).map((e) => [e.callId, e.errorCode])).toEqual([
        ['c1', 'TOOL_EXCEPTION'],
        ['c2', undefined],
      ])
      expect(s.blobs.get(finished(events)[0]!.shown)).toContain('bad path')
      expect(bad.calls).toHaveLength(0)
    })

    it('wraps a throwing availability check', async () => {
      const tool = fakeTool({ name: 'svc' })
      const s = setup([tool])
      s.deps.toolset = new Map([
        [
          'svc',
          prepareTool(tool, 'cap-svc', {
            available: () => {
              throw new Error('breaker broken')
            },
          }),
        ],
      ])
      const [result] = finished(await act([call('c1', 'svc')], s.deps))
      expect(result).toMatchObject({ isError: true, errorCode: 'TOOL_EXCEPTION' })
      expect(tool.calls).toHaveLength(0)
    })

    it.each<[string, () => unknown]>([
      ['a BigInt', () => ({ n: 10n })],
      [
        'a circular object',
        () => {
          const o: Record<string, unknown> = {}
          o.self = o
          return o
        },
      ],
      ['a function', () => () => 1],
    ])('wraps an unserializable result (%s)', async (_name, value) => {
      const tool = fakeTool({ name: 'count', run: value })
      const s = setup([tool])
      const [result] = finished(await act([call('c1', 'count')], s.deps))
      expect(result).toMatchObject({ isError: true, errorCode: 'TOOL_EXCEPTION' })
      expect(s.blobs.get(result!.shown)).toContain('序列化')
    })

    it('records an error envelope when the result blob cannot be stored', async () => {
      const tool = fakeTool({ name: 'big', effect: 'none', result: 'x'.repeat(100) })
      const s = setup([tool])
      const put = s.deps.putBlob
      s.deps.putBlob = async (data) => {
        if (data.includes('x'.repeat(100))) throw new Error('blob too large')
        return put(data)
      }
      const [result] = finished(await act([call('c1', 'big')], s.deps))
      expect(result).toMatchObject({ isError: true, errorCode: 'TOOL_EXCEPTION' })
      expect(s.blobs.get(result!.shown)).toContain('blob too large')
    })

    it('marks a side effect whose result could not be stored as possibly executed', async () => {
      const pay = fakeTool({ name: 'pay', effect: 'side_effect', result: '已扣款' })
      const s = setup([pay])
      const put = s.deps.putBlob
      s.deps.putBlob = async (data) => {
        if (data.includes('已扣款')) throw new Error('存储暂时不可用')
        return put(data)
      }
      const [result] = finished(await act([call('c1', 'pay')], s.deps))
      expect(result).toMatchObject({
        isError: true,
        errorCode: 'TOOL_RESULT_LOST',
        possiblyExecuted: true,
      })
      expect(s.blobs.get(result!.shown)).toContain('工具已执行，但结果保存失败')
      expect(s.blobs.get(result!.shown)).toContain('不要用相同输入重试')
    })

    it('still finishes the call when storage is down entirely', async () => {
      const s = setup([fakeTool({ name: 'ok', effect: 'none' })], {
        putBlob: async () => {
          throw new Error('disk full')
        },
      })
      const [result] = finished(await act([call('c1', 'ok')], s.deps))
      expect(result).toMatchObject({ callId: 'c1', isError: true, errorCode: 'TOOL_EXCEPTION' })
      expect(result!.shown).toMatch(/^sha256:[0-9a-f]{64}$/)
    })
  })

  it('records the error class a tool declares in its envelope', async () => {
    const lookup = fakeTool({
      name: 'lookup',
      run: () => ({ ...toolError('ORDER_NOT_FOUND', '没有这个订单'), errorClass: 'deterministic' }),
    })
    const s = setup([lookup])
    const [result] = finished(await act([call('c1', 'lookup')], s.deps))
    expect(result).toMatchObject({ errorCode: 'ORDER_NOT_FOUND', errorClass: 'deterministic' })
  })

  it('tells the model a timed-out side effect may have run, and leaves reads alone', async () => {
    const pay = fakeTool({ name: 'pay', effect: 'side_effect', delayMs: 200, timeoutMs: 100 })
    const read = fakeTool({ name: 'read', effect: 'none', delayMs: 200, timeoutMs: 100 })
    const s = setup([pay, read])
    const pending = act([call('c1', 'pay'), call('c2', 'read')], s.deps)
    await s.clock.tick(100)
    const [paid, looked] = finished(await pending)
    expect(paid).toMatchObject({ errorCode: 'TOOL_TIMEOUT', possiblyExecuted: true })
    expect(s.blobs.get(paid!.shown)).toContain('HINT: 结果未知，可能已经执行')
    expect(looked).toMatchObject({ errorCode: 'TOOL_TIMEOUT' })
    expect(looked).not.toHaveProperty('possiblyExecuted')
    expect(s.blobs.get(looked!.shown)).not.toContain('可能已经执行')
  })

  it('passes the call signal to spawn so a timed-out tool stops its child', async () => {
    const clock = new FakeClock()
    let childSignal: AbortSignal | undefined
    const delegate = fakeTool({
      name: 'delegate',
      timeoutMs: 1_000,
      run: (_input, ctx) => ctx.spawn({} as never, {} as never),
    })
    const s = setup([delegate], {
      clock,
      spawn: (_agent, _task, opts) => {
        childSignal = opts?.signal
        return new Promise(() => {})
      },
    })
    const pending = act([call('c1', 'delegate')], s.deps)
    await clock.tick(10)
    expect(childSignal?.aborted).toBe(false)
    await clock.tick(1_000)
    const [result] = finished(await pending)
    expect(result).toMatchObject({ errorCode: 'TOOL_TIMEOUT' })
    expect(childSignal?.aborted).toBe(true)
  })
})
