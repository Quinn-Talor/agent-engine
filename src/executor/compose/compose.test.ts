import { describe, expect, it } from 'vitest'
import type { Segment } from '../../contracts/common.js'
import type { MemoryState, MemoryView, ToolboxState } from '../../contracts/component.js'
import type { RunEventBody } from '../../contracts/events.js'
import { estimateMessages, estimateTools } from '../../core/run/estimate.js'
import {
  contextBuilt,
  evaluated,
  modelResponded,
  runStarted,
  sequence,
  stepEnded,
  stepStarted,
  type EventBody,
} from '../../core/log/events.fixture.js'
import { canonicalJson } from '../../core/definition/hash.js'
import { summaryMessage } from '../../core/run/layout.js'
import { apply, initial, type RunState } from '../../core/run/state.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { fakeTool } from '../../testing/fake-tool.js'
import { createComposer, unavailableSegment, type ComposeDeps } from './compose.js'
import { prepareTool, type PreparedTool } from '../act/tools.js'

const sys = (text: string): Segment => ({ role: 'system', parts: [{ type: 'text', text }] })
const user = (text: string): Segment => ({ role: 'user', parts: [{ type: 'text', text }] })
const passthrough = { recall: async (_s: MemoryState): Promise<MemoryView> => ({}) }
const fold = (bodies: EventBody[]): RunState =>
  sequence(bodies).reduce(apply, initial({ runId: 'r1' }))

function setup(patch: Partial<ComposeDeps> = {}) {
  const blobs = new Map<string, string>()
  const logs: string[] = []
  const toolset = new Map<string, PreparedTool>(
    ['search', 'fetch', 'search_tool'].map((name) => [
      name,
      prepareTool(fakeTool({ name }), 'cap'),
    ]),
  )
  const deps: ComposeDeps = {
    run: {
      runId: 'r1',
      rootRunId: 'r1',
      environment: { name: 'env', principalReachable: true, approver: false },
      agent: { id: 'a' },
      task: {},
      model: { ref: 'fake:m', contextLimit: 10_000 },
    },
    clock: new FakeClock(5_000),
    notice: [sys('notice')],
    instructions: [sys('instructions')],
    capabilities: [sys('capabilities')],
    task: {
      input: [user('input')],
      history: [{ role: 'user', content: 'earlier' }],
      volatile: [sys('today')],
    },
    unavailable: [{ capability: 'crm', reason: '连接超时' }],
    toolset,
    exposureOf: new Map([['fetch', 'deferred']]),
    memory: passthrough,
    getBlob: async (ref) => `body ${ref}`,
    putBlob: async (data) => {
      const ref = `sha256:${String(blobs.size).padStart(64, '0')}`
      blobs.set(ref, data)
      return ref
    },
    log: (_level, message) => logs.push(message),
    outputReserve: 0,
    ...patch,
  }
  return { deps, blobs, logs, composer: createComposer(deps) }
}

const texts = (messages: { content: unknown }[]) =>
  messages.map((m) =>
    typeof m.content === 'string' ? m.content : (m.content as { text?: string }[])[0]?.text,
  )
const contextOf = (events: RunEventBody[]) =>
  events.find((e): e is Extract<RunEventBody, { t: 'context_built' }> => e.t === 'context_built')!

