import { describe, expect, it } from 'vitest'
import type { Check, Guard } from '../contracts/component.js'
import type { RunEvent } from '../contracts/events.js'
import type { Task } from '../contracts/task.js'
import { memoryArchive } from '../services/memory-archive.js'
import { fakeModel } from '../testing/fake-model.js'
import { fakeTool } from '../testing/fake-tool.js'
import { assembleEngine } from './engine.js'
import { agentOf, defaults, hubOf, passMemory, taskOf } from './engine.fixture.js'
import { regressionReplay, type RegressionInput } from './replay.js'

const quiet = { log: () => {} }

function probe(seen: Array<string | undefined>): Guard {
  return {
    id: 'probe',
    version: '1',
    start: (_run, ctx) => ({
      async check() {
        const r = await ctx.callModel({
          purpose: 'supervision:probe',
          messages: [{ role: 'user', content: '?' }],
        })
        seen.push(r?.text)
        return undefined
      },
    }),
  }
}

/** 录一次运行：第 1 步调用工具，第 2 步回答；引擎守卫每步调用一次监督模型。 */
async function record(opts: { checks?: Check[]; task?: Task } = {}) {
  const archive = memoryArchive()
  const model = fakeModel({
    model: 'main',
    replies: [
      { toolCalls: [{ id: 'c1', name: 'lookup' }], usage: { input: 50, output: 5 } },
      { text: 'R1' },
      { text: '答案', usage: { input: 60, output: 6 } },
      { text: 'R2' },
    ],
  })
  const seen: Array<string | undefined> = []
  const engine = assembleEngine(
    {
      services: {
        models: hubOf([model.port], { defaultModel: 'fake:main' }),
        archive,
        logger: quiet,
      },
    },
    {
      ...defaults(),
      ...(opts.checks ? { deliverable: { ...defaults().deliverable, checks: opts.checks } } : {}),
      memory: passMemory(),
      guards: [probe(seen)],
      logger: quiet,
    },
  )
  const lookup = fakeTool({ name: 'lookup', result: '找到了' })
  const capability = {
    id: 'core',
    version: '1',
    kind: 'tool',
    prepare: async () => ({ tools: [lookup], snapshot: { fingerprint: 'x' } }),
  }
  const run = engine
    .environment({ name: 'test', principal: { reachable: true } })
    .start(agentOf({ capabilities: [capability] }), opts.task ?? taskOf())
  const result = await run.result
  const events: RunEvent[] = []
  for await (const e of archive.read(run.runId)) events.push(e)
  const getBlob = async (ref: string) => String(await archive.getBlob(ref))
  return { events, getBlob, seen, result }
}

const base = (
  r: Awaited<ReturnType<typeof record>>,
  patch: Partial<RegressionInput> = {},
): RegressionInput => ({
  events: r.events,
  getBlob: r.getBlob,
  guards: {},
  deliverable: defaults().deliverable,
  ...patch,
})

