import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../../contracts/common.js'
import type { ComponentCtx, MemoryState } from '../../contracts/component.js'
import type { SideModelRequest } from '../../contracts/model.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { runInfo } from '../capabilities/prepare.fixture.js'
import { compactingMemory, cutIndex } from './compacting-memory.js'

const user = (text: string): ModelMessage => ({ role: 'user', content: text })
const callMsg = (id: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'search', input: { q: id } }],
})
const result = (id: string): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'search', output: `out ${id}` }],
})

/** 每条消息 100 token。 */
const estimate = (messages: ModelMessage[]) => messages.length * 100
const history = [
  user('earlier question'),
  { role: 'assistant', content: 'earlier answer' } as ModelMessage,
]
const transcript = [
  callMsg('c1'),
  result('c1'),
  callMsg('c2'),
  result('c2'),
  { role: 'assistant', content: 'thinking' } as ModelMessage,
  user('focus'),
  callMsg('c3'),
  result('c3'),
]
const memoryState = (patch: Partial<MemoryState> = {}): MemoryState => ({
  step: 5,
  history,
  transcript,
  contextLimit: 1000,
  fixedTokens: 0,
  estimate,
  ...patch,
})

function setup(answers: Array<string | undefined>, clock = new FakeClock()) {
  const requests: SideModelRequest[] = []
  const logs: string[] = []
  const ctx = {
    clock,
    log: (_l: string, m: string) => logs.push(m),
    callModel: async (req: SideModelRequest) => {
      requests.push(req)
      const text = answers.length > 1 ? answers.shift() : answers[0]
      return text === undefined
        ? undefined
        : { text, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: 'fake:m' }
    },
  } as unknown as ComponentCtx
  return { requests, logs, clock, ctx }
}

describe('cutIndex', () => {
  const all = [...history, ...transcript]

  it('AC-014 moves a cut off a tool result onto its call', () => {
    expect(cutIndex(all, estimate, 100, 1)).toBe(8)
  })

  it('AC-014 keeps at least the requested number of tool exchanges', () => {
    expect(cutIndex(all, estimate, 100, 2)).toBe(4)
    expect(cutIndex(all, estimate, 100, 4)).toBe(2)
  })

  it('keeps everything that fits', () => {
    expect(cutIndex(all, estimate, 10_000, 1)).toBe(0)
  })
})

