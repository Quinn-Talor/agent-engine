import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Deliverable } from '../contracts/agent.js'
import type {
  Candidate,
  Check,
  CheckMode,
  ComponentCtx,
  Fallback,
  OutputContract,
  RunInfo,
} from '../contracts/component.js'
import { abortError } from '../contracts/errors.js'
import type { RunEvent, RunEventBody } from '../contracts/events.js'
import type { ModelInput } from '../contracts/model.js'
import type { Notice } from '../contracts/run.js'
import {
  call,
  contextBuilt,
  evaluated,
  modelResponded,
  runStarted,
  sequence,
  stepEnded,
  stepStarted,
  toolFinished,
  type EventBody,
} from '../core/events.fixture.js'
import { apply, initial, nextStage, type RunState } from '../core/state.js'
import { FakeClock } from '../testing/fake-clock.js'
import { createDelivery, fallbackPrompt, type DeliverDeps } from './deliver.js'

const run: RunInfo = {
  runId: 'r1',
  rootRunId: 'r1',
  environment: { name: 'env', principalReachable: true },
  agent: { id: 'a' },
  task: {},
  model: { ref: 'fake:m', contextLimit: 1000 },
}
const fallback: Fallback = {
  instructions: { repeat: { reachable: '重复了，请提问。', unreachable: '重复了，请报告。' } },
  fixedText: '固定兜底文本',
}

/** 与 stdlib 的 text() 行为一致的最小输出契约（executor 测试不依赖 stdlib）。 */
const textContract = (patch: Partial<OutputContract> = {}): OutputContract => ({
  id: 'text',
  version: '1',
  kind: 'text',
  validate: async (c: Candidate) =>
    (c.text ?? '').trim()
      ? { ok: true }
      : { ok: false, issues: ['交付文本为空'], hint: '给出文本' },
  ...patch,
})

const check = (
  id: string,
  mode: CheckMode,
  pass: boolean | (() => Promise<never>),
  maxAttempts?: number,
): Check & { seen: Candidate[] } => {
  const seen: Candidate[] = []
  return {
    id,
    version: '1',
    mode,
    ...(maxAttempts ? { maxAttempts } : {}),
    seen,
    start: () => ({
      accept: async (candidate) => {
        seen.push(candidate)
        if (typeof pass === 'function') return pass()
        return pass ? { pass: true } : { pass: false, issues: [`${id} 不通过`], hint: `修正 ${id}` }
      },
    }),
  }
}

function setup(deliverable: Partial<Deliverable> = {}, patch: Partial<DeliverDeps> = {}) {
  const clock = new FakeClock()
  const notices: Notice[] = []
  const logs: string[] = []
  const generated: Array<{ input: ModelInput; timeoutMs: number }> = []
  const deps: DeliverDeps = {
    run,
    clock,
    deliverable: { output: textContract(), fallback, ...deliverable },
    environmentChecks: [],
    ctxFor: () => ({ log: (_l: string, m: string) => logs.push(m) }) as unknown as ComponentCtx,
    corpus: async () => ({ sources: [] }),
    notify: (n) => notices.push(n),
    generate: async (input, timeoutMs) => {
      generated.push({ input, timeoutMs })
      return 'progress report'
    },
    currentView: () => ({ messages: [{ role: 'user', content: 'task' }], tools: [] }),
    minimalView: () => ({ messages: [{ role: 'user', content: 'minimal' }], tools: [] }),
    sideEffects: () => [],
    finalizeReserveMs: 120_000,
    ...patch,
  }
  return { clock, notices, logs, generated, deps, delivery: createDelivery(deps) }
}

const fold = (bodies: EventBody[]): RunState =>
  sequence(bodies).reduce(apply, initial({ runId: 'r1' }))

const completed = (text: string, extra: EventBody[] = []): RunState =>
  fold([
    runStarted(),
    stepStarted(1),
    contextBuilt(1),
    modelResponded(1, { text }),
    ...extra,
    evaluated(1, { complete: true, sources: ['default'] }, { isFinalCandidate: true, text }),
    stepEnded(1),
  ])

const checked = (events: RunEventBody[]) =>
  events.find(
    (e): e is Extract<RunEventBody, { t: 'delivery_checked' }> => e.t === 'delivery_checked',
  )!

