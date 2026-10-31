import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../contracts/events.js'
import {
  call,
  contextBuilt,
  deliveryChecked,
  evaluated,
  modelResponded,
  opinionRecord,
  runEnded,
  runStarted,
  sequence,
  stepEnded,
  stepStarted,
  toolFinished,
  type EventBody,
} from './events.fixture.js'
import { checkInvariants } from './invariants.js'

const completeVerdict = { complete: true as const, sources: ['default'] }

const completeRun = (): EventBody[] => [
  { t: 'steer_received', text: 'early' },
  runStarted(),
  stepStarted(1),
  contextBuilt(1),
  modelResponded(1, { toolCalls: [call('c1'), call('c2')] }),
  { t: 'permission_decided', callId: 'c1', verdict: 'allow', source: 'sandbox' },
  toolFinished('c1'),
  toolFinished('c2'),
  evaluated(1, { continue: { interventions: [] }, sources: ['default'] }),
  stepEnded(1),
  stepStarted(2),
  contextBuilt(2),
  modelResponded(2, { text: 'done' }),
  evaluated(2, completeVerdict),
  stepEnded(2),
  deliveryChecked(2, 'delivered', {
    checks: [{ source: 'grounding', mode: 'annotate', pass: true }],
  }),
  runEnded(),
]

const kinds = (events: RunEvent[]) => checkInvariants(events).map((v) => v.invariant)

