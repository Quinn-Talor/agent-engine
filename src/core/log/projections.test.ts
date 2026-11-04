import { describe, expect, it } from 'vitest'
import type { Segment } from '../../contracts/common.js'
import type { RunEvent } from '../../contracts/events.js'
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
import {
  buildCorpus,
  deliveries,
  foldState,
  observations,
  qualityOf,
  sideEffects,
  summarize,
  transcriptMessages,
} from './projections.js'
import type { TranscriptEntry } from '../run/state.js'

const continueVerdict = { continue: { interventions: [] }, sources: ['default'] }
const completeVerdict = { complete: true as const, sources: ['default'] }

const fullRun = () =>
  sequence([
    runStarted({
      task: {
        fingerprint: 't',
        content: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        subject: 's-1',
      },
      parentRunId: 'p-1',
    }),
    stepStarted(1),
    contextBuilt(1),
    modelResponded(1, { toolCalls: [call('c1')] }),
    toolFinished('c1'),
    evaluated(1, continueVerdict),
    stepEnded(1),
    stepStarted(2),
    contextBuilt(2),
    modelResponded(2, { text: 'done' }),
    evaluated(2, completeVerdict, { isFinalCandidate: true }),
    stepEnded(2),
    deliveryChecked(2, 'delivered'),
    runEnded({ status: 'completed', code: 'finish', cost: 0.5, steps: 2, toolCalls: 1 }),
  ])

describe('summarize', () => {
  it('AC-004 summarises a full run', () => {
    const events = fullRun()
    const summary = summarize(events)!
    expect(summary).toMatchObject({
      runId: 'r1',
      rootRunId: 'r1',
      parentRunId: 'p-1',
      environment: 'env',
      environmentFingerprint: 'env-fp',
      engineFingerprint: 'engine-fp',
      agentId: 'agent',
      agentFingerprint: 'agent-fp',
      model: 'fake:model',
      subject: 's-1',
      status: 'completed',
      code: 'finish',
      startedAt: events[0]!.at,
      endedAt: events.at(-1)!.at,
      steps: 2,
      toolCalls: 1,
      cost: 0.5,
      pinned: false,
    })
    expect(summary.usage.main.input).toBe(200)
    expect('agentVersion' in summary).toBe(false)
  })

  it('returns undefined for a run without run_started or origin', () => {
    expect(summarize(sequence([runEnded({ status: 'failed' })]))).toBeUndefined()
  })

  it('summarises a run that ended before it started from the origin on run_ended', () => {
    const [ended] = sequence([runEnded({ status: 'failed', code: 'admission_timeout' })])
    const origin = {
      rootRunId: 'root',
      parentRunId: 'parent',
      environment: 'env',
      environmentFingerprint: 'env-fp',
      engineFingerprint: 'engine-fp',
      agentId: 'helper',
      agentFingerprint: 'agent-fp',
      subject: 's-1',
    }
    const summary = summarize([{ ...ended!, origin } as RunEvent])!
    expect(summary).toMatchObject({
      rootRunId: 'root',
      parentRunId: 'parent',
      environment: 'env',
      agentId: 'helper',
      subject: 's-1',
      status: 'failed',
      code: 'admission_timeout',
      steps: 0,
      toolCalls: 0,
      pinned: false,
    })
    expect(summary.startedAt).toBe(summary.endedAt)
  })

  it('summarises an unfinished run without status or end time', () => {
    const summary = summarize(sequence([runStarted(), stepStarted(1)]))!
    expect(summary.steps).toBe(1)
    expect('status' in summary).toBe(false)
    expect('endedAt' in summary).toBe(false)
  })
})

describe('foldState', () => {
  it('uses the run id from run_ended', () => {
    expect(foldState(fullRun()).runId).toBe('r1')
    expect(foldState([]).runId).toBe('')
  })
})

