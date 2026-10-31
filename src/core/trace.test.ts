import { describe, expect, it } from 'vitest'
import {
  call,
  contextBuilt,
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

  it('returns undefined for no events', () => {
    expect(buildTrace([])).toBeUndefined()
  })
})