describe('checkInvariants', () => {
  it('accepts a complete run', () => {
    expect(checkInvariants(sequence(completeRun()))).toEqual([])
  })

  it('accepts a run that failed at admission', () => {
    expect(
      checkInvariants(sequence([runEnded({ status: 'failed', code: 'admission_timeout' })])),
    ).toEqual([])
  })

  it('AC-016 reports a missing tool result and a seq gap', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('call-1')] }),
      evaluated(1, { continue: { interventions: [] }, sources: ['default'] }),
      stepEnded(1),
      runEnded(),
    ])
    const gapped = events.map((e, i) => (i >= 2 ? { ...e, seq: e.seq + 1 } : e))
    const violations = checkInvariants(gapped)
    expect(violations.map((v) => v.invariant)).toEqual(['I13', 'I2'])
    expect(violations[0]!.message).toContain('3')
    expect(violations[0]!.seq).toBe(4)
    expect(violations[1]!.message).toContain('call-1')
  })

  it('reports a duplicated tool result as I15 and an unknown one as I2', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1')] }),
      toolFinished('c1'),
      toolFinished('c1'),
      toolFinished('ghost'),
      evaluated(1, completeVerdict),
      stepEnded(1),
      runEnded(),
    ])
    expect(kinds(events)).toEqual(['I15', 'I2'])
  })

  it('pairs tool calls per step, so a provider may reuse ids across steps', () => {
    const go = { continue: { interventions: [] }, sources: ['default'] }
    const step = (n: number): EventBody[] => [
      stepStarted(n),
      contextBuilt(n),
      modelResponded(n, { toolCalls: [call('call_0')] }),
      toolFinished('call_0'),
      evaluated(n, go),
      stepEnded(n),
    ]
    const events = sequence([
      runStarted(),
      ...step(1),
      ...step(2),
      stepStarted(3),
      contextBuilt(3),
      modelResponded(3, { text: 'done' }),
      evaluated(3, completeVerdict),
      stepEnded(3),
      deliveryChecked(3, 'delivered'),
      runEnded(),
    ])
    expect(checkInvariants(events)).toEqual([])
  })

  it('reports a result for a call from an earlier step as unpaired', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1')] }),
      toolFinished('c1'),
      evaluated(1, { continue: { interventions: [] }, sources: ['default'] }),
      stepEnded(1),
      stepStarted(2),
      contextBuilt(2),
      modelResponded(2, { text: 'done' }),
      toolFinished('c1'),
      evaluated(2, completeVerdict),
      stepEnded(2),
      runEnded(),
    ])
    expect(kinds(events)).toEqual(['I2'])
  })

  it('reports time going backwards', () => {
    const events = sequence(completeRun())
    events[3] = { ...events[3]!, at: 0 }
    expect(kinds(events)).toContain('I13')
  })

  it('reports events before run_started other than notices and steers, and a second run_started', () => {
    const events = sequence([stepStarted(1), runStarted(), runStarted(), runEnded()])
    expect(kinds(events)).toEqual(['I14', 'I14'])
  })

  it('reports verdicts and checks without a source', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'x', toolCalls: [call('c1')] }),
      { t: 'permission_decided', callId: 'c1', verdict: 'allow', source: '' },
      toolFinished('c1'),
      evaluated(1, { complete: true, sources: [] }),
      stepEnded(1),
      deliveryChecked(1, 'delivered', { checks: [{ source: '', mode: 'gate', pass: true }] }),
      runEnded(),
    ])
    expect(kinds(events)).toEqual(['I11', 'I11', 'I11'])
  })

  it('reports a missing run_ended, a missing step_ended and non-consecutive steps', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      stepStarted(3),
      contextBuilt(3),
    ])
    expect(kinds(events)).toEqual(['trace', 'trace', 'trace'])
  })

  it('accepts a run that ended inside a step', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1, 99_999),
      runEnded({ status: 'stopped', code: 'context_overflow' }),
    ])
    expect(checkInvariants(events)).toEqual([])
  })

  describe('I16 warn before end', () => {
    const go = (...sources: string[]) => ({ continue: { interventions: [] }, sources })
    const step = (
      n: number,
      verdict: Parameters<typeof evaluated>[1],
      opinions: Parameters<typeof evaluated>[3] = [],
      steered = false,
    ): EventBody[] => [
      stepStarted(n),
      contextBuilt(n),
      modelResponded(n, { toolCalls: [call(`c${n}`)] }),
      toolFinished(`c${n}`),
      evaluated(
        n,
        verdict,
        steered
          ? { interventions: { applied: [{ kind: 'steer', source: 'principal' }], violated: [] } }
          : {},
        opinions,
      ),
      stepEnded(n),
    ]
    const finalize = (source: string) => ({ finalize: { code: 'stall' }, sources: [source] })
    const ended = (...steps: EventBody[][]) =>
      sequence([runStarted(), ...steps.flat(), runEnded({ status: 'finalized', code: 'stall' })])

    it('AC-045 accepts an end after a warning from the same guard', () => {
      const events = ended(
        step(1, go('engine:no-new-info'), [opinionRecord('engine:no-new-info', 'warn')]),
        step(2, finalize('engine:no-new-info'), [opinionRecord('engine:no-new-info', 'finalize')]),
      )
      expect(checkInvariants(events)).toEqual([])
    })

    it('AC-045 reports a guard end without an earlier warning', () => {
      const events = ended(
        step(1, go('engine:a'), [opinionRecord('engine:a', 'warn')]),
        step(2, finalize('engine:b'), [opinionRecord('engine:b', 'finalize')]),
      )
      expect(checkInvariants(events)).toEqual([
        { invariant: 'I16', message: '第 2 步：engine:b 终止前没有告知', seq: 12 },
      ])
    })

    it('AC-045 forgets warnings when a steer takes effect, and ignores warnings from the same step', () => {
      const afterSteer = ended(
        step(1, go('task:t'), [opinionRecord('task:t', 'warn')]),
        step(2, finalize('task:t'), [opinionRecord('task:t', 'finalize')], true),
      )
      expect(kinds(afterSteer)).toEqual(['I16'])
      const sameStep = ended(step(1, finalize('task:t'), [opinionRecord('task:t', 'warn')]))
      expect(kinds(sameStep)).toEqual(['I16'])
    })

    it('ignores core guards, intents, shadow warnings and guard errors', () => {
      const events = ended(
        step(1, go('engine:x'), [opinionRecord('engine:x', 'warn', { mode: 'shadow' })]),
        step(2, finalize('guard:violation')),
        step(3, finalize('guard:max_steps')),
        step(4, { stop: { code: 'blocked', message: 'm' }, sources: ['intent:report_blocked'] }),
        step(5, {
          stop: { code: 'guard_error:policy', message: 'm' },
          sources: ['environment:policy'],
        }),
      )
      expect(checkInvariants(events)).toEqual([])
      const shadowOnly = ended(
        step(1, go('engine:x'), [opinionRecord('engine:x', 'warn', { mode: 'shadow' })]),
        step(2, finalize('engine:x'), [opinionRecord('engine:x', 'finalize')]),
      )
      expect(kinds(shadowOnly)).toEqual(['I16'])
    })
  })
})