describe('transcriptMessages', () => {
  it('AC-015 renders the images of a tool result after its text', () => {
    const entries: TranscriptEntry[] = [
      {
        origin: 'tool',
        step: 1,
        results: [
          {
            callId: 'c1',
            toolName: 'screenshot',
            shown: 'sha256:out',
            isError: false,
            images: [{ blob: 'sha256:img', mediaType: 'image/png' }],
          },
        ],
      },
    ]
    const blobs = new Map([
      ['sha256:out', '<tool_output>截图如下</tool_output>'],
      ['sha256:img', 'AQID'],
    ])
    expect(transcriptMessages(entries, blobs)).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'screenshot',
            output: '<tool_output>截图如下</tool_output>',
            isError: false,
            images: [{ type: 'image', image: 'AQID', mediaType: 'image/png' }],
          },
        ],
      },
    ])
  })

  it('AC-005 turns entries into model messages', () => {
    const notice: Segment[] = [{ role: 'system', parts: [{ type: 'text', text: 'org notice' }] }]
    const entries: TranscriptEntry[] = [
      { origin: 'hook', source: 'notice:org', content: 'sha256:hook' },
      {
        origin: 'model',
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} }],
        },
      },
      {
        origin: 'tool',
        step: 1,
        results: [
          { callId: 'c1', toolName: 'search', shown: 'sha256:out', isError: false },
          { callId: 'c2', toolName: 'search', shown: 'sha256:missing', isError: true },
        ],
      },
      { origin: 'hint', step: 2, source: 'corrector', text: 'change approach' },
      { origin: 'hint', step: 2, source: 'steering', text: '[纠偏 · 第 2 步]' },
      { origin: 'steer', step: 2, text: 'focus on X' },
    ]
    const blobs = new Map([
      ['sha256:out', '<tool_output>result</tool_output>'],
      ['sha256:hook', JSON.stringify(notice)],
    ])
    expect(transcriptMessages(entries, blobs)).toEqual([
      { role: 'system', content: 'org notice' },
      entries[1]!.origin === 'model' ? entries[1]!.message : undefined,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: '<tool_output>result</tool_output>',
            isError: false,
          },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'search', output: '', isError: true },
        ],
      },
      { role: 'system', content: '[corrector] change approach' },
      { role: 'system', content: '[纠偏 · 第 2 步]' },
      { role: 'user', content: 'focus on X' },
    ])
  })
})

describe('observations and deliveries', () => {
  it('lists evaluated observations and delivery records in order', () => {
    const events = fullRun()
    expect(observations(events).map((o) => o.step)).toEqual([1, 2])
    expect(deliveries(events).map((d) => d.t)).toEqual(['delivery_checked'])
  })
})

describe('sideEffects', () => {
  it('AC-006 lists executed and possibly executed side effects', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, {
        toolCalls: [
          call('c1', 'read'),
          call('c2', 'write', { path: '/a' }),
          call('c3', 'put'),
          call('c4', 'send'),
        ],
      }),
      toolFinished('c1', { effect: 'none' }),
      toolFinished('c2', { effect: 'side_effect' }),
      toolFinished('c3', { effect: 'idempotent', isError: true, errorCode: 'TOOL_EXCEPTION' }),
      toolFinished('c4', { effect: 'side_effect', isError: true, errorCode: 'TOOL_INTERRUPTED' }),
    ])
    expect(sideEffects(events)).toEqual([
      {
        callId: 'c2',
        toolName: 'write',
        capability: 'tools',
        effect: 'side_effect',
        step: 1,
        input: { path: '/a' },
        status: 'executed',
      },
      {
        callId: 'c4',
        toolName: 'send',
        capability: 'tools',
        effect: 'side_effect',
        step: 1,
        input: { q: 'c4' },
        status: 'possibly_executed',
      },
    ])
  })

  it('treats a timed-out side effect as possibly executed', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'pay')] }),
      toolFinished('c1', { effect: 'idempotent', isError: true, errorCode: 'TOOL_TIMEOUT' }),
    ])
    expect(sideEffects(events).map((s) => s.status)).toEqual(['possibly_executed'])
  })

  it('treats a side effect the run marked as possibly executed as such, whatever its code', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'pay'), call('c2', 'ticket')] }),
      toolFinished('c1', {
        effect: 'side_effect',
        isError: true,
        errorCode: 'TOOL_RESULT_LOST',
        possiblyExecuted: true,
      }),
      toolFinished('c2', {
        effect: 'side_effect',
        isError: true,
        errorCode: 'TOOL_EXCEPTION',
        possiblyExecuted: true,
      }),
    ])
    expect(sideEffects(events).map((s) => [s.callId, s.status])).toEqual([
      ['c1', 'possibly_executed'],
      ['c2', 'possibly_executed'],
    ])
  })

  it('I15 treats a side effect cancelled while it may have been running as possibly executed', () => {
    const events = sequence([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'pay'), call('c2', 'read')] }),
      toolFinished('c1', { effect: 'side_effect', isError: true, errorCode: 'TOOL_ABORTED' }),
      toolFinished('c2', { effect: 'none', isError: true, errorCode: 'TOOL_ABORTED' }),
      runEnded({ status: 'aborted', code: 'user' }),
    ])
    expect(sideEffects(events).map((s) => [s.callId, s.status])).toEqual([
      ['c1', 'possibly_executed'],
    ])
  })
})

