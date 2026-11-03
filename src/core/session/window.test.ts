import { describe, expect, it } from 'vitest'
import type { ModelMessage, Segment } from '../../contracts/common.js'
import type { LedgerEntry } from '../../contracts/events.js'
import {
  call,
  contextBuilt,
  modelResponded,
  runEnded,
  runStarted,
  sequence,
  stepStarted,
  toolFinished,
  toolSnapshot,
  type EventBody,
} from '../log/events.fixture.js'
import { summaryMessage } from '../run/layout.js'
import {
  appendLedger,
  blobsForCarry,
  carry,
  ledgerEntries,
  ledgerSegment,
  type CarryInput,
} from './window.js'

const user = (text: string): ModelMessage => ({ role: 'user', content: text })
const input: Segment[] = [{ role: 'user', parts: [{ type: 'text', text: '本轮问题' }] }]
const shown = (callId: string) => `sha256:${callId.padEnd(64, '0')}`
const out = (callId: string) => `<tool_output>\n结果 ${callId}\n</tool_output>`

/** 一轮的日志：按给出的事件体编号；工具结果的 blob 正文按 callId 生成。 */
function turnOf(bodies: EventBody[], patch: Partial<CarryInput> = {}): CarryInput {
  const events = sequence(bodies)
  const blobs = new Map<string, string>()
  for (const e of events) if (e.t === 'tool_finished') blobs.set(e.shown, out(e.callId))
  return { turn: 1, window: { messages: [], turnStarts: [] }, input, events, blobs, ...patch }
}

const said = (text: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})
const asked = (id: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'search', input: { q: id } }],
})
const answered = (id: string): ModelMessage => ({
  role: 'tool',
  content: [
    { type: 'tool-result', toolCallId: id, toolName: 'search', output: out(id), isError: false },
  ],
})

