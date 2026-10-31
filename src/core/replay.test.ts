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
} from './events.fixture.js'
import { strictReplay } from './replay.js'

const go = { continue: { interventions: [] }, sources: ['default'] }
const done = { complete: true as const, sources: ['default'] }

const complete = (): RunEvent[] =>
  sequence([
    runStarted(),
    { t: 'steer_received', text: '先看这个' },
    stepStarted(1),
    contextBuilt(1),
    modelResponded(1, { toolCalls: [call('c1')] }),
    toolFinished('c1'),
    evaluated(1, go),
    stepEnded(1),
    stepStarted(2),
    contextBuilt(2),
    modelResponded(2, { text: '答案' }),
    evaluated(2, done),
    stepEnded(2),
    deliveryChecked(2, 'delivered'),
    runEnded({ runId: 'r1', status: 'completed', steps: 2, toolCalls: 1 }),
  ])

describe('strictReplay', () => {
  it('AC-015 rebuilds state, result and projections from the log alone', () => {
    const replay = strictReplay(complete())
    expect(replay.violations).toEqual([])
    expect(replay.result).toMatchObject({ runId: 'r1', status: 'completed' })
    expect(replay.state).toMatchObject({ runId: 'r1', phase: 'ended', step: 2, toolCallCount: 1 })
    expect(replay.transcript.map((e) => e.origin)).toEqual(['steer', 'model', 'tool', 'model'])
    expect(replay.trace).toMatchObject({ kind: 'run', attrs: { status: 'completed' } })
    expect(replay).not.toHaveProperty('quality')
  })

  it('AC-015 accepts a run that failed admission', () => {
    expect(
      strictReplay(sequence([runEnded({ status: 'failed', code: 'invalid_agent' })])).violations,
    ).toEqual([])
  })

  it('AC-015 accepts a run ended from any stage', () => {
    const aborted = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      runEnded({ status: 'aborted', code: 'user' }),
    ])
    expect(strictReplay(aborted).violations).toEqual([])
  })

  it('AC-016 reports events that do not belong to the expected stage', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      toolFinished('c1'),
      modelResponded(1),
      evaluated(1, done),
      stepEnded(1),
      deliveryChecked(1, 'delivered'),
      runEnded(),
    ])
    expect(strictReplay(events).violations).toEqual(
      expect.arrayContaining([{ seq: 4, message: 'seq 4：tool_finished 不应出现在 reason 环节' }]),
    )
  })

  it('AC-016 reports a missing run_ended through the invariant check', () => {
    const { violations } = strictReplay(sequence([runStarted(), stepStarted(1), contextBuilt(1)]))
    expect(violations).toEqual([
      expect.objectContaining({ message: expect.stringContaining('run_ended') }),
    ])
  })

  it('AC-017 stops at an event the state machine rejects, without throwing', () => {
    const tampered = [...complete(), { ...complete()[1]!, seq: 16, at: 2000 }]
    const { violations, result } = strictReplay(tampered)
    expect(violations[0]).toEqual({
      seq: 16,
      message: 'seq 16：unreachable: event after run_ended',
    })
    expect(result).toMatchObject({ status: 'completed' })

    const broken = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      stepEnded(1),
    ])
    expect(strictReplay(broken).violations[0]).toMatchObject({ seq: 5 })
  })

  it('AC-016 reports a step_ended for a step that was never evaluated', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'x' }),
      evaluated(1, go),
      stepEnded(1),
      stepStarted(2),
      contextBuilt(2),
      modelResponded(2, { text: 'done' }),
      stepEnded(2),
      stepStarted(3),
      contextBuilt(3),
      modelResponded(3, { text: 'done' }),
      evaluated(3, done),
      stepEnded(3),
      deliveryChecked(3, 'delivered'),
      runEnded({ steps: 3 }),
    ])
    expect(strictReplay(events).violations[0]).toEqual({
      seq: 10,
      message: 'seq 10：unreachable: step_ended without evaluated',
    })
  })

  it('AC-016 reports a run_ended whose result disagrees with the outcome of the state machine', () => {
    const overflow = (patch: Parameters<typeof runEnded>[0]) =>
      strictReplay(
        sequence([runStarted(), stepStarted(1), contextBuilt(1, 20_000), runEnded(patch)]),
      ).violations
    expect(overflow({ status: 'completed' })).toEqual([
      {
        seq: 4,
        message: 'seq 4：run_ended 的结局 completed 与状态机的结局 stopped/context_overflow 不一致',
      },
    ])
    expect(overflow({ status: 'stopped' })).toHaveLength(1)
    expect(overflow({ status: 'stopped', code: 'context_overflow' })).toEqual([])
    // 自检失败时执行器改为 failed/engine_error。
    expect(overflow({ status: 'failed', code: 'engine_error' })).toEqual([])
  })

  it('AC-016 lets the abort reason decide the result of a cancelled model call', () => {
    const cancelled = (patch: Parameters<typeof runEnded>[0]) =>
      strictReplay(
        sequence([
          runStarted(),
          stepStarted(1),
          contextBuilt(1),
          { t: 'model_aborted', step: 1, partialText: '' },
          runEnded(patch),
        ]),
      ).violations
    expect(cancelled({ status: 'aborted', code: 'user' })).toEqual([])
    expect(cancelled({ status: 'stopped', code: 'timeout' })).toEqual([])
  })
})
