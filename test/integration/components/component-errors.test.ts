// 组件返回值不合格时按设计 §4.4 降级：守卫没有意见、验收通过、记忆沿用完整视图、工具呈现全部可见、须知跳过。

import { describe, expect, it } from 'vitest'
import {
  createEngine,
  defineAgent,
  defineTask,
  fakeModel,
  fakeTool,
  modelHub,
  standardFallback,
  text,
  tools,
  type Check,
  type EngineConfig,
  type Exposure,
  type FakeReply,
  type Guard,
  type LogEntry,
  type Memory,
  type NoticeProvider,
  type RunResult,
} from '../../../src/index.js'

const sys = { role: 'system' as const, parts: [{ type: 'text' as const, text: '你是助手' }] }
const input = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: '你好' }] }]

function harness(replies: FakeReply[], patch: Partial<EngineConfig> = {}) {
  const model = fakeModel({ model: 'main', replies })
  const logs: LogEntry[] = []
  const engine = createEngine({
    services: {
      models: modelHub({ providers: [model], default: model.ref }),
      logger: { log: (e) => void logs.push(e) },
    },
    ...patch,
  })
  const warnings = () =>
    logs.filter((l) => l.level === 'warn' && l.message.includes('返回值不合格'))
  return { engine, logs, warnings }
}

const environment = (h: ReturnType<typeof harness>, notice: NoticeProvider[] = []) =>
  h.engine.environment({ name: 'e', principal: { reachable: true }, notice })

describe('component results that do not match their contract', () => {
  it.each([
    ['{}', {}],
    // null 按没有意见处理，不算不合格（见 executor/evaluate.test.ts）。
    ['warn and end together', { warn: { problem: 'p' }, end: { as: 'stop', code: 'x' } }],
    ['end without a code', { end: { as: 'stop' } }],
  ])('AC-001 treats a guard returning %s as having no opinion', async (_label, opinion) => {
    const h = harness([{ text: '答案' }])
    const bad: Guard = {
      id: 'bad',
      version: '1',
      start: () => ({ check: () => opinion as never }),
    }
    const result = await environment(h).start(
      defineAgent({ id: 'a', instructions: [sys] }),
      defineTask({ input, guards: [bad] }),
    ).result
    expect(result).toMatchObject({ status: 'completed', text: '答案' })
    expect(h.warnings()).toEqual([expect.objectContaining({ source: 'task:bad' })])
  })

  it('AC-002 stops when a guard with onError stop returns a malformed opinion', async () => {
    const h = harness([{ text: '答案' }])
    const bad: Guard = {
      id: 'bad',
      version: '1',
      onError: 'stop',
      start: () => ({ check: () => ({}) as never }),
    }
    const result = await environment(h).start(
      defineAgent({ id: 'a', instructions: [sys] }),
      defineTask({ input, guards: [bad] }),
    ).result
    expect(result).toMatchObject({ status: 'stopped', code: 'guard_error:bad' })
  })

  it.each([
    ['null', null],
    ['{}', {}],
    ['a non-boolean pass', { pass: 'yes' }],
  ])('AC-003 passes a gate check returning %s', async (_label, value) => {
    const h = harness([{ text: '答案' }, { text: '答案' }])
    const check: Check = {
      id: 'bad',
      version: '1',
      mode: 'gate',
      start: () => ({ accept: async () => value as never }),
    }
    const result = await environment(h).start(
      defineAgent({ id: 'a', instructions: [sys] }),
      defineTask({
        input,
        deliverable: { output: text(), checks: [check], fallback: standardFallback() },
      }),
    ).result
    expect(result).toMatchObject({ status: 'completed', text: '答案' })
    expect(h.warnings()).toEqual([expect.objectContaining({ source: 'check:bad' })])
  })

  it.each([
    ['null', null],
    ['{}', {}],
    ['a transcript that is not a list', { history: [], transcript: 'x' }],
  ])('AC-004 keeps the full view when memory returns %s', async (_label, view) => {
    const memory: Memory = {
      id: 'bad',
      version: '1',
      start: () => ({ recall: async () => view as never }),
    }
    const h = harness([{ text: '答案' }], { memory })
    const result = await environment(h).start(
      defineAgent({ id: 'a', instructions: [sys] }),
      defineTask({ input }),
    ).result
    expect(result).toMatchObject({ status: 'completed', text: '答案' })
    expect(h.warnings()).toHaveLength(1)
  })

  it('AC-004 still fails the run when memory breaks tool pairs', async () => {
    const memory: Memory = {
      id: 'drops-results',
      version: '1',
      start: () => ({
        recall: async (s) => ({
          history: s.history,
          transcript: s.transcript.filter((m) => m.role !== 'tool'),
        }),
      }),
    }
    const lookup = fakeTool({ name: 'lookup', result: '数据' })
    const h = harness(
      [{ toolCalls: [{ id: 'c1', name: 'lookup', input: {} }] }, { text: '答案' }],
      { memory },
    )
    const result: RunResult = await environment(h).start(
      defineAgent({ id: 'a', instructions: [sys], capabilities: [tools([lookup])] }),
      defineTask({ input }),
    ).result
    expect(result).toMatchObject({ status: 'failed', code: 'engine_error' })
  })

  it.each([
    ['null', null],
    ['a string', 't'],
    ['a list with a number', [1]],
  ])('AC-005 shows every tool when exposure returns %s', async (_label, visible) => {
    const lookup = fakeTool({ name: 'lookup', result: '数据' })
    const exposure: Exposure = {
      id: 'bad',
      version: '1',
      start: () => ({ visible: () => visible as never }),
    }
    const h = harness([{ toolCalls: [{ id: 'c1', name: 'lookup', input: {} }] }, { text: '答案' }])
    const result = await environment(h).start(
      defineAgent({
        id: 'a',
        instructions: [sys],
        capabilities: [tools([lookup])],
        toolbox: { exposure },
      }),
      defineTask({ input }),
    ).result
    expect(result).toMatchObject({ status: 'completed' })
    expect(lookup.calls).toHaveLength(1)
    expect(h.warnings().length).toBeGreaterThan(0)
  })

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a segment without parts', [{ role: 'user' }]],
  ])('AC-006 skips a notice provider returning %s', async (_label, value) => {
    const h = harness([{ text: '答案' }])
    const provider: NoticeProvider = {
      id: 'bad',
      version: '1',
      provide: async () => value as never,
    }
    const result = await environment(h, [provider]).start(
      defineAgent({ id: 'a', instructions: [sys] }),
      defineTask({ input }),
    ).result
    expect(result).toMatchObject({ status: 'completed', text: '答案' })
    expect(h.warnings()).toEqual([
      expect.objectContaining({ message: expect.stringContaining('bad') }),
    ])
  })

  it('AC-006 still blocks the run when a notice provider returns { block }', async () => {
    const h = harness([{ text: '答案' }])
    const provider: NoticeProvider = {
      id: 'gate',
      version: '1',
      provide: async () => ({ block: '不允许' }),
    }
    const result = await environment(h, [provider]).start(
      defineAgent({ id: 'a', instructions: [sys] }),
      defineTask({ input }),
    ).result
    expect(result).toMatchObject({ status: 'stopped', code: 'notice_blocked' })
  })
})
