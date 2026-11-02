import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../contracts/events.js'
import {
  call,
  contextBuilt,
  deliveryChecked,
  evaluated,
  modelResponded,
  runEnded,
  runStarted,
  sequence,
  stepEnded,
  stepStarted,
  toolFinished,
  type EventBody,
} from './events.fixture.js'
import { apply, initial, nextStage, type RunState } from './state.js'

const fold = (bodies: EventBody[], from: RunState = initial({ runId: 'r1' })): RunState =>
  sequence(bodies).reduce(apply, from)

const continueVerdict = { continue: { interventions: [] }, sources: ['default'] }
const completeVerdict = { complete: true as const, sources: ['default'] }

describe('state machine', () => {
  it('starts at prepare', () => {
    expect(nextStage(initial({ runId: 'r1' }))).toBe('prepare')
  })

  it('starts the run clock at admission, counting the queue (§5.3)', () => {
    expect(fold([runStarted({ queuedMs: 250 })]).startedAt).toBe(750)
  })

  it('AC-005 walks prepare → compose → reason → act → evaluate → compose', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1'), call('c2')], finishReason: 'tool-calls' }),
      toolFinished('c1'),
      toolFinished('c2'),
      evaluated(1, continueVerdict),
      stepEnded(1),
    ])
    const stages: Array<string | null> = []
    let state = initial({ runId: 'r1' })
    for (const e of events) {
      state = apply(state, e)
      if (e.t === 'step_started' || e.t === 'evaluated') continue
      stages.push(nextStage(state))
    }
    expect(stages).toEqual(['compose', 'reason', 'act', 'act', 'evaluate', 'compose'])
    expect(state.toolCallCount).toBe(2)
    expect(state.transcript.map((e) => e.origin)).toEqual(['model', 'tool'])
  })

  it('AC-006 goes straight to evaluate when the model calls no tools', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'hi' }),
    ])
    expect(nextStage(state)).toBe('evaluate')
  })

  it('AC-007 stops on context overflow', () => {
    const state = fold([runStarted({ contextLimit: 1000 }), stepStarted(1), contextBuilt(1, 1000)])
    expect(nextStage(state)).toBe('end')
    expect(state.outcome).toEqual({ status: 'stopped', code: 'context_overflow' })
  })

  it.each<[string, string, object]>([
    [
      'AC-008 classifies model errors as model_error',
      'RATE_LIMITED',
      {
        status: 'failed',
        code: 'model_error',
        error: { code: 'RATE_LIMITED', message: 'boom', retryable: true },
      },
    ],
    [
      'AC-008 treats CONTEXT_TOO_LONG as context_overflow',
      'CONTEXT_TOO_LONG',
      { status: 'stopped', code: 'context_overflow' },
    ],
  ])('%s', (_name, code, outcome) => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      {
        t: 'model_failed',
        step: 1,
        startedAt: 0,
        error: { code: code as never, message: 'boom', retryable: true, attempts: [] },
      },
    ])
    expect(state.outcome).toEqual(outcome)
    expect(nextStage(state)).toBe('end')
  })

  it('marks an aborted model call', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      { t: 'model_aborted', step: 1, partialText: 'par' },
    ])
    expect(state.outcome).toEqual({ status: 'aborted' })
  })

  it('AC-009 appends hints before the merged steer', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'thinking' }),
      { t: 'steer_received', text: 'a' },
      evaluated(1, {
        continue: { interventions: [{ hint: { text: 'try again' } }] },
        sources: ['rule:x'],
      }),
      { t: 'steer_received', text: 'b' },
      stepEnded(1),
      stepStarted(2),
      {
        t: 'intervention_applied',
        step: 2,
        intervention: { hint: { text: 'try again' } },
        source: 'rule:x',
      },
      contextBuilt(2),
    ])
    expect(state.transcript.slice(-2)).toEqual([
      { origin: 'hint', step: 2, source: 'rule:x', text: 'try again' },
      { origin: 'steer', step: 2, text: 'a\n\nb' },
    ])
    expect(state.pendingSteers).toEqual([])
  })

  it('carries continue interventions to the next step with their source', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      evaluated(1, {
        continue: { interventions: [{ hint: { text: 'h' } }] },
        sources: ['corrector'],
      }),
      stepEnded(1),
    ])
    expect(state.pendingInterventions).toEqual([{ hint: { text: 'h' }, source: 'corrector' }])
  })

  it('AC-010 returns to compose with the delivery hint, then completes', () => {
    const base = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'answer' }),
      evaluated(1, completeVerdict, { isFinalCandidate: true }),
      stepEnded(1),
    ])
    expect(nextStage(base)).toBe('deliver')
    const returned = apply(base, {
      ...deliveryChecked(1, 'returned', { hint: 'fix' }),
      seq: 7,
      at: 2_000,
    })
    expect(nextStage(returned)).toBe('compose')
    expect(returned.pendingInterventions).toEqual([{ hint: { text: 'fix' }, source: 'delivery' }])

    const after = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'answer' }),
      evaluated(1, completeVerdict, { isFinalCandidate: true }),
      stepEnded(1),
      deliveryChecked(1, 'returned', { hint: 'fix' }),
      stepStarted(2),
      contextBuilt(2),
      modelResponded(2, { text: 'fixed' }),
      evaluated(2, completeVerdict, { isFinalCandidate: true }),
      stepEnded(2),
      deliveryChecked(2, 'delivered'),
    ]).reduce(apply, initial({ runId: 'r1' }))
    expect(after.outcome).toEqual({ status: 'completed' })
    expect(after.candidate?.text).toBe('fixed')
    expect(nextStage(after)).toBe('end')
  })

  it('completes with the intent code when the candidate used a complete intent', () => {
    const state = fold([
      runStarted({
        capabilities: [
          {
            capability: 'intents',
            kind: 'intents',
            version: '1',
            fingerprint: 'fp',
            tools: [
              { name: 'finish', schemaHash: 'h', intent: { kind: 'complete', code: 'finish' } },
            ],
          },
        ],
      }),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'finish', { summary: 'done' })] }),
      toolFinished('c1', { capability: 'intents' }),
      evaluated(1, completeVerdict, {
        intent: { tool: 'finish', kind: 'complete', code: 'finish' },
        isFinalCandidate: true,
      }),
      stepEnded(1),
      deliveryChecked(1, 'delivered'),
    ])
    expect(state.outcome).toEqual({ status: 'completed', code: 'finish' })
    expect(state.candidate?.intent).toEqual({
      tool: 'finish',
      kind: 'complete',
      code: 'finish',
      input: { summary: 'done' },
    })
    expect(state.tools.finish).toMatchObject({ capability: 'intents', effect: 'side_effect' })
  })

  it('finalizes through the fallback path with the fallback code', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'stuck' }),
      evaluated(1, { finalize: { code: 'repeat' }, sources: ['corrector'] }),
      stepEnded(1),
      { t: 'fallback_generated', code: 'repeat', text: 'progress so far', degradation: 0 },
      deliveryChecked(1, 'delivered', { path: 'fallback' }),
    ])
    expect(state.outcome).toEqual({ status: 'finalized', code: 'repeat' })
    expect(state.fallbackText).toBe('progress so far')
  })

  it('switches to the fallback path and fails structured delivery beyond repairs', () => {
    const base = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: '' }),
      evaluated(1, completeVerdict, { isFinalCandidate: true }),
      stepEnded(1),
    ])
    const switched = apply(base, { ...deliveryChecked(1, 'fallback'), seq: 7, at: 2_000 })
    expect(switched.deliveryPath).toBe('fallback')
    expect(switched.fallbackCode).toBe('empty_output')
    expect(nextStage(switched)).toBe('deliver')
    const failed = apply(base, { ...deliveryChecked(1, 'failed'), seq: 7, at: 2_000 })
    expect(failed.outcome).toEqual({ status: 'failed', code: 'output_invalid' })
  })

  it.each<[string, object, object]>([
    [
      'awaiting input',
      { awaitInput: { code: 'ask_user' } },
      { status: 'awaiting_input', code: 'ask_user' },
    ],
    [
      'stop',
      { stop: { code: 'blocked', message: 'cannot proceed' } },
      { status: 'stopped', code: 'blocked', message: 'cannot proceed' },
    ],
  ])('ends on %s', (_name, verdict, outcome) => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      evaluated(1, { ...verdict, sources: ['x'] } as never),
      stepEnded(1),
    ])
    expect(state.outcome).toEqual(outcome)
    expect(nextStage(state)).toBe('end')
  })

  it('AC-027 keeps a call block until the run ends and clears all blocks when a steer takes effect', () => {
    const block = {
      tool: 'search',
      inputHash: 'h1',
      code: 'failure_streak',
      reason: '已失败 2 次（TOOL_TIMEOUT）',
    }
    let state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      evaluated(1, continueVerdict),
      stepEnded(1),
      stepStarted(2),
      { t: 'intervention_applied', step: 2, intervention: { block }, source: 'engine:roadblock' },
      contextBuilt(2),
    ])
    expect(state.blocks).toEqual([
      { ...block, source: 'engine:roadblock', since: 2, until: Infinity },
    ])
    for (const step of [3, 4, 5, 6]) {
      state = fold(
        [
          modelResponded(step - 1),
          evaluated(step - 1, continueVerdict),
          stepEnded(step - 1),
          stepStarted(step),
          contextBuilt(step),
        ],
        state,
      )
    }
    expect(state.blocks).toHaveLength(1)
    state = fold(
      [
        modelResponded(6),
        evaluated(6, continueVerdict),
        stepEnded(6),
        { t: 'steer_received', text: '换个方向' },
        stepStarted(7),
        { t: 'intervention_applied', step: 7, intervention: { block }, source: 'engine:x' },
      ],
      state,
    )
    expect(state.blocks).toHaveLength(2)
    state = fold([contextBuilt(7)], state)
    expect(state.blocks).toEqual([])
    expect(state.transcript.at(-1)).toEqual({ origin: 'steer', step: 7, text: '换个方向' })
  })

  it('F25 AC-004 lifts blocks that depend on the environment once a write succeeds', () => {
    const lifted = {
      tool: 'run',
      inputHash: 'h1',
      code: 'failure_streak',
      reason: 'r',
      clearOnChange: true as const,
    }
    const kept = { tool: 'send', inputHash: 'h2', code: 'repeat', reason: 'r' }
    let state = fold([
      runStarted(),
      stepStarted(1),
      {
        t: 'intervention_applied',
        step: 1,
        intervention: { block: lifted },
        source: 'engine:roadblock',
      },
      {
        t: 'intervention_applied',
        step: 1,
        intervention: { block: kept },
        source: 'engine:roadblock',
      },
    ])
    state = fold(
      [
        toolFinished('c1', { effect: 'side_effect', isError: true }),
        toolFinished('c2', { effect: 'none' }),
      ],
      state,
    )
    expect(state.blocks.map((b) => b.tool)).toEqual(['run', 'send'])
    state = fold([toolFinished('c3', { effect: 'side_effect' })], state)
    expect(state.blocks.map((b) => b.tool)).toEqual(['send'])
  })

  it('keeps provider data of tool calls in the transcript so it can be replayed', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, {
        toolCalls: [{ ...call('c1'), providerData: { google: { thoughtSignature: 'sig' } } }],
      }),
    ])
    const entry = state.transcript.at(-1)
    expect(entry?.origin === 'model' && entry.message.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'search',
        input: { q: 'c1' },
        providerData: { google: { thoughtSignature: 'sig' } },
      },
    ])
  })

  it('accumulates usage by bucket and records hook notices before run_started', () => {
    const state = fold([
      {
        t: 'external_call',
        source: 'notice:org',
        kind: 'record',
        request: 'sha256:a',
        response: 'sha256:b',
        startedAt: 0,
        durationMs: 1,
      },
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      {
        t: 'external_call',
        source: 'memory:compaction',
        kind: 'model',
        request: 'sha256:c',
        response: 'sha256:d',
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
        startedAt: 0,
        durationMs: 1,
      },
      {
        t: 'external_call',
        source: 'supervision:diagnose',
        kind: 'model',
        request: 'sha256:e',
        response: 'sha256:f',
        usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 },
        startedAt: 0,
        durationMs: 1,
      },
    ])
    expect(state.transcript[0]).toEqual({
      origin: 'hook',
      source: 'notice:org',
      content: 'sha256:b',
    })
    expect(state.usage.main.input).toBe(100)
    expect(state.usage.memory.input).toBe(10)
    expect(state.usage.supervision.input).toBe(20)
    expect(state.usage.input).toBe(130)
  })

  it('applies run_ended and rejects later events', () => {
    const events: RunEvent[] = sequence([runEnded({ status: 'failed', code: 'admission_timeout' })])
    const state = apply(initial({ runId: 'r1' }), events[0]!)
    expect(nextStage(state)).toBeNull()
    expect(() => apply(state, { ...events[0]!, seq: 2 })).toThrow(
      'unreachable: event after run_ended',
    )
  })

  it('rejects impossible phases', () => {
    expect(() => nextStage(fold([runStarted(), stepStarted(1)]))).toThrow('unreachable')
  })

  it('AC-015 (F6) keeps the latest observation', () => {
    const second = evaluated(2, continueVerdict, { text: 'second step' })
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      evaluated(1, continueVerdict),
      stepEnded(1),
      stepStarted(2),
      contextBuilt(2),
      modelResponded(2),
      second,
    ])
    expect(state.observation).toEqual(second.observation)
  })

  it('does not mutate the previous state', () => {
    const before = fold([runStarted()])
    const snapshot = JSON.stringify(before)
    apply(before, { ...stepStarted(1), seq: 2, at: 2_000 })
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('AC-018 calibrates the estimator against all input tokens, cached ones included', () => {
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1, 1000),
      modelResponded(1, { usage: { input: 200, output: 5, cacheRead: 700, cacheWrite: 100 } }),
    ])
    expect(state.calibration).toBeCloseTo(1)
  })
})
