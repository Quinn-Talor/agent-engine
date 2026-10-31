import { describe, expect, it } from 'vitest'
import {
  contextBuilt,
  deliveryChecked,
  evaluated,
  modelResponded,
  opinionRecord,
  runStarted,
  sequence,
  stepEnded,
  stepStarted,
} from './events.fixture.js'
import { supervisionStats } from './supervision-stats.js'

const go = (...sources: string[]) => ({ continue: { interventions: [] }, sources })

describe('supervisionStats', () => {
  it('AC-034 counts warnings, ends, deferrals, steering, violations, advice, terminals and checks', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1),
      evaluated(1, go('engine:failure-streak', 'engine:no-new-info'), {}, [
        opinionRecord('engine:failure-streak', 'warn', { detail: '计数 2' }),
        opinionRecord('engine:no-new-info', 'warn', { deferred: true }),
        opinionRecord('engine:trial', 'finalize', { mode: 'shadow' }),
        { source: 'guard:pressure', mode: 'active', durationMs: 0 },
      ]),
      stepEnded(1),
      stepStarted(2),
      {
        t: 'intervention_applied',
        step: 2,
        intervention: { hint: { text: '[纠偏 · 第 1 步]' } },
        source: 'steering',
      },
      contextBuilt(2),
      modelResponded(2),
      {
        t: 'external_call',
        source: 'engine:advisor/supervision:advise',
        kind: 'model',
        request: 'sha256:a',
        response: 'sha256:b',
        usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
        startedAt: 0,
        durationMs: 1,
      },
      evaluated(
        2,
        go('engine:advisor'),
        {
          interventions: {
            applied: [{ kind: 'hint', source: 'steering' }],
            violated: [{ source: 'engine:roadblock', code: 'failure_streak' }],
          },
        },
        [opinionRecord('engine:advisor', 'warn')],
      ),
      stepEnded(2),
      stepStarted(3),
      contextBuilt(3),
      modelResponded(3),
      evaluated(
        3,
        { finalize: { code: 'failure_streak' }, sources: ['engine:failure-streak'] },
        {},
        [opinionRecord('engine:failure-streak', 'finalize')],
      ),
      stepEnded(3),
      { t: 'fallback_generated', code: 'failure_streak', text: 'partial', degradation: 0 },
      deliveryChecked(3, 'returned', {
        checks: [{ source: 'check:shadow', mode: 'shadow', pass: false }],
      }),
      deliveryChecked(3, 'delivered', { path: 'fallback' }),
    ])
    expect(supervisionStats(events)).toEqual({
      steps: 3,
      warns: { 'engine:failure-streak': 1, 'engine:no-new-info': 1, 'engine:advisor': 1 },
      ends: { 'engine:failure-streak': 1 },
      deferred: 1,
      steering: 1,
      effective: 2,
      blockViolations: 1,
      advice: { requested: 1, adopted: 1 },
      terminals: 1,
      checks: { returned: 1, delivered: 1, shadowFailures: 1 },
      usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('counts a violation, but not an intent or a budget guard, as a guard terminal', () => {
    const at = (step: number, sources: string[]) => [
      stepStarted(step),
      contextBuilt(step),
      modelResponded(step),
      evaluated(step, { stop: { code: 'x', message: 'm' }, sources }),
      stepEnded(step),
    ]
    const stats = (sources: string[]) =>
      supervisionStats(sequence([runStarted(), ...at(1, sources)])).terminals
    expect(stats(['guard:violation'])).toBe(1)
    expect(stats(['task:policy'])).toBe(1)
    expect(stats(['intent:report_blocked'])).toBe(0)
    expect(stats(['guard:max_steps'])).toBe(0)
  })

  it('recognizes advice calls recorded by the run context only', () => {
    const call = (source: string, kind: 'model' | 'record' = 'model') => ({
      t: 'external_call' as const,
      source,
      kind,
      request: 'sha256:a',
      response: 'sha256:b',
      startedAt: 0,
      durationMs: 1,
    })
    const events = sequence([
      runStarted(),
      call('engine:advisor/supervision:advise'),
      call('memory:compacting/memory:compaction'),
      call('engine:advisor/supervision:advise', 'record'),
    ])
    expect(supervisionStats(events).advice.requested).toBe(1)
  })

  it('is all zeros for no events', () => {
    expect(supervisionStats([])).toEqual({
      steps: 0,
      warns: {},
      ends: {},
      deferred: 0,
      steering: 0,
      effective: 0,
      blockViolations: 0,
      advice: { requested: 0, adopted: 0 },
      terminals: 0,
      checks: { returned: 0, delivered: 0, shadowFailures: 0 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })
})