describe('deliver — normal path', () => {
  it('AC-004 delivers a valid text and notifies', async () => {
    const s = setup()
    const events = await s.delivery.deliver(completed('the answer'))
    expect(events).toEqual([
      {
        t: 'delivery_checked',
        step: 1,
        path: 'normal',
        attempt: 1,
        output: { ok: true },
        checks: [],
        outcome: 'delivered',
      },
    ])
    expect(s.notices).toEqual([{ t: 'delivered', text: 'the answer' }])
  })

  it('AC-005 returns an empty text once, then switches to the fallback path', async () => {
    const s = setup()
    const first = checked(await s.delivery.deliver(completed('')))
    expect(first).toMatchObject({
      outcome: 'returned',
      output: { ok: false, issues: ['交付文本为空'] },
      hint: '给出文本',
    })
    const second = checked(await s.delivery.deliver(completed('  ')))
    expect(second).toMatchObject({ outcome: 'fallback', attempt: 2 })
    expect(second.hint).toBeUndefined()
    expect(s.notices).toEqual([])
  })

  it('AC-006 counts structured repairs and fails beyond the limit', async () => {
    const schema = z.object({ score: z.number() })
    const output: OutputContract & { schema: typeof schema } = {
      id: 'structured',
      version: '1',
      kind: 'structured',
      maxRepairs: 1,
      schema,
      tools: [{ name: 'submit', description: '', inputSchema: schema, execute: async () => 'ok' }],
      validate: async () => ({ ok: false, issues: ['分数不合理'], hint: '重新评估' }),
    }
    const s = setup({ output })
    const state = completed('', [])
    expect(checked(await s.delivery.deliver(state)).outcome).toBe('returned')
    expect(checked(await s.delivery.deliver(state)).outcome).toBe('failed')
  })

  it('parses the submitted output for structured deliverables', async () => {
    const schema = z.object({ score: z.number(), note: z.string().default('n/a') })
    let validated: unknown
    const output: OutputContract & { schema: typeof schema } = {
      id: 'structured',
      version: '1',
      kind: 'structured',
      schema,
      tools: [{ name: 'submit', description: '', inputSchema: schema, execute: async () => 'ok' }],
      validate: async (c) => {
        validated = c.output
        return { ok: true }
      },
    }
    const s = setup({ output })
    const state = fold([
      runStarted({
        capabilities: [
          {
            capability: 'deliverable',
            kind: 'deliverable',
            version: '1',
            fingerprint: 'fp',
            tools: [
              { name: 'submit', schemaHash: 'h', intent: { kind: 'complete', code: 'submit' } },
            ],
          },
        ],
      }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'submit', { score: 3 })] }),
      toolFinished('c1', { capability: 'deliverable' }),
      evaluated(
        1,
        { complete: true, sources: ['intent:submit'] },
        { intent: { tool: 'submit', kind: 'complete', code: 'submit' }, isFinalCandidate: true },
      ),
      stepEnded(1),
    ])
    expect(checked(await s.delivery.deliver(state)).outcome).toBe('delivered')
    expect(validated).toEqual({ score: 3, note: 'n/a' })
    expect(s.notices).toEqual([{ t: 'delivered', text: '', output: { score: 3, note: 'n/a' } }])
  })

  it('AC-007 returns once for a failing gate, then lets it through as unresolved', async () => {
    const a = check('A', 'gate', false)
    const s = setup({ checks: [a] })
    const first = checked(await s.delivery.deliver(completed('x')))
    expect(first).toMatchObject({
      outcome: 'returned',
      hint: '修正 A',
      checks: [{ source: 'check:A', mode: 'gate', pass: false, issues: ['A 不通过'] }],
    })
    const second = checked(await s.delivery.deliver(completed('x')))
    expect(second).toMatchObject({
      outcome: 'delivered',
      checks: [{ source: 'check:A', mode: 'gate', pass: false, issues: ['A 不通过'] }],
    })
  })

  it('honours maxAttempts on a gate', async () => {
    const s = setup({ checks: [check('A', 'gate', false, 2)] })
    const outcomes = []
    for (let i = 0; i < 3; i++)
      outcomes.push(checked(await s.delivery.deliver(completed('x'))).outcome)
    expect(outcomes).toEqual(['returned', 'returned', 'delivered'])
  })

  it('AC-008 runs deliverable gates before environment gates', async () => {
    const s = setup(
      { checks: [check('A', 'gate', true)] },
      { environmentChecks: [check('B', 'gate', false)] },
    )
    expect(checked(await s.delivery.deliver(completed('x')))).toMatchObject({
      outcome: 'returned',
      checks: [
        { source: 'check:A', mode: 'gate', pass: true },
        { source: 'check:B', mode: 'gate', pass: false },
      ],
    })
  })

  it('runs a check once when the environment requires the same id, with the environment one', async () => {
    const own = check('completion', 'gate', true)
    const required = check('completion', 'gate', false)
    const s = setup({ checks: [own, check('A', 'gate', true)] }, { environmentChecks: [required] })
    expect(checked(await s.delivery.deliver(completed('x')))).toMatchObject({
      outcome: 'returned',
      checks: [
        { source: 'check:A', pass: true },
        { source: 'check:completion', pass: false },
      ],
    })
    expect(own.seen).toHaveLength(0)
    expect(required.seen).toHaveLength(1)
  })

  it('AC-009 annotates after delivery and only records shadow checks', async () => {
    const order: string[] = []
    const s = setup({ checks: [check('C', 'annotate', false), check('D', 'shadow', false)] })
    s.deps.notify = (n) => order.push(n.t)
    const annotate = s.deps.deliverable.checks![0]!
    const originalStart = annotate.start
    annotate.start = (r, c) => {
      const inner = originalStart(r, c)
      return {
        accept: async (candidate, corpus) => {
          order.push('annotate')
          return inner.accept(candidate, corpus)
        },
      }
    }
    const result = checked(await createDelivery(s.deps).deliver(completed('x')))
    expect(result.outcome).toBe('delivered')
    expect(result.checks).toEqual([
      { source: 'check:D', mode: 'shadow', pass: false, issues: ['D 不通过'] },
      { source: 'check:C', mode: 'annotate', pass: false, issues: ['C 不通过'] },
    ])
    expect(order).toEqual(['delivered', 'annotate'])
  })

  it('AC-010 treats a failing check as passed and logs it', async () => {
    const broken = check('E', 'gate', async () => Promise.reject(new Error('down')))
    const s = setup({ checks: [broken] })
    expect(checked(await s.delivery.deliver(completed('x')))).toMatchObject({
      outcome: 'delivered',
      checks: [{ source: 'check:E', mode: 'gate', pass: true }],
    })
    expect(s.logs).toEqual(['验收 E 出错'])
  })

  it('treats a throwing output validation as not acceptable', async () => {
    const s = setup({
      output: textContract({ validate: async () => Promise.reject(new Error('x')) }),
    })
    expect(checked(await s.delivery.deliver(completed('x')))).toMatchObject({
      outcome: 'returned',
      output: { ok: false, issues: ['输出校验出错'] },
      hint: '请重新给出交付内容',
    })
  })
})