describe('createComposer', () => {
  it('AC-003 lays out the view and puts volatile info and unavailable capabilities in the tail', async () => {
    const s = setup()
    const { input, events, visible } = await s.composer.compose(fold([runStarted()]))
    expect(texts(input.messages)).toEqual([
      'notice',
      'instructions',
      'capabilities',
      'earlier',
      'input',
      'today',
      '以下能力本次不可用：\n- crm：连接超时',
    ])
    expect([...visible]).toEqual(['search', 'fetch', 'search_tool'])
    expect(events.map((e) => e.t)).toEqual(['step_started', 'context_built'])
    const built = contextOf(events)
    expect(built).toMatchObject({ step: 1, tools: ['search', 'fetch', 'search_tool'] })
    expect(built.messages).toHaveLength(7)
    expect(s.blobs.get(built.messages[0]!)).toBe(canonicalJson(input.messages[0]))
  })

  it('AC-001 applies pending interventions and the steer in one effect', async () => {
    const s = setup({
      unavailable: [],
      task: { input: [user('input')], history: [], volatile: [] },
    })
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1),
      modelResponded(1, { text: 'thinking' }),
      evaluated(1, {
        continue: { interventions: [{ hint: { text: 'verify' } }] },
        sources: ['rule:r'],
      }),
      { t: 'steer_received', text: 'focus' },
      stepEnded(1),
    ])
    const { events, input } = await s.composer.compose(state)
    expect(events.map((e) => e.t)).toEqual([
      'step_started',
      'intervention_applied',
      'context_built',
    ])
    expect(input.messages.slice(-2)).toEqual([
      { role: 'system', content: '[rule:r] verify' },
      { role: 'user', content: 'focus' },
    ])
  })

  it('AC-004 renders the declared compaction and records it with a summary blob', async () => {
    const s = setup({
      memory: { recall: async () => ({ compaction: { upTo: 1, summary: 'what happened' } }) },
    })
    const { events, input } = await s.composer.compose(fold([runStarted()]))
    const built = contextOf(events)
    expect(built.compaction).toMatchObject({
      upTo: 1,
      reason: 'turn_start',
    })
    expect(built.compaction!.tokens!.after).toBeLessThan(built.compaction!.tokens!.before + 20)
    expect(s.blobs.get(built.compaction!.summary)).toBe('what happened')
    expect(input.messages).toContainEqual(summaryMessage('what happened'))
    expect(input.messages).not.toContainEqual({ role: 'user', content: 'earlier' })
  })

  it('§14 writes the compaction every step, the reason only when it changes', async () => {
    let summary = 'v1'
    const s = setup({ memory: { recall: async () => ({ compaction: { upTo: 1, summary } }) } })
    const step = async (n: number) => {
      const bodies: EventBody[] = [runStarted()]
      for (let i = 1; i < n; i++)
        bodies.push(
          stepStarted(i),
          contextBuilt(i),
          modelResponded(i, { text: 'x' }),
          evaluated(i, { continue: { interventions: [] }, sources: [] }),
          stepEnded(i),
        )
      return contextOf((await s.composer.compose(fold(bodies))).events).compaction
    }
    expect(await step(1)).toMatchObject({ reason: 'turn_start' })
    const same = await step(2)
    expect(same).toMatchObject({ upTo: 1 })
    expect(same).not.toHaveProperty('replaced')
    expect(same).not.toHaveProperty('reason')
    summary = 'v2'
    expect(await step(3)).toMatchObject({ reason: 'in_run' })
  })

  it('§8 puts the memory notice in the tail, not the transcript', async () => {
    const s = setup({ memory: { recall: async () => ({ notice: '[memory] 压缩暂时不可用' }) } })
    const { input } = await s.composer.compose(fold([runStarted()]))
    expect(input.messages.at(-1)).toEqual({ role: 'system', content: '[memory] 压缩暂时不可用' })
  })

  describe('C: dropping the earliest whole turns when the view still overflows', () => {
    const long = (text: string) => ({ role: 'user' as const, content: text + '词'.repeat(300) })
    // 三轮前文，每轮两条，每条约 200 token；窗口 800、不预留输出：丢一轮仍超限，丢两轮放得下。
    const history = [long('q1'), long('a1'), long('q2'), long('a2'), long('q3'), long('a3')]
    const sessionSetup = (patch: Partial<ComposeDeps> = {}) =>
      setup({
        run: { ...setup().deps.run, model: { ref: 'fake:m', contextLimit: 800 } },
        task: { input: [user('input')], history, volatile: [] },
        unavailable: [],
        session: { turnStarts: [0, 2, 4] },
        ...patch,
      })

    it('drops turns from the front until the estimate fits, with a line saying so', async () => {
      const s = sessionSetup()
      const { events, input } = await s.composer.compose(fold([runStarted()]))
      const built = contextOf(events)
      expect(built.estimate).toBeLessThan(800)
      expect(built.compaction).toMatchObject({ upTo: 4, reason: 'overflow_drop' })
      expect(s.blobs.get(built.compaction!.summary)).toBe(
        '[更早的 2 轮对话已省略，原文保留在会话日志]',
      )
      expect(texts(input.messages).some((t) => t?.startsWith('q3'))).toBe(true)
    })

    it('keeps the carried summary in front of the line', async () => {
      const s = sessionSetup({
        task: {
          input: [user('input')],
          history: [summaryMessage('s0'), ...history.slice(2)],
          volatile: [],
        },
        session: { summary: 's0', turnStarts: [1, 3] },
      })
      const built = contextOf((await s.composer.compose(fold([runStarted()]))).events)
      expect(s.blobs.get(built.compaction!.summary)).toBe(
        's0\n\n[更早的 1 轮对话已省略，原文保留在会话日志]',
      )
    })

    it('AC-006 records no drop when even the summary alone does not fit', async () => {
      // 本轮运行记录里一条约 870 token 的回复：丢掉以前的全部轮也放不下。
      const s = sessionSetup()
      const state = fold([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { text: '长'.repeat(1300) }),
        evaluated(1, { continue: { interventions: [] }, sources: [] }),
        stepEnded(1),
      ])
      const built = contextOf((await s.composer.compose(state)).events)
      expect(built.compaction).toBeUndefined()
      expect(built.estimate).toBeGreaterThanOrEqual(800)
    })

    it('AC-005 keeps the last compaction when the memory fails afterwards', async () => {
      let fail = false
      const s = sessionSetup({
        memory: {
          recall: async () => {
            if (fail) throw new Error('summarizer down')
            return { compaction: { upTo: 6, summary: '三轮的摘要' } }
          },
        },
      })
      const first = contextOf((await s.composer.compose(fold([runStarted()]))).events)
      expect(first.compaction).toMatchObject({ upTo: 6, reason: 'turn_start' })
      fail = true
      const state = fold([
        runStarted(),
        stepStarted(1),
        contextBuilt(1),
        modelResponded(1, { text: '继续' }),
        evaluated(1, { continue: { interventions: [] }, sources: [] }),
        stepEnded(1),
      ])
      const second = contextOf((await s.composer.compose(state)).events)
      expect(second.compaction).toMatchObject({ upTo: 6 })
      expect(second.compaction).not.toHaveProperty('reason')
      expect(s.blobs.get(second.compaction!.summary)).toBe('三轮的摘要')
      expect(s.logs.some((l) => l.startsWith('记忆出错，沿用上一步的压缩'))).toBe(true)
    })

    it('leaves a run without turn boundaries to the overflow stop', async () => {
      const s = sessionSetup({ session: undefined })
      const built = contextOf((await s.composer.compose(fold([runStarted()]))).events)
      expect(built.compaction).toBeUndefined()
      expect(built.estimate).toBeGreaterThanOrEqual(800)
    })
  })

  it('passes the carried summary and the turn starts to memory', async () => {
    let seen: MemoryState | undefined
    const s = setup({
      session: { summary: 's0', turnStarts: [1] },
      memory: {
        recall: async (state) => {
          seen = state
          return {}
        },
      },
    })
    await s.composer.compose(fold([runStarted()]))
    expect(seen).toMatchObject({ summary: 's0', turnStarts: [1] })
  })

  it('passes the fixed token count and the calibrated estimator to memory', async () => {
    let seen: MemoryState | undefined
    const s = setup({
      memory: {
        recall: async (state) => {
          seen = state
          return passthrough.recall(state)
        },
      },
    })
    await s.composer.compose(fold([runStarted()]))
    expect(seen).toMatchObject({ step: 1, contextLimit: 10_000 })
    expect(seen!.fixedTokens).toBeGreaterThan(0)
    expect(seen!.estimate([{ role: 'user', content: 'abcd' }])).toBe(1)
  })

  it('AC-007 gives memory the input limit and caps the output at the reserve', async () => {
    let seen: MemoryState | undefined
    const s = setup({
      outputReserve: 2000,
      memory: {
        recall: async (state) => {
          seen = state
          return passthrough.recall(state)
        },
      },
    })
    const { input } = await s.composer.compose(fold([runStarted()]))
    expect(seen).toMatchObject({ contextLimit: 10_000, inputLimit: 8000 })
    expect(input.maxOutputTokens).toBe(2000)
  })

  it('AC-006 drops tools the exposure invented and logs it', async () => {
    let seen: ToolboxState | undefined
    const s = setup({
      exposure: {
        visible: (state) => {
          seen = state
          return ['search', 'ghost', 'search']
        },
      },
    })
    const { visible, input } = await s.composer.compose(fold([runStarted()]))
    expect([...visible]).toEqual(['search'])
    expect(input.tools.map((t) => t.name)).toEqual(['search'])
    expect(s.logs).toEqual(['工具呈现给出了不存在的工具：ghost'])
    expect(seen!.prepared).toContainEqual({
      name: 'fetch',
      capability: 'cap',
      exposure: 'deferred',
      description: 'fake tool fetch',
    })
    expect(seen!.prepared).toContainEqual({
      name: 'search',
      capability: 'cap',
      exposure: 'eager',
      description: 'fake tool search',
    })
  })

  it('F23 AC-008 keeps the order the exposure gives', async () => {
    const s = setup({
      exposure: { visible: () => ['search_tool', 'fetch', 'ghost', 'search', 'fetch'] },
    })
    const { visible, input } = await s.composer.compose(fold([runStarted()]))
    expect([...visible]).toEqual(['search_tool', 'fetch', 'search'])
    expect(input.tools.map((t) => t.name)).toEqual(['search_tool', 'fetch', 'search'])
  })

  it('AC-006 falls back to all tools when the exposure throws', async () => {
    const s = setup({
      exposure: {
        visible: () => {
          throw new Error('broken')
        },
      },
    })
    const { visible } = await s.composer.compose(fold([runStarted()]))
    expect([...visible]).toEqual(['search', 'fetch', 'search_tool'])
    expect(s.logs).toEqual(['工具呈现出错，退回全部可见'])
  })

  it('AC-007 calibrates the estimate', async () => {
    const s = setup()
    const state = fold([
      runStarted(),
      stepStarted(1),
      contextBuilt(1, 1_000),
      modelResponded(1, { usage: { input: 1_500, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      evaluated(1, { continue: { interventions: [] }, sources: ['default'] }),
      stepEnded(1),
    ])
    expect(state.calibration).toBe(1.5)
    const { input, events } = await s.composer.compose(state)
    expect(contextOf(events).estimate).toBe(
      Math.ceil((estimateMessages(input.messages) + estimateTools(input.tools)) * 1.5),
    )
  })

  it('AC-008 rejects a rewritten prefix', async () => {
    const s = setup()
    await s.composer.compose(fold([runStarted()]))
    s.deps.notice = [sys('changed notice')]
    await expect(s.composer.compose(fold([runStarted()]))).rejects.toThrow('前缀')
  })

  it('builds no unavailable segment when every capability is ready', () => {
    expect(unavailableSegment([])).toBeUndefined()
  })
})
