import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../../contracts/common.js'
import type { MemoryState, MemoryView } from '../../contracts/component.js'
import {
  call,
  contextBuilt,
  evaluated,
  modelResponded,
  runStarted,
  sequence,
  stepEnded,
  stepStarted,
  toolFinished,
  type EventBody,
} from '../../core/log/events.fixture.js'
import { apply, initial, type RunState } from '../../core/run/state.js'
import { FakeClock } from '../../testing/fake-clock.js'
import {
  BlobCache,
  checkPairs,
  preview,
  recallView,
  renderTranscript,
  stepEvents,
} from './compose-view.js'

const fold = (bodies: EventBody[]): RunState =>
  sequence(bodies).reduce(apply, initial({ runId: 'r1' }))

/** 第 1 步：调用 search，继续裁决带提示与按工具阻断，之后收到引导。 */
const afterStep1 = (interventions: object[]) =>
  fold([
    runStarted(),
    stepStarted(1),
    contextBuilt(1),
    modelResponded(1, { toolCalls: [call('c1')] }),
    toolFinished('c1', { shown: 'sha256:out' }),
    evaluated(1, {
      continue: { interventions: interventions as never },
      sources: ['engine:roadblock'],
    }),
    { t: 'steer_received', text: 'focus' },
    stepEnded(1),
  ])

describe('stepEvents', () => {
  it('AC-001 AC-027 writes hints before call blocks, which last until the run ends', () => {
    const block = { tool: 'fetch', inputHash: 'h', code: 'repeat', reason: 'loop' }
    const state = afterStep1([{ block }, { hint: { text: 'try another source' } }])
    expect(stepEvents(state, 2)).toEqual([
      { t: 'step_started', step: 2 },
      {
        t: 'intervention_applied',
        step: 2,
        intervention: { hint: { text: 'try another source' } },
        source: 'engine:roadblock',
      },
      { t: 'intervention_applied', step: 2, intervention: { block }, source: 'engine:roadblock' },
    ])
  })
})

describe('preview and renderTranscript', () => {
  it('AC-001 renders hints and the merged steer at the end of the transcript', async () => {
    const state = afterStep1([{ hint: { text: 'try another source' } }])
    const next = preview(state, stepEvents(state, 2), 5_000)
    expect(next.step).toBe(2)
    const blobs = new BlobCache(async (ref) => `body of ${ref}`)
    const messages = await renderTranscript(next, blobs)
    expect(messages.slice(-3)).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: 'body of sha256:out',
            isError: false,
          },
        ],
      },
      { role: 'system', content: '[engine:roadblock] try another source' },
      { role: 'user', content: 'focus' },
    ])
  })

  it('resolves each blob once', async () => {
    let calls = 0
    const blobs = new BlobCache(async (ref) => {
      calls += 1
      return ref
    })
    await blobs.get('sha256:a')
    await blobs.get('sha256:a')
    expect(calls).toBe(1)
    expect(blobs.snapshot().get('sha256:a')).toBe('sha256:a')
  })
})

describe('checkPairs', () => {
  const callMsg = (...ids: string[]): ModelMessage => ({
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool-call', toolCallId: id, toolName: 't', input: {} })),
  })
  const resultMsg = (...ids: string[]): ModelMessage => ({
    role: 'tool',
    content: ids.map((id) => ({ type: 'tool-result', toolCallId: id, toolName: 't', output: '' })),
  })

  it.each<[string, ModelMessage[], string[]]>([
    ['paired calls', [callMsg('a', 'b'), resultMsg('a'), resultMsg('b')], []],
    [
      'a call followed by another message',
      [callMsg('a'), { role: 'user', content: 'x' }, resultMsg('a')],
      ['工具调用 a 没有紧跟结果', '工具结果 a 没有对应的调用'],
    ],
    ['a call at the end', [callMsg('a')], ['工具调用 a 没有紧跟结果']],
  ])('%s', (_name, messages, expected) => {
    expect(checkPairs(messages)).toEqual(expected)
  })
})