const finalized = (code: string): RunState =>
  fold([
    runStarted(),
    stepStarted(1),
    contextBuilt(1),
    modelResponded(1, { text: 'stuck' }),
    evaluated(1, { finalize: { code }, sources: ['corrector'] }),
    stepEnded(1),
  ])

describe('deliver — fallback path', () => {
  it('AC-011 generates at level 0 without tools and sanitizes the text', async () => {
    const s = setup(
      {
        output: textContract({ sanitize: (t) => `${t} [sanitized]` }),
        checks: [check('C', 'annotate', true)],
      },
      { sideEffects: () => ['write /a'] },
    )
    const events = await s.delivery.deliver(finalized('repeat'))
    expect(events).toEqual([
      {
        t: 'fallback_generated',
        code: 'repeat',
        text: 'progress report [sanitized]',
        degradation: 0,
      },
      {
        t: 'delivery_checked',
        step: 1,
        path: 'fallback',
        attempt: 1,
        output: { ok: true },
        checks: [{ source: 'check:C', mode: 'annotate', pass: true }],
        outcome: 'delivered',
      },
    ])
    const [level0] = s.generated
    expect(level0!.timeoutMs).toBe(120_000)
    expect(level0!.input.toolChoice).toBe('none')
    expect(level0!.input.messages.at(-1)).toEqual({
      role: 'user',
      content: '重复了，请提问。\n\n已执行的副作用：\n- write /a',
    })
    expect(s.notices).toEqual([{ t: 'delivered', text: 'progress report [sanitized]' }])
  })

  it('falls back to the minimal view at level 1', async () => {
    const answers = [undefined, 'from minimal view']
    const s = setup({}, { generate: async () => answers.shift() })
    const events = await s.delivery.deliver(finalized('repeat'))
    expect(events[0]).toMatchObject({ text: 'from minimal view', degradation: 1 })
  })

  it('AC-012 uses the fixed text when both levels fail', async () => {
    const calls: number[] = []
    const s = setup({}, { generate: async (_i, timeoutMs) => (calls.push(timeoutMs), '   ') })
    const events = await s.delivery.deliver(finalized('repeat'))
    expect(events[0]).toEqual({
      t: 'fallback_generated',
      code: 'repeat',
      text: '固定兜底文本',
      degradation: 2,
    })
    expect(calls).toEqual([120_000, 120_000])
  })

  it('degrades to the fixed text when sanitize throws', async () => {
    const s = setup({
      output: textContract({
        sanitize: (t) => {
          if (t === 'progress report') throw new Error('sanitizer down')
          return `${t} [sanitized]`
        },
      }),
    })
    const events = await s.delivery.deliver(finalized('repeat'))
    expect(events[0]).toEqual({
      t: 'fallback_generated',
      code: 'repeat',
      text: '固定兜底文本 [sanitized]',
      degradation: 2,
    })
    expect(checked(events).outcome).toBe('delivered')
    expect(s.logs).toEqual(['sanitize 出错'])
  })

  it('uses the fixed text as is when sanitize keeps throwing', async () => {
    const s = setup({
      output: textContract({
        sanitize: () => {
          throw new Error('sanitizer down')
        },
      }),
    })
    const events = await s.delivery.deliver(finalized('repeat'))
    expect(events[0]).toMatchObject({ text: '固定兜底文本', degradation: 2 })
    expect(s.notices).toEqual([{ t: 'delivered', text: '固定兜底文本' }])
  })

  it('I7 skips a level whose prompt does not fit the context window', async () => {
    const huge = 'x'.repeat(50_000)
    const s = setup(
      {},
      { currentView: () => ({ messages: [{ role: 'user', content: huge }], tools: [] }) },
    )
    const events = await s.delivery.deliver(finalized('repeat'))
    expect(s.generated.map((g) => g.input.messages[0]!.content)).toEqual(['minimal'])
    expect(events[0]).toMatchObject({ text: 'progress report', degradation: 1 })
  })

  it('I7 uses the fixed text when even the minimal view does not fit', async () => {
    const huge = { messages: [{ role: 'user' as const, content: 'x'.repeat(50_000) }], tools: [] }
    const s = setup({}, { currentView: () => huge, minimalView: () => huge })
    const events = await s.delivery.deliver(finalized('repeat'))
    expect(s.generated).toEqual([])
    expect(events[0]).toMatchObject({ text: '固定兜底文本', degradation: 2 })
  })

  it('skips level 1 when less than a second of the reserve remains', async () => {
    const clock = new FakeClock()
    const calls: string[] = []
    const s = setup(
      {},
      {
        clock,
        finalizeReserveMs: 5_000,
        generate: (input) =>
          new Promise((resolve) => {
            calls.push(String(input.messages[0]!.content))
            clock.setTimer(4_500, () => resolve(undefined))
          }),
      },
    )
    const pending = s.delivery.deliver(finalized('repeat'))
    await clock.tick(4_500)
    const events = await pending
    expect(calls).toEqual(['task'])
    expect(events[0]).toMatchObject({ degradation: 2 })
  })
})

