import { describe, expect, it } from 'vitest'
import type {
  CallBlock,
  ComponentCtx,
  Guard,
  GuardOpinion,
  RunInfo,
} from '../contracts/component.js'
import type { RunEvent, RunEventBody } from '../contracts/events.js'
import {
  call,
  contextBuilt,
  modelResponded,
  runStarted,
  sequence,
  stepStarted,
  toolFinished,
  type EventBody,
} from '../core/log/events.fixture.js'
import { apply, initial, type RunState } from '../core/run/state.js'
import { FakeClock } from '../testing/fake-clock.js'
import { createEvaluator, type EvaluateDeps } from './evaluate.js'

const run: RunInfo = {
  runId: 'r1',
  rootRunId: 'r1',
  environment: { name: 'env', principalReachable: true, approver: false },
  agent: { id: 'a' },
  task: { goal: '订一张去东京的机票' },
  model: { ref: 'fake:m', contextLimit: 10_000 },
}
const fold = (bodies: EventBody[], from = initial({ runId: 'r1' })): RunState =>
  sequence(bodies).reduce(apply, from)
/** 第 1 步：调用一个工具，没有作答（不是候选）。 */
const working = () =>
  fold([
    runStarted(),
    stepStarted(1),
    contextBuilt(1),
    modelResponded(1, { toolCalls: [call('c1')] }),
    toolFinished('c1'),
  ])
const answered = () =>
  fold([runStarted(), stepStarted(1), contextBuilt(1), modelResponded(1, { text: 'answer' })])

/** 把评估产出的事件追加到状态上，再走到下一步（可选带委托人引导）。 */
function nextStep(state: RunState, events: RunEventBody[], step: number, steer?: string): RunState {
  let s = state
  for (const [i, body] of events.entries()) {
    s = apply(s, { ...body, seq: s.lastSeq + 1 + i, at: 3_000 } as RunEvent)
  }
  const bodies: EventBody[] = [
    ...(steer !== undefined ? [{ t: 'steer_received' as const, text: steer }] : []),
    stepStarted(step),
    contextBuilt(step),
    modelResponded(step, { toolCalls: [call(`c${step}`)] }),
    toolFinished(`c${step}`),
  ]
  return sequence(bodies).reduce((acc, e) => apply(acc, { ...e, seq: acc.lastSeq + 1 }), s)
}

const guard = (
  id: string,
  check: () => GuardOpinion | undefined | Promise<GuardOpinion | undefined>,
  patch: Partial<Guard> = {},
): Guard => ({ id, version: '1', start: () => ({ check }), ...patch })
const warn = (problem: string): GuardOpinion => ({ warn: { problem } })

function setup(patch: Partial<EvaluateDeps> = {}) {
  const logs: string[] = []
  const deps: EvaluateDeps = {
    run,
    clock: new FakeClock(2_000),
    guards: {},
    ctxFor: (source) =>
      ({ log: (_l: string, m: string) => logs.push(`${source}: ${m}`) }) as unknown as ComponentCtx,
    structured: false,
    ...patch,
  }
  return { logs, deps, evaluator: createEvaluator(deps) }
}

const evaluatedOf = (events: RunEventBody[]) =>
  events.find((e): e is Extract<RunEventBody, { t: 'evaluated' }> => e.t === 'evaluated')!