describe('qualityOf', () => {
  it('AC-014 (F6) reports released gates and annotations from the final delivery', () => {
    const events = sequence([
      deliveryChecked(1, 'returned', {
        checks: [{ source: 'check:A', mode: 'gate', pass: false, issues: ['old'] }],
      }),
      deliveryChecked(2, 'delivered', {
        checks: [
          { source: 'check:A', mode: 'gate', pass: false, issues: ['still wrong'] },
          { source: 'check:B', mode: 'gate', pass: true },
          { source: 'check:C', mode: 'annotate', pass: false, issues: ['ungrounded'] },
          { source: 'check:D', mode: 'shadow', pass: false, issues: ['would block'] },
        ],
      }),
    ])
    expect(qualityOf(events)).toEqual({
      unresolved: [{ source: 'check:A', issues: ['still wrong'] }],
      annotations: [{ source: 'check:C', pass: false, issues: ['ungrounded'] }],
    })
  })

  it('returns undefined without a delivery or without check results', () => {
    expect(qualityOf(sequence([runStarted()]))).toBeUndefined()
    expect(qualityOf(sequence([deliveryChecked(1, 'delivered')]))).toBeUndefined()
  })

  it('omits issues from passing annotations', () => {
    const events = sequence([
      deliveryChecked(1, 'delivered', {
        checks: [{ source: 'check:C', mode: 'annotate', pass: true }],
      }),
    ])
    expect(qualityOf(events)).toEqual({
      unresolved: [],
      annotations: [{ source: 'check:C', pass: true }],
    })
  })
})

describe('buildCorpus', () => {
  it('AC-007 collects input, history and tool outputs', () => {
    const corpus = buildCorpus({
      input: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'task' },
            { type: 'image', image: 'x' },
          ],
        },
      ],
      history: [
        { role: 'user', content: 'earlier question' },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'h1', toolName: 's', output: 'earlier output' },
          ],
        },
      ],
      toolOutputs: [
        { callId: 'c1', text: 'out 1' },
        { callId: 'c2', text: 'out 2' },
      ],
    })
    expect(corpus.sources).toEqual([
      { origin: 'input', text: 'task' },
      { origin: 'history', text: 'earlier question' },
      { origin: 'history', text: 'earlier output' },
      { origin: 'tool', text: 'out 1', callId: 'c1' },
      { origin: 'tool', text: 'out 2', callId: 'c2' },
    ])
  })

  it('AC-010 keeps tool name, effect and error flag of tool outputs', () => {
    const corpus = buildCorpus({
      input: [],
      history: [],
      toolOutputs: [
        { callId: 'c1', text: 'saved', toolName: 'write', effect: 'side_effect', isError: false },
      ],
    })
    expect(corpus.sources).toEqual([
      {
        origin: 'tool',
        text: 'saved',
        callId: 'c1',
        toolName: 'write',
        effect: 'side_effect',
        isError: false,
      },
    ])
  })

  it('includes text parts of assistant messages in history', () => {
    const corpus = buildCorpus({
      input: [],
      history: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }],
      toolOutputs: [],
    })
    expect(corpus.sources).toEqual([{ origin: 'history', text: 'answer' }])
  })
})
