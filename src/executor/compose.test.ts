import { describe, expect, it } from 'vitest'
import type { Segment } from '../contracts/common.js'
import type { MemoryState, MemoryView, ToolboxState } from '../contracts/component.js'
import type { RunEventBody } from '../contracts/events.js'
import { estimateMessages, estimateTools } from '../core/estimate.js'
import {
  contextBuilt,
  evaluated,
  modelResponded,
  runStarted,
  sequence,
  stepEnded,
  stepStarted,
  type EventBody,
} from '../core/events.fixture.js'
import { canonicalJson } from '../core/hash.js'
import { apply, initial, type RunState } from '../core/state.js'
import { FakeClock } from '../testing/fake-clock.js'
import { fakeTool } from '../testing/fake-tool.js'
import { createComposer, unavailableSegment, type ComposeDeps } from './compose.js'
import { prepareTool, type PreparedTool } from './tools.js'

const sys = (text: string): Segment => ({ role: 'system', parts: [{ type: 'text', text }] })
const user = (text: string): Segment => ({ role: 'user', parts: [{ type: 'text', text }] })
const passthrough = {
  recall: async (s: MemoryState): Promise<MemoryView> => ({
    history: s.history,
    transcript: s.transcript,
  }),
}
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
      environment: { name: 'env', principalReachable: true },
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

  it('AC-004 records the compaction with a summary blob', async () => {
    const s = setup({
      memory: {
        recall: async () => ({
          history: [],
          transcript: [],
          compaction: { replaced: [0, 6], summary: 'what happened', anchorsKept: 4 },
        }),
      },
    })
    const built = contextOf((await s.composer.compose(fold([runStarted()]))).events)
    expect(built.compaction).toMatchObject({ replaced: [0, 6], anchorsKept: 4 })
    expect(s.blobs.get(built.compaction!.summary)).toBe('what happened')
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