describe('recallView', () => {
  const msg = (text: string): ModelMessage => ({ role: 'user', content: text })
  const callMessage: ModelMessage = {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 't', input: {} }],
  }
  const resultMessage: ModelMessage = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 't', output: 'ok' }],
  }
  const memoryState: MemoryState = {
    step: 1,
    history: [msg('h1'), msg('h2')],
    transcript: [callMessage, resultMessage, msg('t3')],
    turnStarts: [],
    contextLimit: 1000,
    inputLimit: 1000,
    fixedTokens: 0,
    estimate: () => 0,
  }
  const memoryOf = (recall: (s: MemoryState) => Promise<MemoryView>) => ({ recall })
  const recall = (view: MemoryView, logs: string[] = []) =>
    recallView(
      memoryOf(async () => view),
      memoryState,
      { clock: new FakeClock(), log: (message) => logs.push(message) },
    )

  it('AC-004 returns the decision including the compaction and the notice', async () => {
    const view: MemoryView = { compaction: { upTo: 2, summary: 'summary' }, notice: 'n' }
    expect(await recall(view)).toEqual(view)
    // 覆盖到运行记录、切在成对边界上也可以。
    expect(await recall({ compaction: { upTo: 4, summary: 's' } })).toEqual({
      compaction: { upTo: 4, summary: 's' },
    })
  })

  it('AC-005 drops a compaction that splits a tool call from its result', async () => {
    const logs: string[] = []
    expect(await recall({ compaction: { upTo: 3, summary: 's' }, notice: 'n' }, logs)).toEqual({
      failed: true,
      notice: 'n',
    })
    expect(logs).toEqual(['记忆的压缩不合格，沿用上一步的压缩：切点拆开了工具调用与结果'])
  })

  it('AC-005 drops a compaction past the end of the given messages', async () => {
    const logs: string[] = []
    expect(await recall({ compaction: { upTo: 6, summary: 's' } }, logs)).toEqual({ failed: true })
    expect(logs).toEqual(['记忆的压缩不合格，沿用上一步的压缩：upTo 6 超出了 5 条消息'])
  })

  it('AC-005 compacts nothing when the memory fails', async () => {
    const failing = memoryOf(async () => Promise.reject(new Error('summarizer down')))
    const logs: string[] = []
    const view = await recallView(failing, memoryState, {
      clock: new FakeClock(),
      log: (message) => logs.push(message),
    })
    expect(view).toEqual({ failed: true })
    expect(logs).toEqual(['记忆出错，沿用上一步的压缩：Error: summarizer down'])
  })

  it('AC-007 gives the memory deep copies: changing a message leaves the run untouched', async () => {
    const original = structuredClone([memoryState.history, memoryState.transcript])
    await recallView(
      memoryOf(async (s) => {
        ;(s.history[0] as { content: string }).content = '改写'
        const call = s.transcript[0] as { content: Array<{ input: unknown }> }
        call.content[0]!.input = { q: '改写' }
        return {}
      }),
      memoryState,
      { clock: new FakeClock() },
    )
    expect([memoryState.history, memoryState.transcript]).toEqual(original)
  })

  it('I3 gives the memory copies: changing them leaves the run untouched', async () => {
    const state = { ...memoryState, transcript: [...memoryState.transcript] }
    const before = [...state.transcript]
    await recallView(
      memoryOf(async (s) => {
        s.transcript.splice(0, 2)
        return {}
      }),
      state,
      { clock: new FakeClock() },
    )
    expect(state.transcript).toEqual(before)
  })

  it('falls back to the full view when the memory times out', async () => {
    const clock = new FakeClock()
    const logs: string[] = []
    const pending = recallView(
      memoryOf(() => new Promise(() => {})),
      memoryState,
      { clock, timeoutMs: 100, log: (message) => logs.push(message) },
    )
    await clock.tick(100)
    expect(await pending).toEqual({ failed: true })
    expect(logs).toEqual(['记忆出错，沿用上一步的压缩：超时'])
  })

  it('gives the memory 120 seconds by default', async () => {
    const clock = new FakeClock()
    let settled = false
    const pending = recallView(
      memoryOf(() => new Promise(() => {})),
      memoryState,
      { clock },
    )
    void pending.then(() => (settled = true))
    await clock.tick(119_999)
    expect(settled).toBe(false)
    await clock.tick(1)
    await pending
    expect(settled).toBe(true)
  })
})
