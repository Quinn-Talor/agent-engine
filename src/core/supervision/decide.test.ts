import { describe, expect, it } from 'vitest'
import type { Opinion } from '../../contracts/component.js'
import { budgetState, decide, type BudgetState, type SourcedOpinion } from './decide.js'
import {
  contextBuilt,
  modelResponded,
  observation,
  runStarted,
  sequence,
  stepStarted,
} from '../log/events.fixture.js'
import { apply, initial } from '../run/state.js'

const budget = (patch: Partial<BudgetState> = {}): BudgetState => ({
  stepsLeft: 10,
  tokensExhausted: false,
  costExhausted: false,
  finalizeReserveMs: 120_000,
  structured: false,
  ...patch,
})
const op = (source: string, opinion: Opinion): SourcedOpinion => ({ source, opinion })
const hint = (text: string): Opinion => ({ continue: { interventions: [{ hint: { text } }] } })

describe('decide', () => {
  it('AC-021 completes a final candidate when nobody objects', () => {
    expect(decide(observation({ isFinalCandidate: true }), [], budget())).toEqual({
      complete: true,
      sources: ['candidate'],
    })
  })

  it('AC-021 continues by default when the step is not a final candidate', () => {
    expect(decide(observation(), [], budget())).toEqual({
      continue: { interventions: [] },
      sources: ['default'],
    })
  })

  it.each<[string, boolean, SourcedOpinion[], object]>([
    [
      'stop beats complete',
      true,
      [op('engine:a', { stop: { code: 'x', message: 'm' } })],
      { stop: { code: 'x', message: 'm' }, sources: ['engine:a'] },
    ],
    [
      'await input beats complete',
      true,
      [op('task:a', { awaitInput: { code: 'ask' } })],
      { awaitInput: { code: 'ask' }, sources: ['task:a'] },
    ],
    [
      'a candidate beats a guard finalize',
      true,
      [op('engine:failure-streak', { finalize: { code: 'failure_streak' } })],
      { complete: true, sources: ['candidate'] },
    ],
    [
      'finalize beats continue',
      false,
      [op('task:a', hint('go on')), op('engine:b', { finalize: { code: 'stall' } })],
      { finalize: { code: 'stall' }, sources: ['engine:b'] },
    ],
    [
      'a candidate beats a continue opinion',
      true,
      [op('environment:r', hint('verify'))],
      { complete: true, sources: ['candidate'] },
    ],
  ])('AC-020 merge order: %s', (_name, candidate, opinions, expected) => {
    expect(decide(observation({ isFinalCandidate: candidate }), opinions, budget())).toEqual(
      expected,
    )
  })

  it('AC-021 finalizes with the block code when a blocked call is called again', () => {
    const obs = observation({
      interventions: {
        applied: [],
        violated: [{ source: 'engine:roadblock', code: 'failure_streak' }],
      },
    })
    expect(decide(obs, [op('task:a', hint('x'))], budget())).toEqual({
      finalize: { code: 'failure_streak' },
      sources: ['guard:violation'],
    })
    expect(decide(obs, [], budget({ structured: true }))).toEqual({
      stop: {
        code: 'failure_streak',
        message: 'finalize:failure_streak 在结构化交付下改为停止',
      },
      sources: ['guard:violation', 'guard:structured'],
    })
  })

  it('takes the earliest source among end opinions of the same level', () => {
    const verdict = decide(
      observation(),
      [op('task:a', { finalize: { code: 'a' } }), op('engine:b', { finalize: { code: 'b' } })],
      budget(),
    )
    expect(verdict).toEqual({ finalize: { code: 'a' }, sources: ['task:a'] })
  })

  it('merges hints in source order, removes duplicates and caps them at 1200 characters', () => {
    const a = 'a'.repeat(1000)
    const b = 'b'.repeat(1000)
    const verdict = decide(
      observation(),
      [
        op('task:c', hint(a)),
        op('environment:r', hint(a)),
        op('engine:x', hint(b)),
        op('engine:z', hint('late')),
      ],
      budget(),
    )
    expect(verdict).toEqual({
      continue: {
        interventions: [
          { hint: { text: a }, source: 'task:c' },
          { hint: { text: 'b'.repeat(200) }, source: 'engine:x' },
        ],
      },
      sources: ['task:c', 'environment:r', 'engine:x', 'engine:z'],
    })
  })

  it('keeps a source carried by the intervention itself', () => {
    const verdict = decide(
      observation(),
      [
        op('engine:a', {
          continue: {
            interventions: [{ hint: { text: 'h' }, source: 'engine:a/sub' } as never],
          },
        }),
      ],
      budget(),
    )
    expect(verdict).toEqual({
      continue: { interventions: [{ hint: { text: 'h' }, source: 'engine:a/sub' }] },
      sources: ['engine:a'],
    })
  })

  it('unions blocks by tool and input hash', () => {
    const block = (tool: string, inputHash: string): Opinion => ({
      continue: {
        interventions: [{ block: { tool, inputHash, code: 'repeat', reason: 'r' } }],
      },
    })
    const verdict = decide(
      observation(),
      [
        op('task:a', block('search', 'h1')),
        op('engine:b', block('search', 'h1')),
        op('engine:b', block('fetch', 'h2')),
      ],
      budget(),
    )
    expect(verdict).toMatchObject({
      continue: {
        interventions: [
          { block: { tool: 'search', inputHash: 'h1' }, source: 'task:a' },
          { block: { tool: 'fetch', inputHash: 'h2' }, source: 'engine:b' },
        ],
      },
    })
  })

  it.each<[string, Partial<BudgetState>, object]>([
    [
      'AC-014 finalizes when steps run out',
      { stepsLeft: 0 },
      { finalize: { code: 'max_steps' }, sources: ['guard:max_steps'] },
    ],
    [
      'AC-014 stops when steps run out on a structured deliverable',
      { stepsLeft: 0, structured: true },
      { stop: { code: 'max_steps', message: '步数已用完' }, sources: ['guard:max_steps'] },
    ],
    [
      'stops when tokens run out',
      { tokensExhausted: true },
      { stop: { code: 'budget', message: 'token 或费用已用完' }, sources: ['guard:budget'] },
    ],
    [
      'stops when cost runs out',
      { costExhausted: true },
      { stop: { code: 'budget', message: 'token 或费用已用完' }, sources: ['guard:budget'] },
    ],
    [
      'finalizes when the remaining time hits the reserve',
      { timeLeftMs: 120_000 },
      { finalize: { code: 'timeout' }, sources: ['guard:timeout'] },
    ],
    [
      'stops on timeout for a structured deliverable',
      { timeLeftMs: 0, structured: true },
      { stop: { code: 'timeout', message: '剩余时长不足' }, sources: ['guard:timeout'] },
    ],
  ])('%s', (_name, patch, expected) => {
    expect(decide(observation(), [], budget(patch))).toEqual(expected)
  })

  it('leaves non-continue verdicts alone when budgets run out', () => {
    const verdict = decide(observation({ isFinalCandidate: true }), [], budget({ stepsLeft: 0 }))
    expect(verdict).toEqual({ complete: true, sources: ['candidate'] })
  })

  it('turns a finalize into a stop on a structured deliverable', () => {
    const verdict = decide(
      observation(),
      [op('engine:no-new-info', { finalize: { code: 'stall' } })],
      budget({ structured: true }),
    )
    expect(verdict).toEqual({
      stop: { code: 'stall', message: 'finalize:stall 在结构化交付下改为停止' },
      sources: ['engine:no-new-info', 'guard:structured'],
    })
  })

  describe('with a steer that has not taken effect yet', () => {
    const steer = budget({ steerPending: true })
    const resumed = { continue: { interventions: [] }, sources: ['principal:steer'] }

    it.each<[string, Parameters<typeof decide>[0], SourcedOpinion[]]>([
      ['a final candidate', observation({ isFinalCandidate: true }), []],
      ['a guard that finalizes', observation(), [op('engine:g', { finalize: { code: 'stall' } })]],
      [
        'a guard that waits for input',
        observation(),
        [op('task:g', { awaitInput: { code: 'q' } })],
      ],
      [
        'an intent that stops',
        observation({ intent: { tool: 'report_blocked', kind: 'stop', code: 'blocked' } }),
        [],
      ],
    ])('continues instead of ending on %s', (_name, obs, opinions) => {
      expect(decide(obs, opinions, steer)).toEqual(resumed)
    })

    it('still stops for the engine and still ends when the budget is used up', () => {
      const guardStop = op('engine:g', { stop: { code: 'truncated', message: 'x' } })
      expect(decide(observation(), [guardStop], steer)).toMatchObject({
        stop: { code: 'truncated' },
      })
      expect(
        decide(
          observation({ isFinalCandidate: true }),
          [],
          budget({ steerPending: true, stepsLeft: 0 }),
        ),
      ).toEqual({ finalize: { code: 'max_steps' }, sources: ['guard:max_steps'] })
    })

    it('comes from the state', () => {
      const state = sequence([runStarted(), stepStarted(1), contextBuilt(1)]).reduce(
        apply,
        initial({ runId: 'r1' }),
      )
      const pending = apply(state, { t: 'steer_received', text: '改查上海', seq: 99, at: 1 })
      const opts = { now: 0, structured: false }
      expect(budgetState(state, opts).steerPending).toBe(false)
      expect(budgetState(pending, opts).steerPending).toBe(true)
    })
  })

  it('AC-015 stops on content filter before merging', () => {
    const verdict = decide(
      observation({ finishReason: 'content-filter' }),
      [op('task:r', { stop: { code: 'x', message: 'm' } })],
      budget(),
    )
    expect(verdict).toEqual({
      stop: { code: 'content_filter', message: '模型输出被内容过滤' },
      sources: ['guard:content_filter'],
    })
  })

  it.each<[string, 'complete' | 'await_input' | 'stop', object]>([
    ['complete', 'complete', { complete: true, sources: ['intent:finish'] }],
    [
      'await_input',
      'await_input',
      { awaitInput: { code: 'ask_user' }, sources: ['intent:finish'] },
    ],
    [
      'stop',
      'stop',
      { stop: { code: 'blocked', message: '意图 finish' }, sources: ['intent:finish'] },
    ],
  ])('turns an intent of kind %s into an opinion', (_name, kind, expected) => {
    const code = kind === 'await_input' ? 'ask_user' : kind === 'stop' ? 'blocked' : 'finish'
    const verdict = decide(observation({ intent: { tool: 'finish', kind, code } }), [], budget())
    expect(verdict).toEqual(expected)
  })
})