describe('compactingMemory', () => {
  it('identifies itself with its configuration', () => {
    expect(compactingMemory({ trigger: 0.7 })).toMatchObject({
      id: 'compacting',
      version: '1',
      config: { trigger: 0.7, keepRecentTokens: null, anchors: 4, model: null },
    })
  })

  it('AC-012 returns the view unchanged below the trigger', async () => {
    const { ctx, requests } = setup(['summary'])
    const memory = compactingMemory().start(runInfo(), ctx)
    expect(await memory.recall(memoryState({ contextLimit: 2000 }))).toEqual({
      history,
      transcript,
    })
    expect(requests).toHaveLength(0)
  })

  it('AC-013 replaces the older part with a structured summary', async () => {
    const { ctx, requests } = setup(['intent: analyse'])
    const memory = compactingMemory({
      keepRecentTokens: 300,
      anchors: 1,
      model: 'fake:small',
    }).start(runInfo(), ctx)
    const view = await memory.recall(memoryState())
    expect(view.history).toEqual([{ role: 'system', content: '【前文摘要】\nintent: analyse' }])
    expect(view.transcript).toEqual(transcript.slice(5))
    expect(view.compaction).toEqual({
      replaced: [0, 7],
      summary: 'intent: analyse',
      anchorsKept: 1,
    })
    expect(requests[0]).toMatchObject({ purpose: 'memory:compaction', model: 'fake:small' })
    expect(requests[0]!.system).toContain('未完成的动作')
    const serialized = requests[0]!.messages[0]!.content as string
    expect(serialized).toContain('调用 search({"q":"c1"})')
    expect(serialized).toContain('结果 search: out c1')
  })

  it('keeps the tail of a long history', async () => {
    const { ctx } = setup(['older'])
    const longHistory = [user('h0'), user('h1'), user('h2'), user('h3'), user('h4'), user('h5')]
    const memory = compactingMemory({ keepRecentTokens: 300, anchors: 0 }).start(runInfo(), ctx)
    const view = await memory.recall(
      memoryState({ history: longHistory, transcript: [user('t0')], contextLimit: 800 }),
    )
    expect(view.history).toEqual([
      { role: 'system', content: '【前文摘要】\nolder' },
      user('h4'),
      user('h5'),
    ])
    expect(view.transcript).toEqual([user('t0')])
    expect(view.compaction?.replaced).toEqual([0, 4])
  })

  it('AC-015 cools down for 60 seconds after three failed summaries', async () => {
    const clock = new FakeClock()
    const { ctx, requests, logs } = setup([undefined], clock)
    const memory = compactingMemory({ keepRecentTokens: 300, anchors: 1 }).start(runInfo(), ctx)
    for (let i = 0; i < 3; i++) {
      expect(await memory.recall(memoryState())).toEqual({ history, transcript })
    }
    expect(requests).toHaveLength(3)
    expect(logs).toContain('上下文压缩连续失败，冷却 60 秒')
    const cooling = await memory.recall(memoryState())
    expect(requests).toHaveLength(3)
    expect(cooling.transcript.at(-1)).toEqual({
      role: 'system',
      content: '[memory] 上下文压缩暂时不可用，请精简后续输出',
    })
    await clock.tick(60_000)
    await memory.recall(memoryState())
    expect(requests).toHaveLength(4)
  })

  it('counts a thrown summary call as a failure', async () => {
    const { ctx } = setup([])
    ctx.callModel = async () => {
      throw new Error('down')
    }
    const memory = compactingMemory({ keepRecentTokens: 300, anchors: 1 }).start(runInfo(), ctx)
    expect(await memory.recall(memoryState())).toEqual({ history, transcript })
  })

  it('AC-016 reuses the summary for the same replaced range', async () => {
    const { ctx, requests } = setup(['cached'])
    const memory = compactingMemory({ keepRecentTokens: 300, anchors: 1 }).start(runInfo(), ctx)
    await memory.recall(memoryState())
    const again = await memory.recall(memoryState())
    expect(requests).toHaveLength(1)
    expect(again.compaction?.summary).toBe('cached')
  })

  describe('incremental compaction over a long run', () => {
    const pair = (i: number, size: number): ModelMessage[] => [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 't', input: { i } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: `c${i}`, toolName: 't', output: 'x'.repeat(size) },
        ],
      },
    ]
    /** 按 JSON 字符数估算 token。 */
    const chars = (messages: ModelMessage[]) => JSON.stringify(messages).length

    async function longRun(steps: number, contextLimit = 4000) {
      const requests: string[] = []
      const ctx = {
        clock: new FakeClock(),
        log: () => {},
        callModel: async (req: SideModelRequest) => {
          requests.push(req.messages[0]!.content as string)
          return {
            text: `summary${requests.length}`,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            model: 'fake:m',
          }
        },
      } as unknown as ComponentCtx
      const memory = compactingMemory({ anchors: 1 }).start(runInfo(), ctx)
      let transcript: ModelMessage[] = []
      const views: Array<{ requests: number; view: Awaited<ReturnType<typeof memory.recall>> }> = []
      for (let step = 0; step < steps; step++) {
        transcript = [...transcript, ...pair(step, 400)]
        const view = await memory.recall({
          step,
          history: [],
          transcript,
          contextLimit,
          fixedTokens: 0,
          estimate: chars,
        })
        views.push({ requests: requests.length, view })
      }
      return { requests, views }
    }

    it('folds only newly cut messages into the previous summary, with bounded input', async () => {
      const { requests, views } = await longRun(30)
      expect(requests.length).toBeGreaterThan(1)
      expect(requests.length).toBeLessThan(15)
      for (const r of requests) expect(chars([{ role: 'user', content: r }])).toBeLessThan(4000)
      for (let i = 1; i < requests.length; i++) {
        expect(requests[i]).toContain(`summary${i}`)
        expect(requests[i]).not.toContain('"i":0}')
      }
      for (const { view } of views) {
        expect(chars([...view.history, ...view.transcript])).toBeLessThan(4000)
      }
    })

    it('keeps the summary message stable between compactions', async () => {
      const { views } = await longRun(30)
      for (let i = 1; i < views.length; i++) {
        const [before, after] = [views[i - 1]!, views[i]!]
        if (after.requests === before.requests && before.view.compaction) {
          expect(after.view.history[0]).toEqual(before.view.history[0])
          expect(after.view.compaction?.summary).toBe(before.view.compaction.summary)
        }
      }
    })
  })

  it('splits an oversized prefix into summarizer calls that fit the window', async () => {
    const requests: string[] = []
    const { ctx } = setup([])
    ctx.callModel = async (req: SideModelRequest) => {
      requests.push(req.messages[0]!.content as string)
      return {
        text: `s${requests.length}`,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        model: 'fake:m',
      }
    }
    const chars = (messages: ModelMessage[]) => JSON.stringify(messages).length
    const bigHistory = [
      user('a'.repeat(3000)),
      user('b'.repeat(3000)),
      user('c'.repeat(9000)),
      user('d'.repeat(100)),
    ]
    const memory = compactingMemory({ keepRecentTokens: 300, anchors: 0 }).start(runInfo(), ctx)
    const view = await memory.recall({
      step: 1,
      history: bigHistory,
      transcript: [user('t0')],
      contextLimit: 4000,
      fixedTokens: 0,
      estimate: chars,
    })
    expect(requests.length).toBeGreaterThan(1)
    for (const r of requests)
      expect(chars([{ role: 'user', content: r }])).toBeLessThanOrEqual(2000)
    expect(requests.at(-1)).toContain(`s${requests.length - 1}`)
    expect(view.history[0]).toEqual({
      role: 'system',
      content: `【前文摘要】\ns${requests.length}`,
    })
  })

  it('returns the view unchanged when nothing can be replaced', async () => {
    const { ctx, requests } = setup(['x'])
    const memory = compactingMemory({ keepRecentTokens: 10_000 }).start(runInfo(), ctx)
    expect(await memory.recall(memoryState())).toEqual({ history, transcript })
    expect(requests).toHaveLength(0)
  })
})
