import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../contracts/events.js'
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
  usage,
} from './events.fixture.js'
import { retrospective } from './retrospective.js'

const go = { continue: { interventions: [] }, sources: ['default'] }

const attempts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ startedAt: i * 100, durationMs: 50 }))

const scenario = (): RunEvent[] =>
  sequence([
    runStarted({ rootRunId: 'r1' }),
    stepStarted(1),
    contextBuilt(1),
    modelResponded(1, {
      toolCalls: [
        call('c1', 'search'),
        call('c2', 'search'),
        call('c3', 'write', { path: 'a.txt' }),
      ],
      usage: usage(100, 10),
    }),
    toolFinished('c1'),
    toolFinished('c2', { isError: true, errorCode: 'TOOL_TIMEOUT' }),
    toolFinished('c3', { effect: 'side_effect', childRunId: 'child-1' }),
    evaluated(1, go, {}, [
      opinionRecord('engine:roadblock', 'warn', { detail: 'search: 连续 2 次返回相同结果' }),
      opinionRecord('engine:no-new-info', 'warn', { deferred: true }),
      opinionRecord('engine:trial', 'stop', { mode: 'shadow' }),
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
    {
      t: 'intervention_applied',
      step: 2,
      intervention: { block: { tool: 'search', inputHash: 'h', code: 'repeat', reason: 'x' } },
      source: 'engine:roadblock',
    },
    contextBuilt(2),
    modelResponded(2, { text: '答案', usage: usage(50, 5) }),
    evaluated(2, { complete: true, sources: ['candidate'] }, {}, [
      opinionRecord('task:policy', 'awaitInput'),
      opinionRecord('engine:failure-streak', 'finalize', { detail: '计数 3' }),
    ]),
    stepEnded(2),
    deliveryChecked(2, 'returned', {
      output: { ok: true },
      checks: [{ source: 'check:grounding', mode: 'gate', pass: false, issues: ['引文无法核实'] }],
    }),
    stepStarted(3),
    contextBuilt(3),
    modelResponded(3, { text: '修正后的答案' }),
    evaluated(3, { complete: true, sources: ['candidate'] }),
    stepEnded(3),
    deliveryChecked(3, 'delivered'),
    runEnded({ status: 'completed', toolCalls: 3 }),
  ])

describe('retrospective', () => {
  it('AC-035 projects signals, steps, deliveries, side effects, children, usage and duration', () => {
    const events = scenario()
    const retro = retrospective(events)
    expect(retro.runId).toBe('r1')
    expect(retro.end).toEqual({ status: 'completed' })
    expect(retro.timeline).toEqual([
      {
        step: 1,
        kind: 'signal',
        source: 'engine:roadblock',
        signal: 'warn',
        detail: 'search: 连续 2 次返回相同结果',
      },
      { step: 1, kind: 'signal', source: 'engine:no-new-info', signal: 'warn', deferred: true },
      { step: 2, kind: 'intervention', intervention: 'hint', source: 'steering' },
      { step: 2, kind: 'intervention', intervention: 'block', source: 'engine:roadblock' },
      { step: 2, kind: 'signal', source: 'task:policy', signal: 'awaitInput' },
      {
        step: 2,
        kind: 'signal',
        source: 'engine:failure-streak',
        signal: 'end',
        detail: '计数 3',
      },
    ])
    expect(retro.steps).toEqual([
      {
        step: 1,
        attempts: 1,
        tools: [
          { name: 'search', ok: true },
          { name: 'search', ok: false, errorCode: 'TOOL_TIMEOUT' },
          { name: 'write', ok: true },
        ],
      },
      { step: 2, attempts: 1, tools: [] },
      { step: 3, attempts: 1, tools: [] },
    ])
    expect(retro.deliveries).toEqual([
      {
        step: 2,
        path: 'normal',
        attempt: 1,
        outcome: 'returned',
        issues: ['引文无法核实'],
        checks: [
          { source: 'output', mode: 'gate', pass: true },
          { source: 'check:grounding', mode: 'gate', pass: false },
        ],
      },
      {
        step: 3,
        path: 'normal',
        attempt: 1,
        outcome: 'delivered',
        issues: [],
        checks: [{ source: 'output', mode: 'gate', pass: true }],
      },
    ])
    expect(retro.queuedMs).toBe(0)
    expect(retro.sideEffects).toEqual([
      expect.objectContaining({ toolName: 'write', input: { path: 'a.txt' }, status: 'executed' }),
    ])
    expect(retro.children).toEqual([{ callId: 'c3', childRunId: 'child-1', ok: true }])
    // 第 3 步的回复使用测试数据的默认用量 100 / 10。
    expect(retro.usage.main).toEqual(usage(250, 25))
    expect(retro.toolCalls).toBe(3)
    expect(retro.durationMs).toBe(events.at(-1)!.at - events[0]!.at)
  })

  it('pairs tool results per step when the provider reuses call ids', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('call_0', 'search')] }),
      toolFinished('call_0'),
      evaluated(1, go),
      stepEnded(1),
      stepStarted(2),
      contextBuilt(2),
      modelResponded(2, { toolCalls: [call('call_0', 'fetch')] }),
      toolFinished('call_0', { isError: true, errorCode: 'TOOL_TIMEOUT' }),
    ])
    const retro = retrospective(events)
    expect(retro.steps).toEqual([
      { step: 1, attempts: 1, tools: [{ name: 'search', ok: true }] },
      { step: 2, attempts: 1, tools: [{ name: 'fetch', ok: false, errorCode: 'TOOL_TIMEOUT' }] },
    ])
    expect(retro.toolCalls).toBe(2)
  })

  it('lists every child run a call started', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'fan_out')] }),
      toolFinished('c1', { childRunId: 'child-b', childRunIds: ['child-a', 'child-b'] }),
    ])
    expect(retrospective(events).children).toEqual([
      { callId: 'c1', childRunId: 'child-a', ok: true },
      { callId: 'c1', childRunId: 'child-b', ok: true },
    ])
  })

  it('has no end, duration or run id before the run ends', () => {
    const events = sequence([runStarted(), stepStarted(1), contextBuilt(1), modelResponded(1)])
    const retro = retrospective(events)
    expect(retro.timeline).toEqual([])
    expect(retro.end).toBeUndefined()
    expect(retro.durationMs).toBeUndefined()
    expect(retro.runId).toBe('')
  })

  it('AC-005 adds queueing, model attempts, approvals, compactions and each check verdict', () => {
    const summary = 'sha256:5555555555555555555555555555555555555555555555555555555555555555'
    const events = sequence([
      runStarted({ queuedMs: 7 }),
      stepStarted(1),
      {
        ...contextBuilt(1),
        compaction: { upTo: 4, summary, reason: 'turn_start', tokens: { before: 900, after: 300 } },
      },
      modelResponded(1, {
        toolCalls: [call('c1', 'refund'), call('c2', 'refund')],
        attempts: attempts(3),
      }),
      { t: 'approval_answered', callId: 'c1', approved: true, waitedMs: 40 },
      { t: 'approval_answered', callId: 'c2', approved: false, waitedMs: 12 },
      toolFinished('c1', { effect: 'side_effect' }),
      toolFinished('c2', { isError: true, errorCode: 'APPROVAL_DENIED' }),
      evaluated(1, go),
      stepEnded(1),
      stepStarted(2),
      { ...contextBuilt(2), compaction: { upTo: 4, summary } },
      modelResponded(2, { text: '草稿', attempts: attempts(1) }),
      evaluated(2, { complete: true, sources: ['candidate'] }),
      stepEnded(2),
      deliveryChecked(2, 'returned', {
        output: { ok: true },
        checks: [
          { source: 'completion', mode: 'gate', pass: false, issues: ['没有回答第二问'] },
          { source: 'grounding', mode: 'shadow', pass: false, issues: ['数字没有出处'] },
        ],
      }),
      stepStarted(3),
      { ...contextBuilt(3), compaction: { upTo: 4, summary } },
      modelResponded(3, { text: '定稿', attempts: attempts(1) }),
      evaluated(3, { complete: true, sources: ['candidate'] }),
      stepEnded(3),
      deliveryChecked(3, 'delivered', {
        attempt: 2,
        checks: [
          { source: 'completion', mode: 'gate', pass: true },
          { source: 'grounding', mode: 'shadow', pass: true },
        ],
      }),
      runEnded(),
    ])
    const retro = retrospective(events)
    expect(retro.queuedMs).toBe(7)
    expect(retro.steps.map((s) => [s.step, s.attempts])).toEqual([
      [1, 3],
      [2, 1],
      [3, 1],
    ])
    expect(retro.timeline).toEqual([
      { step: 1, kind: 'compaction', reason: 'turn_start' },
      { step: 1, kind: 'approval', callId: 'c1', answer: 'approved', waitedMs: 40 },
      { step: 1, kind: 'approval', callId: 'c2', answer: 'denied', waitedMs: 12 },
    ])
    expect(retro.deliveries.map((d) => d.checks)).toEqual([
      [
        { source: 'output', mode: 'gate', pass: true },
        { source: 'completion', mode: 'gate', pass: false },
        { source: 'grounding', mode: 'shadow', pass: false },
      ],
      [
        { source: 'output', mode: 'gate', pass: true },
        { source: 'completion', mode: 'gate', pass: true },
        { source: 'grounding', mode: 'shadow', pass: true },
      ],
    ])
  })

  it('AC-005 records a deferred approval at the step it was asked in', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c3', 'refund')] }),
      { t: 'approval_answered', callId: 'c3', approved: false, deferred: true, waitedMs: 0 },
      toolFinished('c3', { isError: true, errorCode: 'APPROVAL_PENDING' }),
      evaluated(1, { awaitInput: { code: 'approval_pending' }, sources: ['guard:approval'] }),
      stepEnded(1),
      runEnded({ status: 'awaiting_input', code: 'approval_pending' }),
    ])
    expect(retrospective(events).timeline).toEqual([
      { step: 1, kind: 'approval', callId: 'c3', answer: 'deferred', waitedMs: 0 },
    ])
  })

  it('AC-005 records a failed model call and counts an empty attempt list as one attempt', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'search')] }),
      toolFinished('c1'),
      evaluated(1, go),
      stepEnded(1),
      stepStarted(2),
      contextBuilt(2),
      {
        t: 'model_failed',
        step: 2,
        startedAt: 0,
        error: {
          code: 'MODEL_TIMEOUT',
          message: 'timeout',
          retryable: true,
          attempts: attempts(2),
        },
      },
      runEnded({ status: 'failed', code: 'model_error' }),
    ])
    const retro = retrospective(events)
    expect(retro.steps.map((s) => [s.step, s.attempts])).toEqual([[1, 1]])
    expect(retro.timeline).toEqual([
      { step: 2, kind: 'model_failed', code: 'MODEL_TIMEOUT', attempts: 2 },
    ])
  })

  it('has no queueing time without run_started', () => {
    const retro = retrospective(sequence([stepStarted(1), modelResponded(1)]))
    expect(retro).not.toHaveProperty('queuedMs')
    expect(retro.steps).toEqual([{ step: 1, attempts: 1, tools: [] }])
  })

  it('carries the error message of a failed run', () => {
    const events = sequence([
      runStarted(),
      runEnded({
        status: 'failed',
        code: 'model_error',
        error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true },
      }),
    ])
    expect(retrospective(events).end).toEqual({
      status: 'failed',
      code: 'model_error',
      message: 'slow down',
    })
  })
})
