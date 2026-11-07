import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../../contracts/common.js'
import type { ComponentCtx, MemoryState } from '../../contracts/component.js'
import type { SideModelRequest } from '../../contracts/model.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { runInfo } from '../capabilities/prepare.fixture.js'
import { renderView, summaryMessage } from '../../sdk.js'
import { compactingMemory, cutIndex, snapToTurn } from './compacting-memory.js'

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
  inputLimit: 1000,
  fixedTokens: 0,
  estimate,
  turnStarts: [],
  ...patch,
})

function setup(answers: Array<string | undefined>, clock = new FakeClock()) {
  const requests: SideModelRequest[] = []
  const logs: string[] = []
  const ctx = {
    clock,
    modelLimits: () => undefined,
    log: (_l: string, m: string) => logs.push(m),
    callModel: async (req: SideModelRequest) => {
      requests.push(req)
      const text = answers.length > 1 ? answers.shift() : answers[0]
      return text === undefined
        ? undefined
        : {
            text,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            model: 'fake:m',
            finishReason: 'stop' as const,
          }
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

  it('counts the kept exchanges only in the current turn', () => {
    // 以前各轮里的工具交换不让切点后退：本轮还没有工具交换时，按保留量切。
    const earlier = [callMsg('h1'), result('h1'), user('q'), user('a')]
    expect(cutIndex(earlier, estimate, 100, 1)).toBe(0)
    expect(cutIndex(earlier, estimate, 100, 1, earlier.length)).toBe(3)
  })
})

describe('snapToTurn', () => {
  it('moves a cut inside an earlier turn to the start of the next turn', () => {
    expect(snapToTurn(3, 6, [0, 2, 4])).toBe(4)
    expect(snapToTurn(2, 6, [0, 2, 4])).toBe(2)
  })

  it('leaves a cut inside the latest turn or in the transcript where it is', () => {
    expect(snapToTurn(5, 6, [0, 2, 4])).toBe(5)
    expect(snapToTurn(7, 6, [0, 2, 4])).toBe(7)
    expect(snapToTurn(3, 6, [])).toBe(3)
  })
})

describe('compactingMemory', () => {
  it('identifies itself with its configuration', () => {
    expect(compactingMemory({ trigger: 0.7 })).toMatchObject({
      id: 'compacting',
      version: '2',
      config: {
        trigger: 0.7,
        turnStart: 0.5,
        keepRatio: 0.1,
        keepRecentTokens: null,
        summaryRatio: 0.1,
        maxHistoryTokens: null,
        anchors: 1,
        model: null,
      },
    })
  })

  it('AC-012 compacts nothing below the trigger', async () => {
    const { ctx, requests } = setup(['summary'])
    const memory = compactingMemory().start(runInfo(), ctx)
    expect(await memory.recall(memoryState({ contextLimit: 2000, inputLimit: 2000 }))).toEqual({})
    expect(requests).toHaveLength(0)
  })

  it('AC-013 replaces the older part with a structured summary', async () => {
    const { ctx, requests } = setup(['intent: analyse'])
    const memory = compactingMemory({ keepRecentTokens: 300, model: 'fake:small' }).start(
      runInfo(),
      ctx,
    )
    const view = await memory.recall(memoryState())
    expect(view).toEqual({ compaction: { upTo: 7, summary: 'intent: analyse' } })
    expect(renderView(history, transcript, view.compaction)).toEqual({
      history: [summaryMessage('intent: analyse')],
      transcript: transcript.slice(5),
    })
    expect(requests[0]).toMatchObject({
      purpose: 'memory:compaction',
      model: 'fake:small',
      maxOutputTokens: 256,
    })
    expect(requests[0]!.system).toContain('未完成的动作')
    expect(requests[0]!.system).toContain('不超过 256 个 token')
    const serialized = requests[0]!.messages[0]!.content as string
    expect(serialized).toContain('调用 search({"q":"c1"})')
    expect(serialized).toContain('结果 search: out c1')
  })

  it('AC-010 renders images and files with where they came from', async () => {
    const { ctx, requests } = setup(['summary'])
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    const media: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这些' },
          { type: 'image', image: 'AQID' },
          { type: 'file', data: 'JVBER', mediaType: 'application/pdf', filename: 'c.pdf' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'shot', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'shot',
            output: '截好了',
            images: [
              { type: 'image', image: 'AQID' },
              { type: 'image', image: 'BAUG' },
            ],
          },
        ],
      },
    ]
    await memory.recall(memoryState({ history: media }))
    const serialized = requests[0]!.messages[0]!.content as string
    expect(serialized).toContain('user: 看看这些\n[图片]\n[文件 c.pdf（application/pdf）]')
    expect(serialized).toContain('结果 shot: 截好了\n[工具 shot（调用 c1）返回的图片 2 张]')
  })

  it('AC-012 measures the trigger against the available space', async () => {
    const { ctx, requests } = setup(['s'])
    const memory = compactingMemory({ trigger: 0.8 }).start(runInfo(), ctx)
    // 10 条消息 = 1000 token：窗口 2000、输入上限 2000 时不压缩；固定占用 800 后可用空间只剩 1200。
    expect(await memory.recall(memoryState({ contextLimit: 2000, inputLimit: 2000 }))).toEqual({})
    const view = await memory.recall(
      memoryState({ contextLimit: 2000, inputLimit: 2000, fixedTokens: 800 }),
    )
    expect(view.compaction).toBeDefined()
    expect(requests).toHaveLength(1)
  })

  it('keeps the tail of a long history', async () => {
    const { ctx } = setup(['older'])
    const longHistory = [user('h0'), user('h1'), user('h2'), user('h3'), user('h4'), user('h5')]
    const memory = compactingMemory({ keepRecentTokens: 300, anchors: 0 }).start(runInfo(), ctx)
    const state = memoryState({
      history: longHistory,
      transcript: [user('t0')],
      contextLimit: 800,
      inputLimit: 800,
    })
    const view = await memory.recall(state)
    expect(view.compaction).toEqual({ upTo: 4, summary: 'older' })
    expect(renderView(state.history, state.transcript, view.compaction)).toEqual({
      history: [summaryMessage('older'), user('h4'), user('h5')],
      transcript: [user('t0')],
    })
  })

  describe('the first step of a session turn', () => {
    // 三轮前文，每条 100 token；可用空间 1000，轮开始线 500。
    const turns = [user('q1'), user('a1'), user('q2'), user('a2'), user('q3'), user('a3')]
    const first = (patch: Partial<MemoryState> = {}) =>
      memoryState({ step: 1, history: turns, transcript: [], turnStarts: [0, 2, 4], ...patch })

    it('compacts a carried window above the turn-start line, cutting between turns', async () => {
      const { ctx, requests } = setup(['older turns'])
      const memory = compactingMemory({ keepRecentTokens: 350 }).start(runInfo(), ctx)
      // 保留 350 token 会切在第 2 轮中间，顺延到第 3 轮的起点。
      expect(await memory.recall(first())).toEqual({
        compaction: { upTo: 4, summary: 'older turns' },
      })
      expect(requests[0]!.messages[0]!.content).toContain('a2')
    })

    it('leaves a carried window below the turn-start line alone', async () => {
      const { ctx, requests } = setup(['x'])
      const memory = compactingMemory().start(runInfo(), ctx)
      expect(await memory.recall(first({ history: turns.slice(2), turnStarts: [0, 2] }))).toEqual(
        {},
      )
      expect(requests).toHaveLength(0)
    })

    it('enforces the cost ceiling on a big window', async () => {
      const { ctx } = setup(['s'])
      const memory = compactingMemory({ maxHistoryTokens: 200 }).start(runInfo(), ctx)
      const view = await memory.recall(
        first({ history: turns.slice(2), turnStarts: [0, 2], inputLimit: 100_000 }),
      )
      expect(view.compaction).toBeDefined()
    })

    it('merges into the carried summary instead of summarizing it again', async () => {
      const { ctx, requests } = setup(['merged'])
      const memory = compactingMemory({ keepRecentTokens: 250 }).start(runInfo(), ctx)
      const carried = [summaryMessage('s0'), ...turns.slice(2)]
      const state = first({ history: carried, summary: 's0', turnStarts: [1, 3] })
      // 前文 500 token，没有超过 500：不压缩，也不重复声明带入的摘要。
      expect(await memory.recall(state)).toEqual({})
      const tight = compactingMemory({ keepRecentTokens: 250 }).start(runInfo(), ctx)
      expect(await tight.recall({ ...state, inputLimit: 800 })).toEqual({
        compaction: { upTo: 3, summary: 'merged' },
      })
      const content = requests[0]!.messages[0]!.content as string
      expect(content).toContain('【已有摘要】\ns0')
      expect(content).toContain('q2')
      expect(content).not.toContain('前文摘要')
    })
  })

  it('§8 asks for a shorter summary once when the first one is cut off', async () => {
    const { ctx, requests } = setup([])
    const replies = ['too long', 'short']
    ctx.callModel = async (req: SideModelRequest) => {
      requests.push(req)
      const text = replies.shift()!
      return {
        text,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        model: 'fake:m',
        finishReason: text === 'too long' ? 'length' : 'stop',
      }
    }
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    expect(await memory.recall(memoryState())).toEqual({
      compaction: { upTo: 7, summary: 'short' },
    })
    expect(requests).toHaveLength(2)
    expect(requests[1]!.system).toContain('上一次输出超出了长度')
  })

  it('§8 counts a summary that is still cut off as a failure', async () => {
    const { ctx, requests } = setup([])
    ctx.callModel = async (req: SideModelRequest) => {
      requests.push(req)
      return {
        text: 'too long',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        model: 'fake:m',
        finishReason: 'length',
      }
    }
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    expect(await memory.recall(memoryState())).toEqual({})
    expect(requests).toHaveLength(2)
  })

  it('caps the summary at the summary model output limit', async () => {
    const { ctx, requests } = setup(['s'])
    ctx.modelLimits = () => ({ contextLimit: 100_000, maxOutputTokens: 200 })
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    await memory.recall(memoryState())
    expect(requests[0]).toMatchObject({ maxOutputTokens: 200 })
  })

  it('AC-008 starts no second summary while the first one is still running', async () => {
    const { ctx } = setup([])
    const requests: SideModelRequest[] = []
    let finish!: (text: string) => void
    ctx.callModel = (req: SideModelRequest) => {
      requests.push(req)
      return new Promise((resolve) => {
        finish = (text) =>
          resolve({
            text,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            model: 'fake:m',
            finishReason: 'stop',
          })
      })
    }
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    const slow = memory.recall(memoryState())
    // 引擎等不及（记忆超时）就进入下一步：这一步不再发起摘要。
    expect(await memory.recall(memoryState())).toEqual({})
    expect(requests).toHaveLength(1)
    finish('s')
    expect(await slow).toEqual({ compaction: { upTo: 7, summary: 's' } })
    expect(await memory.recall(memoryState())).toEqual({ compaction: { upTo: 7, summary: 's' } })
    expect(requests).toHaveLength(1)
  })

  it('AC-009 keeps input plus output of a summary request inside the summary model window', async () => {
    const { ctx, requests } = setup(['s'])
    ctx.modelLimits = () => ({ contextLimit: 2000, maxOutputTokens: 1500 })
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    // 200 条前文 = 20000 token，可用空间 20000：摘要上限按比例是 2000，摘要模型窗口只剩 1000 给输出。
    const long = Array.from({ length: 200 }, (_, i) => user(`h${i}`))
    await memory.recall(memoryState({ history: long, contextLimit: 100_000, inputLimit: 20_000 }))
    expect(requests[0]!.maxOutputTokens).toBe(1000)
  })

  it.each([
    ['at the turn-start line', 90, {}],
    ['above the turn-start line', 91, { compacts: true }],
  ])(
    'AC-019 uses the lines of a 32k window with 8k output and 6k fixed: %s',
    async (_name, n, expected) => {
      // 窗口 32k、输出预留 8k：输入上限 24k，可用空间 18k，轮开始线 9k，保留线 1.8k。
      const { ctx } = setup(['s'])
      const memory = compactingMemory().start(runInfo(), ctx)
      const history = Array.from({ length: n }, (_, i) => user(`h${i}`))
      const view = await memory.recall(
        memoryState({
          step: 1,
          history,
          transcript: [],
          contextLimit: 32_000,
          inputLimit: 24_000,
          fixedTokens: 6_000,
        }),
      )
      if ('compacts' in expected) {
        // 保留线 1.8k：每条 100 token，留下最近 18 条。
        expect(view.compaction).toEqual({ upTo: n - 18, summary: 's' })
      } else expect(view).toEqual({})
    },
  )

  it('AC-015 cools down for 60 seconds after three failed summaries', async () => {
    const clock = new FakeClock()
    const { ctx, requests, logs } = setup([undefined], clock)
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    for (let i = 0; i < 3; i++) expect(await memory.recall(memoryState())).toEqual({})
    expect(requests).toHaveLength(3)
    expect(logs).toContain('上下文压缩连续失败，冷却 60 秒')
    expect(await memory.recall(memoryState())).toEqual({
      notice: '[memory] 上下文压缩暂时不可用，请精简后续输出',
    })
    expect(requests).toHaveLength(3)
    await clock.tick(60_000)
    await memory.recall(memoryState())
    expect(requests).toHaveLength(4)
  })

  it('counts a thrown summary call as a failure', async () => {
    const { ctx } = setup([])
    ctx.callModel = async () => {
      throw new Error('down')
    }
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    expect(await memory.recall(memoryState())).toEqual({})
  })

  it('AC-016 reuses the summary for the same replaced range', async () => {
    const { ctx, requests } = setup(['cached'])
    const memory = compactingMemory({ keepRecentTokens: 300 }).start(runInfo(), ctx)
    await memory.recall(memoryState())
    const again = await memory.recall(memoryState())
    expect(requests).toHaveLength(1)
    expect(again.compaction).toEqual({ upTo: 7, summary: 'cached' })
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
        modelLimits: () => undefined,
        log: () => {},
        callModel: async (req: SideModelRequest) => {
          requests.push(req.messages[0]!.content as string)
          return {
            text: `summary${requests.length}`,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            model: 'fake:m',
            finishReason: 'stop',
          }
        },
      } as unknown as ComponentCtx
      const memory = compactingMemory().start(runInfo(), ctx)
      let transcript: ModelMessage[] = []
      const views: Array<{
        requests: number
        view: ReturnType<typeof renderView>
        summary?: string
      }> = []
      for (let step = 0; step < steps; step++) {
        transcript = [...transcript, ...pair(step, 400)]
        const decision = await memory.recall({
          step,
          history: [],
          transcript,
          contextLimit,
          inputLimit: contextLimit,
          fixedTokens: 0,
          estimate: chars,
          turnStarts: [],
        })
        views.push({
          requests: requests.length,
          view: renderView([], transcript, decision.compaction),
          ...(decision.compaction ? { summary: decision.compaction.summary } : {}),
        })
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

    it('keeps the summary stable between compactions', async () => {
      const { views } = await longRun(30)
      for (let i = 1; i < views.length; i++) {
        const [before, after] = [views[i - 1]!, views[i]!]
        if (after.requests === before.requests && before.summary) {
          expect(after.view.history[0]).toEqual(before.view.history[0])
          expect(after.summary).toBe(before.summary)
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
        finishReason: 'stop',
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
      inputLimit: 4000,
      fixedTokens: 0,
      estimate: chars,
      turnStarts: [],
    })
    expect(requests.length).toBeGreaterThan(1)
    for (const r of requests)
      expect(chars([{ role: 'user', content: r }])).toBeLessThanOrEqual(2000)
    expect(requests.at(-1)).toContain(`s${requests.length - 1}`)
    expect(view.compaction?.summary).toBe(`s${requests.length}`)
  })

  it('chunks by the smaller window when the summary goes to another model', async () => {
    const requests: string[] = []
    const { ctx } = setup([])
    ctx.callModel = async (req: SideModelRequest) => {
      requests.push(req.messages[0]!.content as string)
      return {
        text: `s${requests.length}`,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        model: 'fake:small',
        finishReason: 'stop',
      }
    }
    ctx.modelLimits = (ref) =>
      ref === 'fake:small' ? { contextLimit: 2000, maxOutputTokens: 500 } : undefined
    const chars = (messages: ModelMessage[]) => JSON.stringify(messages).length
    const bigHistory = [user('a'.repeat(1500)), user('b'.repeat(1500)), user('c'.repeat(100))]
    const memory = compactingMemory({
      keepRecentTokens: 300,
      anchors: 0,
      model: 'fake:small',
    }).start(runInfo(), ctx)
    await memory.recall({
      step: 1,
      history: bigHistory,
      transcript: [user('t0')],
      contextLimit: 4000,
      inputLimit: 4000,
      fixedTokens: 0,
      estimate: chars,
      turnStarts: [],
    })
    expect(requests.length).toBeGreaterThan(1)
    for (const r of requests)
      expect(chars([{ role: 'user', content: r }])).toBeLessThanOrEqual(1000)
  })

  it('compacts nothing when nothing can be replaced', async () => {
    const { ctx, requests } = setup(['x'])
    const memory = compactingMemory({ keepRecentTokens: 10_000 }).start(runInfo(), ctx)
    expect(await memory.recall(memoryState())).toEqual({})
    expect(requests).toHaveLength(0)
  })
})
