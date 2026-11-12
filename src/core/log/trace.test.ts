import { describe, expect, it } from 'vitest'
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
import { buildTrace } from './trace.js'

const continueVerdict = { continue: { interventions: [] }, sources: ['default'] }

const session = (id: string, turn: number) => ({
  id,
  turn,
  window: { version: 1, turnStarts: [], ledger: [], tokens: 0 },
})

describe('buildTrace', () => {
  it('AC-008 builds run → step → model / tool / external / opinion nodes with timings', () => {
    const events = sequence([
      runStarted({ queuedMs: 7 }),
      stepStarted(1),
      contextBuilt(1),
      {
        ...modelResponded(1, { toolCalls: [call('c1', 'search')] }),
        startedAt: 1_025,
        firstTokenAt: 1_027,
      },
      { t: 'approval_answered', callId: 'c1', approved: true, waitedMs: 300 },
      toolFinished('c1', { startedAt: 1_040, durationMs: 5, childRunId: 'child-1' }),
      {
        t: 'external_call',
        source: 'engine:advisor/supervision:advise',
        kind: 'model',
        request: 'sha256:a',
        response: 'sha256:b',
        startedAt: 1_055,
        durationMs: 3,
      },
      {
        ...evaluated(1, continueVerdict),
        opinions: [{ source: 'task:r', mode: 'active', durationMs: 4 }],
      },
      stepEnded(1),
      stepStarted(2),
      contextBuilt(2),
      { ...modelResponded(2, { text: 'done' }), startedAt: 1_105 },
      evaluated(2, { complete: true, sources: ['default'] }),
      stepEnded(2),
      runEnded({ status: 'completed' }),
    ])
    const trace = buildTrace(events)!
    expect(trace).toMatchObject({
      kind: 'run',
      startedAt: 1_000,
      durationMs: 140,
      attrs: { queuedMs: 7, status: 'completed' },
    })
    expect(trace.children.map((c) => [c.kind, c.name, c.startedAt, c.durationMs])).toEqual([
      ['step', 'step 1', 1_010, 70],
      ['step', 'step 2', 1_090, 40],
    ])
    const step1 = trace.children[0]!
    expect(step1.children.map((c) => [c.kind, c.name, c.startedAt, c.durationMs])).toEqual([
      ['model', 'model', 1_025, 5],
      ['tool', 'search', 1_040, 5],
      ['external', 'engine:advisor/supervision:advise', 1_055, 3],
      ['opinion', 'task:r', 1_066, 4],
    ])
    expect(step1.children[0]!.attrs).toMatchObject({ firstTokenAt: 1_027, finishReason: 'stop' })
    expect(step1.children[1]!.attrs).toMatchObject({
      callId: 'c1',
      capability: 'tools',
      isError: false,
      childRunId: 'child-1',
      waitedMs: 300,
    })
    expect(step1.children[2]!.attrs).toMatchObject({ kind: 'model' })
  })

  it('closes a step that ended with the run and records failed model calls', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      {
        t: 'model_failed',
        step: 1,
        startedAt: 1_025,
        error: { code: 'MODEL_ERROR', message: 'x', retryable: false, attempts: [] },
      },
      runEnded({ status: 'failed', code: 'model_error' }),
    ])
    const trace = buildTrace(events)!
    expect(trace.children[0]!.durationMs).toBe(30)
    expect(trace.children[0]!.children[0]).toMatchObject({
      kind: 'model',
      startedAt: 1_025,
      durationMs: 5,
      attrs: { error: 'MODEL_ERROR' },
    })
    expect(trace.attrs).toMatchObject({ status: 'failed', code: 'model_error' })
  })

  it('puts external calls before the first step under the run and leaves an unfinished run open', () => {
    const events = sequence([
      {
        t: 'external_call',
        source: 'notice:org',
        kind: 'record',
        request: 'sha256:a',
        response: 'sha256:b',
        startedAt: 995,
        durationMs: 2,
      },
      runStarted(),
    ])
    const trace = buildTrace(events)!
    expect(trace.startedAt).toBe(1_010)
    expect(trace.durationMs).toBeUndefined()
    expect(trace.children.map((c) => c.kind)).toEqual(['external'])
  })

  it('AC-014 carries the model, agent and model usage', () => {
    const trace = buildTrace(
      sequence([
        runStarted({ model: 'fake:big', agent: { id: 'helper', fingerprint: 'fp' } }),
        stepStarted(1),
        modelResponded(1, { usage: { input: 12, output: 3, cacheRead: 1, cacheWrite: 0 } }),
      ]),
    )!
    expect(trace.attrs).toMatchObject({ model: 'fake:big', agentId: 'helper' })
    expect(trace.children[0]!.children[0]!.attrs).toMatchObject({
      usage: { input: 12, output: 3, cacheRead: 1, cacheWrite: 0 },
    })
  })

  it('gives each further child run of a call its own link node under the tool', () => {
    const trace = buildTrace(
      sequence([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { toolCalls: [call('c1', 'fan_out')] }),
        toolFinished('c1', { childRunId: 'child-b', childRunIds: ['child-a', 'child-b'] }),
      ]),
    )!
    const tool = trace.children[0]!.children.find((c) => c.kind === 'tool')!
    expect(tool.attrs.childRunId).toBe('child-b')
    expect(tool.children.map((c) => [c.kind, c.name, c.attrs.childRunId])).toEqual([
      ['tool', 'fan_out', 'child-a'],
    ])
  })

  it('AC-001 puts the session id and turn on the root of a session turn only', () => {
    const turn = buildTrace(sequence([runStarted({ session: session('s1', 3) }), stepStarted(1)]))!
    expect(turn.attrs).toMatchObject({ session: 's1', turn: 3 })
    const plain = buildTrace(sequence([runStarted(), stepStarted(1)]))!
    expect(plain.attrs).not.toHaveProperty('session')
    expect(plain.attrs).not.toHaveProperty('turn')
  })

  it('AC-002 adds a check node for the output and each check of every delivery attempt', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      modelResponded(1, { text: 'draft' }),
      stepEnded(1),
      deliveryChecked(1, 'returned', {
        output: { ok: true },
        checks: [
          { source: 'completion', mode: 'gate', pass: false, issues: ['missing x', 'missing y'] },
          { source: 'grounding', mode: 'shadow', pass: false, issues: ['unsupported'] },
        ],
        hint: 'fix it',
      }),
      stepStarted(2),
      modelResponded(2, { text: 'final' }),
      stepEnded(2),
      deliveryChecked(2, 'delivered', {
        attempt: 2,
        checks: [
          { source: 'completion', mode: 'gate', pass: true },
          { source: 'grounding', mode: 'shadow', pass: true },
        ],
      }),
      runEnded(),
    ])
    const trace = buildTrace(events)!
    const checks = trace.children.filter((c) => c.kind === 'check')
    expect(checks.map((c) => [c.name, c.durationMs, c.attrs])).toEqual([
      [
        'output',
        0,
        { pass: true, mode: 'gate', attempt: 1, path: 'normal', outcome: 'returned', issues: 0 },
      ],
      [
        'completion',
        0,
        { pass: false, mode: 'gate', attempt: 1, path: 'normal', outcome: 'returned', issues: 2 },
      ],
      [
        'grounding',
        0,
        { pass: false, mode: 'shadow', attempt: 1, path: 'normal', outcome: 'returned', issues: 1 },
      ],
      [
        'output',
        0,
        { pass: true, mode: 'gate', attempt: 2, path: 'normal', outcome: 'delivered', issues: 0 },
      ],
      [
        'completion',
        0,
        { pass: true, mode: 'gate', attempt: 2, path: 'normal', outcome: 'delivered', issues: 0 },
      ],
      [
        'grounding',
        0,
        { pass: true, mode: 'shadow', attempt: 2, path: 'normal', outcome: 'delivered', issues: 0 },
      ],
    ])
    const attempts = events.filter((e) => e.t === 'delivery_checked').map((e) => e.at)
    expect(checks.map((c) => c.startedAt)).toEqual([
      ...Array(3).fill(attempts[0]),
      ...Array(3).fill(attempts[1]),
    ])
    for (const c of checks) {
      expect(c.attrs).not.toHaveProperty('isError')
      expect(c.attrs).not.toHaveProperty('error')
    }
  })

  it('counts output issues and adds no check node when nothing was delivered', () => {
    const failed = buildTrace(
      sequence([
        runStarted(),
        deliveryChecked(1, 'returned', { output: { ok: false, issues: ['not json'] } }),
      ]),
    )!
    expect(failed.children.map((c) => [c.kind, c.name, c.attrs.pass, c.attrs.issues])).toEqual([
      ['check', 'output', false, 1],
    ])
    const none = buildTrace(sequence([runStarted(), stepStarted(1), stepEnded(1), runEnded()]))!
    expect(none.children.some((c) => c.kind === 'check')).toBe(false)
  })

  it('returns undefined for no events', () => {
    expect(buildTrace([])).toBeUndefined()
  })
})
