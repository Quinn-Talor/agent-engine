import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../contracts/common.js'
import type { MemoryState, MemoryView } from '../contracts/component.js'
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
} from '../core/events.fixture.js'
import { apply, initial, type RunState } from '../core/state.js'
import { FakeClock } from '../testing/fake-clock.js'
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
  const memoryState: MemoryState = {
    step: 1,
    history: [],
    transcript: [],
    contextLimit: 1000,
    fixedTokens: 0,
    estimate: () => 0,
  }
  const memoryOf = (recall: (s: MemoryState) => Promise<MemoryView>) => ({ recall })

  it('AC-004 returns a valid view including compaction', async () => {
    const view: MemoryView = {
      history: [],
      transcript: [],
      compaction: { replaced: [0, 4], summary: 'summary', anchorsKept: 2 },
    }
    expect(
      await recallView(
        memoryOf(async () => view),
        memoryState,
        { clock: new FakeClock() },
      ),
    ).toBe(view)
  })

  it('AC-005 rejects a view that breaks tool pairs', async () => {
    const broken = memoryOf(async () => ({
      history: [],
      transcript: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'x', toolName: 't', input: {} }],
        },
      ],
    }))
    await expect(recallView(broken, memoryState, { clock: new FakeClock() })).rejects.toThrow(
      '成对',
    )
  })

  it('AC-005 falls back to the full view when the memory fails', async () => {
    const failing = memoryOf(async () => Promise.reject(new Error('summarizer down')))
    const logs: string[] = []
    const view = await recallView(failing, memoryState, {
      clock: new FakeClock(),
      log: (message) => logs.push(message),
    })
    expect(view).toEqual({ history: memoryState.history, transcript: memoryState.transcript })
    expect(logs).toEqual(['记忆出错，沿用完整视图：Error: summarizer down'])
  })

  describe('I3: the view keeps history and transcript unless a compaction says otherwise', () => {
    const msg = (text: string): ModelMessage => ({ role: 'user', content: text })
    const summary: ModelMessage = { role: 'system', content: '【前文摘要】' }
    const state: MemoryState = {
      ...memoryState,
      history: [msg('h1'), msg('h2')],
      transcript: [msg('t1'), msg('t2'), msg('t3')],
    }
    const compaction = (replaced: [number, number]) => ({ replaced, summary: 's', anchorsKept: 0 })
    const recall = (view: MemoryView) =>
      recallView(
        memoryOf(async () => view),
        state,
        { clock: new FakeClock() },
      )

    it.each<[string, MemoryView]>([
      ['the inputs as they are', { history: state.history, transcript: state.transcript }],
      [
        'a warning appended after the transcript',
        { history: state.history, transcript: [...state.transcript, summary] },
      ],
      [
        'a compaction inside the history',
        {
          history: [summary, msg('h2')],
          transcript: state.transcript,
          compaction: compaction([0, 1]),
        },
      ],
      [
        'a compaction across the boundary',
        { history: [summary], transcript: [msg('t2'), msg('t3')], compaction: compaction([0, 3]) },
      ],
      [
        'a compaction whose range runs past the end',
        { history: [summary], transcript: [], compaction: compaction([0, 9]) },
      ],
    ])('accepts %s', async (_name, view) => {
      expect(await recall(view)).toBe(view)
    })

    it.each<[string, MemoryView]>([
      ['a dropped message', { history: state.history, transcript: [msg('t1'), msg('t3')] }],
      [
        'an inserted message',
        { history: state.history, transcript: [msg('t1'), summary, msg('t2'), msg('t3')] },
      ],
      [
        'a rewritten message',
        { history: state.history, transcript: [msg('t1'), msg('t2'), msg('x')] },
      ],
      [
        'a transcript message moved before the task input',
        { history: [...state.history, msg('t1')], transcript: [msg('t2'), msg('t3')] },
      ],
      [
        'a message appended to the history',
        { history: [...state.history, summary], transcript: state.transcript },
      ],
      [
        'a change outside the declared compaction',
        {
          history: [summary, msg('h2')],
          transcript: [msg('t1'), msg('t3')],
          compaction: compaction([0, 1]),
        },
      ],
      [
        'an invalid compaction range',
        { history: state.history, transcript: state.transcript, compaction: compaction([3, 1]) },
      ],
    ])('rejects %s', async (_name, view) => {
      await expect(recall(view)).rejects.toThrow('记忆视图改写了')
    })

    it('rejects a memory that drops a message from the arrays it was given', async () => {
      const fresh = { ...state, history: [...state.history], transcript: [...state.transcript] }
      const inPlace = memoryOf(async (s) => {
        s.transcript.splice(1, 1)
        return { history: s.history, transcript: s.transcript }
      })
      await expect(recallView(inPlace, fresh, { clock: new FakeClock() })).rejects.toThrow(
        '记忆视图改写了',
      )
    })
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
    expect(await pending).toEqual({
      history: memoryState.history,
      transcript: memoryState.transcript,
    })
    expect(logs).toEqual(['记忆出错，沿用完整视图：超时'])
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