describe('budgetState', () => {
  it('derives remaining steps, time and exhaustion from the state', () => {
    const state = sequence([
      runStarted({
        task: {
          fingerprint: 't',
          content: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          budget: { maxSteps: 5, maxTotalMs: 10_000, maxInputTokens: 100, maxCost: 1 },
        },
      }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ]).reduce(apply, initial({ runId: 'r1' }))
    expect(
      budgetState(state, { now: 4_000, structured: true, price: { input: 1, output: 1 } }),
    ).toEqual({
      stepsLeft: 4,
      tokensExhausted: true,
      costExhausted: false,
      timeLeftMs: 7_000,
      finalizeReserveMs: 120_000,
      structured: true,
      steerPending: false,
    })
  })

  it('counts cached input toward maxInputTokens and the queue toward the time left', () => {
    const state = sequence([
      runStarted({
        task: {
          fingerprint: 't',
          content: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          budget: { maxTotalMs: 10_000, maxInputTokens: 100 },
        },
        queuedMs: 3_000,
      }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { usage: { input: 10, output: 0, cacheRead: 80, cacheWrite: 10 } }),
    ]).reduce(apply, initial({ runId: 'r1' }))
    // run_started 在 1_000，排队 3_000：运行从 -2_000 算起，截止 8_000。
    expect(budgetState(state, { now: 4_000, structured: false })).toMatchObject({
      tokensExhausted: true,
      timeLeftMs: 4_000,
    })
  })

  it('omits the time left when there is no total time budget', () => {
    const state = sequence([runStarted()]).reduce(apply, initial({ runId: 'r1' }))
    expect(budgetState(state, { now: 0, structured: false }).timeLeftMs).toBeUndefined()
  })
})