const withBudget = (budget: Record<string, number>, text = 'x'): RunState =>
  fold([
    runStarted({ task: { fingerprint: 'task-fp', budget } }),
    stepStarted(1),
    contextBuilt(1),
    modelResponded(1, { text }),
    evaluated(1, { complete: true, sources: ['default'] }, { isFinalCandidate: true, text }),
    stepEnded(1),
  ])

const after = (state: RunState, bodies: RunEventBody[]): RunState =>
  bodies.reduce(
    (s, body, i) => apply(s, { ...body, seq: s.lastSeq + 1 + i, at: s.lastAt } as RunEvent),
    state,
  )

describe('deliver — budget before returning', () => {
  it('goes to the fallback path with max_steps instead of returning after the last step', async () => {
    const s = setup({ checks: [check('A', 'gate', false)] })
    let state = withBudget({ maxSteps: 1 })
    const first = await s.delivery.deliver(state)
    expect(checked(first)).toMatchObject({
      outcome: 'fallback',
      checks: [{ source: 'check:A', mode: 'gate', pass: false }],
    })
    state = after(state, first)
    expect(nextStage(state)).toBe('deliver')
    const second = await s.delivery.deliver(state)
    expect(second[0]).toMatchObject({ t: 'fallback_generated', code: 'max_steps' })
    state = after(state, second)
    expect(state.step).toBe(1)
    expect(state.outcome).toEqual({ status: 'finalized', code: 'max_steps' })
  })

  it('does not return an empty text when no step is left', async () => {
    const s = setup()
    const events = await s.delivery.deliver(withBudget({ maxSteps: 1 }, ''))
    expect(checked(events)).toMatchObject({ outcome: 'fallback' })
    const state = after(withBudget({ maxSteps: 1 }, ''), events)
    expect((await s.delivery.deliver(state))[0]).toMatchObject({ code: 'max_steps' })
  })

  it('goes to the fallback path with timeout when only the finalize reserve is left', async () => {
    const s = setup({ checks: [check('A', 'gate', false)] }, { clock: new FakeClock(101_000) })
    const state = withBudget({ maxTotalMs: 200_000 })
    const events = await s.delivery.deliver(state)
    expect(checked(events)).toMatchObject({ outcome: 'fallback' })
    expect((await s.delivery.deliver(after(state, events)))[0]).toMatchObject({ code: 'timeout' })
  })

  it('records the finalize code on the fallback outcome itself', async () => {
    const s = setup({ checks: [check('A', 'gate', false)] })
    const state = withBudget({ maxSteps: 1 })
    const events = await s.delivery.deliver(state)
    expect(checked(events)).toMatchObject({ outcome: 'fallback', code: 'max_steps' })
    expect(after(state, events).fallbackCode).toBe('max_steps')
  })

  it('stops with budget instead of returning when the input tokens are used up', async () => {
    const s = setup({ checks: [check('A', 'gate', false)] })
    const state = withBudget({ maxInputTokens: 50 })
    const events = await s.delivery.deliver(state)
    expect(checked(events)).toMatchObject({ outcome: 'stopped', code: 'budget' })
    expect(after(state, events).outcome).toEqual({ status: 'stopped', code: 'budget' })
  })

  it('stops a structured deliverable that has no step left, since its fallback can only be text', async () => {
    const strict: OutputContract = {
      id: 'schema',
      version: '1',
      kind: 'structured',
      validate: async () => ({ ok: false, issues: ['缺少 total'], hint: '补上 total' }),
    }
    const s = setup({ output: strict })
    const state = withBudget({ maxSteps: 1 })
    const events = await s.delivery.deliver(state)
    expect(checked(events)).toMatchObject({ outcome: 'stopped', code: 'max_steps' })
    expect(after(state, events).outcome).toEqual({ status: 'stopped', code: 'max_steps' })
  })

  it('still returns while the budget allows another step', async () => {
    const s = setup({ checks: [check('A', 'gate', false)] })
    expect(checked(await s.delivery.deliver(withBudget({ maxSteps: 2 })))).toMatchObject({
      outcome: 'returned',
    })
  })
})