describe('carry', () => {
  it('§6 carries the input and the conversation of the first turn', () => {
    const next = carry(
      turnOf([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { toolCalls: [call('c1')] }),
        toolFinished('c1'),
        stepStarted(2),
        contextBuilt(2),
        modelResponded(2, { text: '答复' }),
        runEnded(),
      ]),
    )
    expect(next).toEqual({
      messages: [
        { role: 'user', content: input[0]!.parts },
        asked('c1'),
        answered('c1'),
        said('答复'),
      ],
      turnStarts: [0],
    })
  })

  it('§6 keeps delivery hints and drops the other run-scoped hints', () => {
    const next = carry(
      turnOf([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { text: '初稿' }),
        {
          t: 'intervention_applied',
          step: 2,
          intervention: { hint: { text: '还剩 2 步' } },
          source: 'engine:budget',
        },
        {
          t: 'intervention_applied',
          step: 2,
          intervention: { hint: { text: '缺少免责声明' } },
          source: 'delivery',
        },
        stepStarted(2),
        contextBuilt(2),
        modelResponded(2, { text: '定稿' }),
        runEnded(),
      ]),
    )
    expect(next.messages.slice(1)).toEqual([
      said('初稿'),
      { role: 'system', content: '[delivery] 缺少免责声明' },
      said('定稿'),
    ])
  })

  it('§6 applies the last committed compaction in the coordinates the memory used', () => {
    const turn = turnOf(
      [
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { toolCalls: [call('c1')] }),
        toolFinished('c1'),
        stepStarted(2),
        {
          ...contextBuilt(2),
          compaction: { upTo: 4, summary: 'sha256:summary' },
        },
        modelResponded(2, { text: '答复' }),
        runEnded(),
      ],
      { window: { messages: [user('h0'), user('h1')], turnStarts: [0] } },
    )
    turn.blobs = new Map([...turn.blobs, ['sha256:summary', '前两条与工具交换']])
    // 前文 2 条 + 运行记录的调用与结果 = 前 4 条换成摘要；本轮输入在摘要之后。
    expect(carry(turn)).toEqual({
      messages: [
        summaryMessage('前两条与工具交换'),
        { role: 'user', content: input[0]!.parts },
        said('答复'),
      ],
      turnStarts: [1],
      summary: '前两条与工具交换',
    })
  })

  it('§6 moves the turn starts past a compaction inside the carried window', () => {
    const window = {
      messages: [summaryMessage('s0'), user('q1'), user('a1'), user('q2'), user('a2')],
      turnStarts: [1, 3],
      summary: 's0',
    }
    const turn = turnOf(
      [
        runStarted(),
        stepStarted(1),
        {
          ...contextBuilt(1),
          compaction: { upTo: 3, summary: 'sha256:s1' },
        },
        modelResponded(1, { text: '答复' }),
        runEnded(),
      ],
      { window, turn: 3 },
    )
    turn.blobs = new Map([['sha256:s1', 's1']])
    expect(carry(turn)).toEqual({
      messages: [
        summaryMessage('s1'),
        user('q2'),
        user('a2'),
        { role: 'user', content: input[0]!.parts },
        said('答复'),
      ],
      turnStarts: [1, 3],
      summary: 's1',
    })
  })

  it('§6 keeps the carried summary when the turn did not compact', () => {
    const window = { messages: [summaryMessage('s0'), user('q1')], turnStarts: [1], summary: 's0' }
    const next = carry(
      turnOf(
        [
          runStarted(),
          stepStarted(1),
          contextBuilt(1),
          modelResponded(1, { text: 'a' }),
          runEnded(),
        ],
        {
          window,
        },
      ),
    )
    expect(next.summary).toBe('s0')
    expect(next.turnStarts).toEqual([1, 2])
    expect(next.messages[0]).toEqual(summaryMessage('s0'))
  })

  it('§6 counts dynamic notices in the coordinates but does not carry them', () => {
    const turn = turnOf([
      {
        t: 'external_call',
        source: 'notice:duty/provide',
        kind: 'record',
        request: 'sha256:req',
        response: 'sha256:notice',
        startedAt: 0,
        durationMs: 0,
      },
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1')] }),
      toolFinished('c1'),
      stepStarted(2),
      // 须知 1 条 + 调用与结果：前 3 条换成摘要。
      { ...contextBuilt(2), compaction: { upTo: 3, summary: 'sha256:s' } },
      modelResponded(2, { text: '答复' }),
      runEnded(),
    ])
    const notice: Segment[] = [
      { role: 'system', parts: [{ type: 'text', text: '今天值班的是张律师' }] },
    ]
    turn.blobs = new Map([
      ...turn.blobs,
      ['sha256:notice', JSON.stringify(notice)],
      ['sha256:s', 's'],
    ])
    expect(blobsForCarry(turn.events)).toEqual(
      expect.arrayContaining(['sha256:notice', 'sha256:s', shown('c1')]),
    )
    expect(carry(turn).messages).toEqual([
      summaryMessage('s'),
      { role: 'user', content: input[0]!.parts },
      said('答复'),
    ])
    const plain = {
      ...turn,
      events: turn.events.filter((e) => e.t !== 'context_built' || !e.compaction),
    }
    expect(carry(plain).messages).not.toContainEqual({
      role: 'system',
      content: '今天值班的是张律师',
    })
  })

  it('§11 ends a finalized turn with the fallback text and a line about the outcome', () => {
    const next = carry(
      turnOf(
        [
          runStarted(),
          stepStarted(1),
          contextBuilt(1),
          modelResponded(1, { text: '还在查' }),
          {
            t: 'fallback_generated',
            code: 'max_steps',
            text: '阶段性意见：先收集工资流水',
            degradation: 0,
          },
          runEnded({ status: 'finalized', code: 'max_steps' }),
        ],
        { turn: 2 },
      ),
    )
    expect(next.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '阶段性意见：先收集工资流水' },
      { role: 'system', content: '【第 2 轮结局】finalized（max_steps）' },
    ])
  })

  it('§11 says how a failed or unrecorded turn ended', () => {
    const failed = carry(
      turnOf([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        runEnded({
          status: 'failed',
          code: 'model_error',
          error: { code: 'RATE_LIMITED', message: '限流', retryable: true },
        }),
      ]),
    )
    expect(failed.messages.at(-1)).toEqual({
      role: 'system',
      content: '【第 1 轮结局】failed（model_error）：限流',
    })
    const unrecorded = carry(
      turnOf([runStarted(), stepStarted(1), contextBuilt(1), modelResponded(1, { text: 'a' })]),
    )
    expect(unrecorded.messages.at(-1)).toEqual({
      role: 'system',
      content: '【第 1 轮结局】没有记录',
    })
  })

  it('§6 closes a tool call whose result was never recorded', () => {
    const next = carry(
      turnOf([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { toolCalls: [call('c1'), call('c2')] }),
        toolFinished('c1'),
      ]),
    )
    expect(next.messages[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'search',
          output: out('c1'),
          isError: false,
        },
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'search',
          output:
            '<tool_output>\nERROR [TOOL_MISSING_RESULT]: 调用结果没有记录；如有副作用，可能已经执行\n</tool_output>',
          isError: true,
        },
      ],
    })
  })

  it('§6 carries steers that arrived after the last context was built', () => {
    const next = carry(
      turnOf([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { text: '答复' }),
        { t: 'steer_received', text: '再算一下加班费' },
        runEnded(),
      ]),
    )
    expect(next.messages.at(-1)).toEqual({ role: 'user', content: '再算一下加班费' })
  })

  it('§6 keeps reasoning as recorded: the adapter decides whether it can be replayed', () => {
    const next = carry(
      turnOf([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, {
          reasoning: { text: '想一想', providerData: { signature: 'x' } },
          text: '答复',
        }),
        runEnded(),
      ]),
    )
    expect(JSON.stringify(next.messages)).toContain('"signature":"x"')
  })
})