describe('createEvaluator', () => {
  it('completes a final candidate when no guard objects', async () => {
    const s = setup()
    const events = await s.evaluator.evaluate(answered())
    expect(events.map((e) => e.t)).toEqual(['evaluated', 'step_ended'])
    expect(evaluatedOf(events)).toMatchObject({
      step: 1,
      opinions: [{ source: 'guard:pressure', mode: 'active', durationMs: 0 }],
      verdict: { complete: true, sources: ['candidate'] },
    })
  })

  it('AC-023 runs guards in owner order and turns warnings into one steering message', async () => {
    const block = {
      tool: 'search',
      inputHash: 'h1',
      code: 'repeat',
      reason: '连续 2 次返回相同结果',
    }
    const s = setup({
      guards: {
        task: [guard('a', () => warn('任务问题'))],
        environment: [guard('b', () => warn('环境问题'))],
        capability: [guard('c', () => warn('能力问题'))],
        engine: [guard('d', () => ({ warn: { problem: '引擎问题', block: [block] } }))],
      },
    })
    const e = evaluatedOf(await s.evaluator.evaluate(working()))
    expect(e.opinions.map((o) => o.source)).toEqual([
      'task:a',
      'environment:b',
      'capability:c',
      'engine:d',
      'guard:pressure',
    ])
    expect(e.opinions[3]!.opinion).toEqual({
      continue: { interventions: [{ hint: { text: '- 引擎问题' } }, { block }] },
    })
    expect(e.verdict).toMatchObject({
      sources: ['task:a', 'environment:b', 'capability:c', 'engine:d'],
    })
    const interventions = 'continue' in e.verdict ? e.verdict.continue.interventions! : []
    expect(interventions).toHaveLength(2)
    expect(interventions[0]).toMatchObject({ source: 'steering' })
    const text = 'hint' in interventions[0]! ? interventions[0].hint.text : ''
    expect(text).toContain('[纠偏 · 第 1 步]')
    expect(text).toContain('目标：订一张去东京的机票')
    expect(text).toContain('- 任务问题\n- 环境问题\n- 能力问题\n- 引擎问题')
    expect(text).toContain('已封住（再调用将收尾）：\n- search：连续 2 次返回相同结果')
    expect(text).toContain('剩余：步数 999')
    expect(interventions[1]).toEqual({ block, source: 'engine:d' })
  })

  it('lists a warn with blocks by its problem only: reasons and suggestions go with the blocks', async () => {
    const block: CallBlock = {
      tool: 'fetch',
      inputHash: 'h1',
      code: 'failure_streak',
      reason: '已失败 2 次（TOOL_TIMEOUT）',
      suggest: '改用其他工具',
    }
    const s = setup({
      guards: {
        engine: [
          guard('d', () => ({
            warn: { problem: '1 个调用已封住', suggest: '改用其他工具', block: [block] },
            detail: 'fetch: 已失败 2 次（TOOL_TIMEOUT）',
          })),
        ],
      },
    })
    const e = evaluatedOf(await s.evaluator.evaluate(working()))
    const interventions = 'continue' in e.verdict ? e.verdict.continue.interventions! : []
    const text = 'hint' in interventions[0]! ? interventions[0].hint.text : ''
    expect(text).toContain('发现：\n- 1 个调用已封住\n已封住（再调用将收尾）：')
    expect(text).toContain('- fetch：已失败 2 次（TOOL_TIMEOUT）；建议：改用其他工具')
    expect(text.match(/改用其他工具/g)).toHaveLength(1)
    expect(e.opinions[0]!.detail).toBe('fetch: 已失败 2 次（TOOL_TIMEOUT）')
  })

  it('lists the exits the run actually has', async () => {
    const intents = {
      capability: 'intents',
      kind: 'intents',
      version: '1',
      fingerprint: 'fp',
      tools: [
        { name: 'finish', schemaHash: 'h', intent: { kind: 'complete' as const, code: 'finish' } },
        { name: 'propose', schemaHash: 'h', intent: { kind: 'await_input' as const, code: 'p' } },
        { name: 'ask_user', schemaHash: 'h', intent: { kind: 'await_input' as const, code: 'a' } },
        { name: 'report_blocked', schemaHash: 'h', intent: { kind: 'stop' as const, code: 'b' } },
      ],
    }
    const state = fold([
      runStarted({ capabilities: [intents] }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'propose')] }),
      toolFinished('c1', { isError: true }),
    ])
    const s = setup({ guards: { engine: [guard('d', () => warn('问题'))] } })
    const e = evaluatedOf(await s.evaluator.evaluate(state))
    const hint = 'continue' in e.verdict ? e.verdict.continue.interventions![0]! : undefined
    expect(hint && 'hint' in hint ? hint.hint.text : '').toContain(
      '出口：现有信息已经足够就直接给出结果；缺少关键信息可以用 ask_user 询问委托人；确实无法完成，用 report_blocked 说明原因。',
    )
  })

  it('AC-024 defers an end that was not warned about first', async () => {
    const s = setup({
      guards: { engine: [guard('d', () => ({ end: { as: 'finalize', code: 'stall' } }))] },
    })
    const first = await s.evaluator.evaluate(working())
    const e1 = evaluatedOf(first)
    expect(e1.opinions[0]).toMatchObject({
      source: 'engine:d',
      deferred: true,
      opinion: {
        continue: {
          interventions: [
            { hint: { text: '- 守卫判定需要收尾（stall）；问题如果持续，下一步将收尾' } },
          ],
        },
      },
    })
    expect(e1.verdict).toMatchObject({ continue: {} })
    const e2 = evaluatedOf(await s.evaluator.evaluate(nextStep(working(), first, 2)))
    expect(e2.opinions[0]).toEqual({
      source: 'engine:d',
      opinion: { finalize: { code: 'stall' } },
      mode: 'active',
      durationMs: 0,
    })
    expect(e2.verdict).toEqual({ finalize: { code: 'stall' }, sources: ['engine:d'] })
  })

  it('computes the time left from the last logged event, so replay renders the same text', async () => {
    const state = fold([
      runStarted({
        task: {
          fingerprint: 't',
          content: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          budget: { maxTotalMs: 600_000, finalizeReserveMs: 0 },
        },
      }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1')] }),
      toolFinished('c1'),
    ])
    // 运行在 1_000 开始，最后一条事件在 1_040；评估时时钟已经走到 2_100。
    const s = setup({
      clock: new FakeClock(2_100),
      guards: { engine: [guard('d', () => warn('p'))] },
    })
    const e = evaluatedOf(await s.evaluator.evaluate(state))
    const hint = 'continue' in e.verdict ? e.verdict.continue.interventions![0]! : undefined
    expect(hint && 'hint' in hint ? hint.hint.text : '').toContain('时间 599 秒')
    expect(e.observation.pressure.time).toBeCloseTo(40 / 600_000)
  })

  it('G2 defers an end whose earlier warning never reached the model', async () => {
    const long = (id: string) => guard(id, () => warn(id.repeat(300)))
    let n = 0
    const late = guard('e', () =>
      ++n === 1 ? warn('引擎问题') : { end: { as: 'finalize', code: 'stall' } },
    )
    const crowded = setup({
      guards: { task: [long('t1'), long('t2'), long('t3')], engine: [late] },
    })
    const first = await crowded.evaluator.evaluate(working())
    const text = (() => {
      const v = evaluatedOf(first).verdict
      const h = 'continue' in v ? v.continue.interventions![0]! : undefined
      return h && 'hint' in h ? h.hint.text : ''
    })()
    expect(text).not.toContain('引擎问题')
    const second = evaluatedOf(await crowded.evaluator.evaluate(nextStep(working(), first, 2)))
    expect(second.opinions.find((o) => o.source === 'engine:e')).toMatchObject({ deferred: true })
    expect(second.verdict).toMatchObject({ continue: {} })

    let m = 0
    const swallowed = setup({
      guards: {
        engine: [
          guard('p', () =>
            ++m === 1 ? warn('计划没有推进') : { end: { as: 'finalize', code: 'no_progress' } },
          ),
        ],
      },
    })
    const done = await swallowed.evaluator.evaluate(answered())
    expect(evaluatedOf(done).verdict).toMatchObject({ complete: true })
    const after = evaluatedOf(await swallowed.evaluator.evaluate(nextStep(answered(), done, 2)))
    expect(after.opinions[0]).toMatchObject({ deferred: true })
  })

  it('AC-024 renders a stop end with the guard detail as message', async () => {
    let n = 0
    const s = setup({
      guards: {
        task: [
          guard('t', () =>
            ++n === 1 ? warn('p') : { end: { as: 'stop', code: 'x' }, detail: '计数 3' },
          ),
        ],
      },
    })
    const first = await s.evaluator.evaluate(working())
    const e2 = evaluatedOf(await s.evaluator.evaluate(nextStep(working(), first, 2)))
    expect(e2.verdict).toEqual({ stop: { code: 'x', message: '计数 3' }, sources: ['task:t'] })
  })

  it('AC-025 restarts every guard when a steer takes effect', async () => {
    let starts = 0
    const counting: Guard = {
      id: 'count',
      version: '1',
      start: () => {
        starts++
        let n = 0
        return {
          check: () => ({ end: { as: 'finalize', code: 'x' }, detail: `n=${++n}` }),
        }
      },
    }
    const s = setup({ guards: { engine: [counting] } })
    const first = await s.evaluator.evaluate(working())
    expect(evaluatedOf(first).opinions[0]).toMatchObject({ deferred: true, detail: 'n=1' })
    const e2 = evaluatedOf(await s.evaluator.evaluate(nextStep(working(), first, 2, '换个方向')))
    expect(starts).toBe(2)
    expect(e2.opinions[0]).toMatchObject({ deferred: true, detail: 'n=1' })
    expect(e2.verdict).toMatchObject({ continue: {} })
  })

  it('AC-026 degrades a failing guard to no opinion, or stops when it asks to', async () => {
    const clock = new FakeClock(2_000)
    const s = setup({
      clock,
      guards: {
        engine: [
          guard('slow', () => new Promise(() => {})),
          guard('broken', async () => Promise.reject(new Error('boom'))),
          guard('ok', () => warn('p')),
        ],
      },
    })
    const pending = s.evaluator.evaluate(working())
    await clock.tick(30_000)
    const e = evaluatedOf(await pending)
    expect(e.opinions.slice(0, 2)).toEqual([
      { source: 'engine:slow', mode: 'active', durationMs: 30_000, error: true },
      { source: 'engine:broken', mode: 'active', durationMs: 0, error: true },
    ])
    expect(e.verdict).toMatchObject({ continue: {}, sources: ['engine:ok'] })
    expect(s.logs).toEqual(['engine:broken: engine:broken 出错', 'engine:slow: engine:slow 出错'])

    const strict = setup({
      guards: {
        environment: [
          guard('policy', async () => Promise.reject(new Error('boom')), { onError: 'stop' }),
        ],
      },
    })
    const e2 = evaluatedOf(await strict.evaluator.evaluate(answered()))
    expect(e2.opinions[0]).toMatchObject({ error: true })
    expect(e2.verdict).toEqual({
      stop: { code: 'guard_error:policy', message: 'environment:policy 出错' },
      sources: ['environment:policy'],
    })
  })

  it('treats a guard that returns null as having no opinion, even with onError stop', async () => {
    const s = setup({
      guards: {
        environment: [guard('quiet', () => null as unknown as undefined, { onError: 'stop' })],
      },
    })
    const e = evaluatedOf(await s.evaluator.evaluate(answered()))
    expect(e.opinions[0]).toEqual({ source: 'environment:quiet', mode: 'active', durationMs: 0 })
    expect(e.verdict).toEqual({ complete: true, sources: ['candidate'] })
    expect(s.logs).toEqual([])
  })

  it('AC-026 records shadow opinions without letting them decide', async () => {
    const s = setup({
      guards: {
        engine: [guard('trial', () => ({ end: { as: 'stop', code: 'x' } }), { mode: 'shadow' })],
      },
    })
    const e = evaluatedOf(await s.evaluator.evaluate(answered()))
    expect(e.opinions[0]).toEqual({
      source: 'engine:trial',
      opinion: { stop: { code: 'x', message: 'engine:trial 要求停止' } },
      mode: 'shadow',
      durationMs: 0,
    })
    expect(e.verdict).toEqual({ complete: true, sources: ['candidate'] })
  })

  it('handles a guard whose start throws', async () => {
    const s = setup({
      guards: {
        task: [
          {
            id: 'bad-start',
            version: '1',
            start: () => {
              throw new Error('no config')
            },
          },
        ],
      },
    })
    const e = evaluatedOf(await s.evaluator.evaluate(answered()))
    expect(e.opinions[0]).toEqual({
      source: 'task:bad-start',
      mode: 'active',
      durationMs: 0,
      error: true,
    })
  })

  it('starts guards once per run and passes awaitInput through', async () => {
    let starts = 0
    const s = setup({
      guards: {
        engine: [
          { id: 'q', version: '1', start: () => (starts++, { check: () => undefined }) },
          guard('ask', () => ({ awaitInput: { code: 'need_info' } })),
        ],
      },
    })
    const first = await s.evaluator.evaluate(working())
    expect(evaluatedOf(first).verdict).toEqual({
      awaitInput: { code: 'need_info' },
      sources: ['engine:ask'],
    })
    await s.evaluator.evaluate(nextStep(working(), first, 2))
    expect(starts).toBe(1)
  })

  it('finalizes instead of waiting for input when nobody can answer, after warning once', async () => {
    const s = setup({
      run: { ...run, environment: { name: 'bg', principalReachable: false, approver: false } },
      guards: { task: [guard('ask', () => ({ awaitInput: { code: 'need_info' } }))] },
    })
    const first = await s.evaluator.evaluate(working())
    expect(evaluatedOf(first).verdict).toMatchObject({ continue: {}, sources: ['task:ask'] })
    const second = await s.evaluator.evaluate(nextStep(working(), first, 2))
    expect(evaluatedOf(second).verdict).toEqual({
      finalize: { code: 'need_info' },
      sources: ['task:ask'],
    })
  })

  it('records when it decided, after the guards ran, so replay can judge time the same way', async () => {
    const clock = new FakeClock(2_000)
    const s = setup({
      clock,
      guards: {
        task: [
          guard('slow', async () => {
            await clock.tick(10_000)
            return undefined
          }),
        ],
      },
    })
    const e = evaluatedOf(await s.evaluator.evaluate(working()))
    expect(e.decidedAt).toBe(12_000)
  })

  it('passes tool output previews from blobs to the observation', async () => {
    const s = setup({ getBlob: async () => '<tool_output>\nfound 3 results\n</tool_output>' })
    const e = evaluatedOf(await s.evaluator.evaluate(working()))
    expect(e.observation.toolCalls[0]).toMatchObject({ outputPreview: 'found 3 results' })
  })

  it('applies the structured guard through the budget state', async () => {
    let n = 0
    const s = setup({
      structured: true,
      guards: {
        engine: [
          guard('g', () => (++n === 1 ? warn('p') : { end: { as: 'finalize', code: 'stall' } })),
        ],
      },
    })
    const first = await s.evaluator.evaluate(working())
    const e = evaluatedOf(await s.evaluator.evaluate(nextStep(working(), first, 2)))
    expect(e.verdict).toMatchObject({ stop: { code: 'stall' } })
  })
})