describe('deliver — abort', () => {
  it('does not count a gate aborted with the run as a pass and never delivers', async () => {
    const controller = new AbortController()
    const gate = check('A', 'gate', () => {
      controller.abort()
      return Promise.reject(abortError())
    })
    const later = check('B', 'gate', true)
    const s = setup({ checks: [gate, later] }, { signal: controller.signal })
    const events = await s.delivery.deliver(completed('x'))
    expect(events.some((e) => e.t === 'delivery_checked' && e.outcome === 'delivered')).toBe(false)
    expect(later.seen).toHaveLength(0)
    expect(s.notices).toEqual([])
  })

  it('records gates interrupted by the deadline as unresolved, not passed', async () => {
    const controller = new AbortController()
    const hung = check('A', 'gate', () => new Promise<never>(() => {}))
    const later = check('B', 'gate', true)
    const s = setup(
      { checks: [hung, later] },
      // 到截止时间：信号已触发，但不算取消，照样交付。
      { signal: controller.signal, cancelled: () => false },
    )
    const pending = s.delivery.deliver(completed('答案'))
    await s.clock.tick(10)
    controller.abort()
    const unresolved = { pass: false, issues: ['截止时间到，验收没有完成'] }
    expect(checked(await pending)).toMatchObject({
      outcome: 'delivered',
      checks: [
        { source: 'check:A', ...unresolved },
        { source: 'check:B', ...unresolved },
      ],
    })
    expect(later.seen).toHaveLength(0)
    expect(s.notices).toEqual([{ t: 'delivered', text: '答案' }])
  })

  it('ends a hung gate as soon as the run is aborted', async () => {
    const controller = new AbortController()
    const hung = check('A', 'gate', () => new Promise<never>(() => {}))
    const s = setup({ checks: [hung] }, { signal: controller.signal })
    const pending = s.delivery.deliver(completed('x'))
    await s.clock.tick(10)
    controller.abort()
    expect(await pending).toEqual([])
    expect(s.clock.now()).toBe(10)
    expect(s.notices).toEqual([])
  })

  it('skips the remaining fallback levels after an abort', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const s = setup(
      {},
      {
        signal: controller.signal,
        generate: async (input) => {
          calls.push(String(input.messages[0]!.content))
          controller.abort()
          return undefined
        },
      },
    )
    expect(await s.delivery.deliver(finalized('repeat'))).toEqual([])
    expect(calls).toEqual(['task'])
    expect(s.notices).toEqual([])
  })
})