describe('ledger', () => {
  const sideEffectTools = runStarted({
    capabilities: [
      {
        capability: 'tools',
        kind: 'tool',
        version: '1',
        fingerprint: 'fp',
        tools: [
          toolSnapshot('send', { effect: 'side_effect' }),
          toolSnapshot('delegate', { effect: 'side_effect' }),
          toolSnapshot('search'),
        ],
      },
    ],
  })

  it('§9 lists executed, possibly executed and unrecorded side effects of a turn', () => {
    const events = sequence([
      sideEffectTools,
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, {
        toolCalls: [
          call('c1', 'send', { to: '星河科技' }),
          call('c2', 'send', { to: 'b' }),
          call('c3', 'search'),
        ],
      }),
      toolFinished('c1', { effect: 'side_effect' }),
      toolFinished('c2', { effect: 'side_effect', isError: true, errorCode: 'TOOL_TIMEOUT' }),
      toolFinished('c3'),
      stepStarted(2),
      contextBuilt(2),
      modelResponded(2, { toolCalls: [call('c4', 'send', { to: 'c' })] }),
    ])
    expect(ledgerEntries(3, events, [])).toEqual([
      { turn: 3, tool: 'send', input: '{"to":"星河科技"}', status: 'executed' },
      { turn: 3, tool: 'send', input: '{"to":"b"}', status: 'possibly_executed' },
      { turn: 3, tool: 'send', input: '{"to":"c"}', status: 'possibly_executed' },
    ])
  })

  it('§9 replaces a delegation with the side effects of the child runs it started', () => {
    const parent = sequence([
      sideEffectTools,
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('d1', 'delegate', { task: 'x'.repeat(300) })] }),
      toolFinished('d1', {
        effect: 'side_effect',
        childRunId: 'child-1',
        childRunIds: ['child-1'],
      }),
    ])
    const child = sequence([
      sideEffectTools,
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('k1', 'send', { to: '对方' })] }),
      toolFinished('k1', { effect: 'side_effect' }),
    ])
    expect(ledgerEntries(2, parent, [child])).toEqual([
      { turn: 2, tool: 'send', input: '{"to":"对方"}', status: 'executed' },
    ])
  })

  it('§9 keeps at most 50 entries: every possibly executed one and the latest executed ones', () => {
    const entry = (i: number, status: LedgerEntry['status'] = 'executed'): LedgerEntry => ({
      turn: i,
      tool: 'send',
      input: `${i}`,
      status,
    })
    const executed = Array.from({ length: 60 }, (_, i) => entry(i))
    const { ledger, omitted } = appendLedger(
      { ledger: [entry(-1, 'possibly_executed'), ...executed.slice(0, 30)], omitted: 2 },
      [...executed.slice(30), entry(99, 'possibly_executed')],
    )
    expect(ledger).toHaveLength(50)
    expect(ledger.filter((e) => e.status === 'possibly_executed')).toHaveLength(2)
    expect(ledger.at(-2)).toEqual(entry(59))
    expect(omitted).toBe(2 + 12)
  })

  it('§9 truncates long inputs', () => {
    const events = sequence([
      sideEffectTools,
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { toolCalls: [call('c1', 'send', { body: 'x'.repeat(300) })] }),
      toolFinished('c1', { effect: 'side_effect' }),
    ])
    expect(ledgerEntries(1, events, [])[0]!.input).toHaveLength(201)
  })

  it('§9 renders the ledger as a system segment, and nothing when it is empty', () => {
    expect(ledgerSegment([], 0)).toBeUndefined()
    const segment = ledgerSegment(
      [
        { turn: 3, tool: 'send', input: '{"to":"a"}', status: 'executed' },
        { turn: 4, tool: 'send', input: '{"to":"b"}', status: 'possibly_executed' },
      ],
      5,
    )
    expect(segment).toEqual({
      role: 'system',
      parts: [
        {
          type: 'text',
          text: [
            '【本会话已执行的副作用】下面的动作在之前的轮次里已经执行过；除非委托人明确要求，不要重复执行：',
            '- 第 3 轮 send {"to":"a"}',
            '- 第 4 轮 send {"to":"b"}（可能已执行，结果未知）',
            '另有 5 条更早的已执行副作用没有列出，原文保留在会话日志。',
          ].join('\n'),
        },
      ],
    })
  })
})