describe('regressionReplay', () => {
  it('AC-018 reproduces every verdict and delivery with the same components', async () => {
    const r = await record()
    expect(r.seen).toEqual(['R1', 'R2'])
    const seen: Array<string | undefined> = []
    const report = await regressionReplay(base(r, { guards: { engine: [probe(seen)] } }))
    expect(report.steps.map((s) => [s.step, s.same])).toEqual([
      [1, true],
      [2, true],
    ])
    expect(report.deliveries).toEqual([
      expect.objectContaining({
        step: 2,
        attempt: 1,
        expected: 'delivered',
        actual: 'delivered',
        same: true,
      }),
    ])
    expect(report).not.toHaveProperty('firstDivergence')
    expect(report.missing).toEqual([])
    expect(seen).toEqual(['R1', 'R2'])
  })

  it('AC-019 points at the first step whose verdict changes', async () => {
    const r = await record()
    const ask: Guard = {
      id: 'ask',
      version: '1',
      start: () => ({
        check: (facts) => (facts.step === 2 ? { awaitInput: { code: 'need_info' } } : undefined),
      }),
    }
    const report = await regressionReplay(base(r, { guards: { task: [ask] } }))
    expect(report.steps.map((s) => s.same)).toEqual([true, false])
    expect(report.steps[1]!.actual).toMatchObject({ awaitInput: { code: 'need_info' } })
    expect(report.firstDivergence).toEqual({ kind: 'verdict', step: 2 })
  })

  it('AC-031 shows a new guard that ends from step 1 as a verdict divergence', async () => {
    const r = await record()
    const strict: Guard = {
      id: 'strict',
      version: '1',
      start: () => ({ check: () => ({ end: { as: 'finalize', code: 'stall' } }) }),
    }
    const report = await regressionReplay(base(r, { guards: { engine: [strict] } }))
    expect(report.steps[0]!.same).toBe(false)
    expect(report.steps[0]!.actual).toMatchObject({
      continue: { interventions: [{ source: 'steering' }] },
    })
    expect(report.firstDivergence).toEqual({ kind: 'verdict', step: 1 })
  })

  it('AC-020 lists deliveries a new check would have returned', async () => {
    const r = await record()
    const strict: Check = {
      id: 'strict',
      version: '1',
      mode: 'gate',
      start: () => ({ accept: async () => ({ pass: false, issues: ['太短'], hint: '写长一点' }) }),
    }
    const report = await regressionReplay(base(r, { environmentChecks: [strict] }))
    expect(report.deliveries).toEqual([
      expect.objectContaining({ expected: 'delivered', actual: 'returned', same: false }),
    ])
    expect(report.firstDivergence).toEqual({ kind: 'delivery', step: 2 })
  })

  it('AC-021 answers logged calls and lists calls the log does not have', async () => {
    const r = await record()
    const curious: Guard = {
      id: 'curious',
      version: '1',
      start: (_run, ctx) => ({
        async check() {
          const answer = await ctx.callModel({ purpose: 'supervision:new', messages: [] })
          await ctx.record('lookup', async () => 'live').catch(() => undefined)
          return answer ? { end: { as: 'stop', code: 'x' } } : undefined
        },
      }),
    }
    const report = await regressionReplay(base(r, { guards: { engine: [curious] } }))
    expect(report.missing).toEqual(['engine:curious/supervision:new', 'engine:curious/lookup'])
    expect(report.steps.every((s) => s.same)).toBe(true)
  })

  it('rebuilds the delivery corpus and the random numbers the way the live run does', async () => {
    const draws: number[] = []
    const grounded: Check = {
      id: 'grounded',
      version: '1',
      mode: 'gate',
      start: (_run, ctx) => ({
        accept: async (_candidate, corpus) => {
          draws.push(ctx.random())
          const tool = corpus.sources.find((s) => s.origin === 'tool')
          const ok =
            corpus.sources.some((s) => s.origin === 'input' && s.text === '你好') &&
            corpus.sources.some((s) => s.origin === 'history' && s.text === '上次的结论') &&
            tool?.toolName === 'lookup' &&
            tool.effect === 'side_effect' &&
            tool.isError === false
          return ok ? { pass: true } : { pass: false, issues: ['没有依据'], hint: '引用依据' }
        },
      }),
    }
    const task = taskOf({ history: [{ role: 'assistant', content: '上次的结论' }] })
    const r = await record({ checks: [grounded], task })
    expect(r.result.status).toBe('completed')
    const live = draws.splice(0)
    const report = await regressionReplay(
      base(r, { deliverable: { ...defaults().deliverable, checks: [grounded] } }),
    )
    expect(report.deliveries).toEqual([
      expect.objectContaining({ expected: 'delivered', actual: 'delivered', same: true }),
    ])
    expect(draws).toEqual(live)
    expect(live[0]).not.toBe(0.5)
  })

  it('returns an empty report for a run that ended before it started', async () => {
    const events: RunEvent[] = [
      {
        seq: 1,
        at: 0,
        t: 'run_ended',
        result: {
          runId: 'r1',
          status: 'stopped',
          code: 'notice_blocked',
          model: 'fake:main',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            main: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            memory: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            supervision: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            tools: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            children: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          steps: 0,
          toolCalls: 0,
        },
      },
    ]
    const report = await regressionReplay({
      events,
      getBlob: async () => '',
      guards: {},
      deliverable: defaults().deliverable,
    })
    expect(report).toEqual({ steps: [], deliveries: [], missing: [] })
  })

  it('reads the task input and history from the log when the caller does not pass them', async () => {
    const grounded: Check = {
      id: 'grounded',
      version: '1',
      mode: 'gate',
      start: () => ({
        accept: async (_candidate, corpus) =>
          corpus.sources.some((s) => s.origin === 'input' && s.text === '你好') &&
          corpus.sources.some((s) => s.origin === 'history' && s.text === '上次的结论')
            ? { pass: true }
            : { pass: false, issues: ['没有依据'], hint: '引用依据' },
      }),
    }
    const task = taskOf({ history: [{ role: 'assistant', content: '上次的结论' }] })
    const r = await record({ checks: [grounded], task })
    const started = r.events.find((e) => e.t === 'run_started')
    expect(started?.t === 'run_started' && started.task.content).toMatch(/^sha256:/)
    const report = await regressionReplay(
      base(r, { deliverable: { ...defaults().deliverable, checks: [grounded] } }),
    )
    expect(report.deliveries).toEqual([expect.objectContaining({ same: true })])
  })

  it('does not return a delivery for another step once the steps are used up', async () => {
    const archive = memoryArchive()
    const model = fakeModel({ model: 'main', replies: [{ text: 'a1' }, { text: '阶段性进展' }] })
    const failing: Check = {
      id: 'never',
      version: '1',
      mode: 'gate',
      start: () => ({ accept: async () => ({ pass: false, issues: ['不行'], hint: '再改' }) }),
    }
    const deliverable = { ...defaults().deliverable, checks: [failing] }
    const engine = assembleEngine(
      {
        services: {
          models: hubOf([model.port], { defaultModel: 'fake:main' }),
          archive,
          logger: quiet,
        },
      },
      { ...defaults(), deliverable, memory: passMemory(), guards: [], logger: quiet },
    )
    const run = engine
      .environment({ name: 'test', principal: { reachable: true } })
      .start(agentOf(), taskOf({ budget: { maxSteps: 1 } }))
    const result = await run.result
    expect(result).toMatchObject({
      status: 'finalized',
      code: 'max_steps',
      steps: 1,
      text: '阶段性进展',
    })
    const events: RunEvent[] = []
    for await (const e of archive.read(run.runId)) events.push(e)
    expect(events.filter((e) => e.t === 'step_started')).toHaveLength(1)
    const report = await regressionReplay({
      events,
      getBlob: async (ref) => String(await archive.getBlob(ref)),
      guards: {},
      deliverable,
    })
    expect(report.deliveries.map((d) => [d.expected, d.actual])).toEqual([
      ['fallback', 'fallback'],
      ['delivered', 'delivered'],
    ])
    expect(report.missing).toEqual([])
  })
})