describe('fallbackPrompt', () => {
  it('AC-013 picks the version by reachability and lists side effects', () => {
    expect(fallbackPrompt(fallback, 'repeat', false, ['write /a', 'send mail'])).toBe(
      '重复了，请报告。\n\n已执行的副作用：\n- write /a\n- send mail',
    )
    expect(fallbackPrompt(fallback, 'repeat', true, [])).toBe(
      '重复了，请提问。\n\n已执行的副作用：\n无',
    )
  })

  it('falls back to the default entry and then to the fixed text', () => {
    const withDefault: Fallback = {
      ...fallback,
      instructions: { '*': { reachable: 'r', unreachable: 'u' } },
    }
    expect(fallbackPrompt(withDefault, 'stall', true, [])).toBe('r\n\n已执行的副作用：\n无')
    expect(fallbackPrompt(fallback, 'stall', true, [])).toBe('固定兜底文本\n\n已执行的副作用：\n无')
  })

  it('F24 AC-004 puts the current task first and keeps the text unchanged without a goal', () => {
    expect(fallbackPrompt(fallback, 'repeat', true, [], ' 查茅台净利润 ')).toBe(
      '本次任务：查茅台净利润\n只针对本次任务作答：之前对话里的内容只是背景，不要再汇报。\n\n' +
        '重复了，请提问。\n\n已执行的副作用：\n无',
    )
    expect(fallbackPrompt(fallback, 'repeat', true, [], '  ')).toBe(
      '重复了，请提问。\n\n已执行的副作用：\n无',
    )
  })

  it('F24 AC-005 tells the model the goal of this run on the fallback path', async () => {
    const s = setup({}, { run: { ...run, task: { goal: 'g' } } })
    await s.delivery.deliver(finalized('repeat'))
    const last = s.generated[0]!.input.messages.at(-1)!
    expect(last.role).toBe('user')
    expect(String(last.content).startsWith('本次任务：g\n')).toBe(true)
  })
})
