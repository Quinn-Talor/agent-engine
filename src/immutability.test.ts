// 业务对象与日志事件不可变（设计 §1.1、I14、§4.4）：创建后改动传入的原对象不影响运行，冻结的对象改不了。

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createEngine,
  defineAgent,
  defineTask,
  fakeModel,
  fakeTool,
  memoryArchive,
  modelHub,
  strictReplay,
  structured,
  tools,
  type Capability,
  type FakeReply,
  type Guard,
  type LogEntry,
  type Notice,
  type PermissionRule,
  type RunEvent,
  type Segment,
} from './index.js'

const sys = (text: string): Segment => ({ role: 'system', parts: [{ type: 'text', text }] })
const user = (text: string): Segment => ({ role: 'user', parts: [{ type: 'text', text }] })
const denyAll: PermissionRule = {
  id: 'deny-all',
  version: '1',
  permit: async () => ({ deny: '后加的规则' }),
}
/** 等待输入排在完成之前：生效时运行以 awaiting_input 结束，可以直接观察到。 */
const askNow: Guard = {
  id: 'ask-now',
  version: '1',
  start: () => ({ check: () => ({ awaitInput: { code: 'late_guard' } }) }),
}

function harness(replies: FakeReply[], guards?: Guard[]) {
  const model = fakeModel({ model: 'main', replies })
  const archive = memoryArchive()
  const logs: LogEntry[] = []
  const engine = createEngine({
    services: {
      models: modelHub({ providers: [model], default: model.ref }),
      archive,
      logger: { log: (e) => void logs.push(e) },
    },
    ...(guards ? { guards } : {}),
  })
  return { engine, archive, logs }
}
const writeCall: FakeReply = { toolCalls: [{ id: 'w1', name: 'write', input: { p: 1 } }] }

describe('immutability', () => {
  it('AC-007 isolates an environment from later changes to its config', async () => {
    const write = fakeTool({ name: 'write', effect: 'side_effect', result: '已写' })
    const h = harness([writeCall, { text: '完成' }])
    const permissions: PermissionRule[] = []
    const caps = { toolConcurrency: 5 }
    const env = h.engine.environment({
      name: 'e',
      principal: { reachable: true },
      permissions,
      caps,
    })
    const fingerprint = env.fingerprint
    permissions.push(denyAll)
    caps.toolConcurrency = 1

    const result = await env.start(
      defineAgent({ id: 'a', instructions: [sys('x')], capabilities: [tools([write])] }),
      defineTask({ input: [user('写')] }),
    ).result
    expect(result.status).toBe('completed')
    expect(write.calls).toHaveLength(1)
    expect(env.fingerprint).toBe(fingerprint)
  })

  it('AC-008 isolates an agent and a task from later changes and freezes them', async () => {
    const write = fakeTool({ name: 'write', effect: 'side_effect', result: '已写' })
    const instructions = [sys('你是助手')]
    const capabilities: Capability[] = []
    const agent = defineAgent({ id: 'a', instructions, capabilities })
    const input = [user('你好')]
    const history = [{ role: 'user' as const, content: '之前的问题' }]
    const guards: Guard[] = []
    const budget = { maxSteps: 5 }
    const task = defineTask({ input, history, guards, budget })
    const fingerprints = [agent.fingerprint, task.fingerprint]

    instructions.push(sys('额外的指令'))
    capabilities.push(tools([write]))
    input.push(user('追加'))
    history.push({ role: 'user', content: '追加' })
    guards.push(askNow)
    budget.maxSteps = 1

    expect(agent.instructions).toHaveLength(1)
    expect(agent.capabilities).toEqual([])
    expect(task.input).toHaveLength(1)
    expect(task.history).toHaveLength(1)
    expect(task.guards).toEqual([])
    expect(task.budget).toEqual({ maxSteps: 5 })
    expect([agent.fingerprint, task.fingerprint]).toEqual(fingerprints)
    expect(() => (agent.capabilities as Capability[]).push(tools([write]))).toThrow(TypeError)
    expect(() => (task.input as Segment[]).push(user('x'))).toThrow(TypeError)
    expect(() => {
      ;(task.budget as { maxSteps: number }).maxSteps = 9
    }).toThrow(TypeError)

    const h = harness([{ text: '完成' }])
    const result = await h.engine
      .environment({ name: 'e', principal: { reachable: true } })
      .start(agent, task).result
    expect(result.status).toBe('completed')
  })

  it('AC-009 isolates an engine from later changes to its guards', async () => {
    const guards: Guard[] = []
    const h = harness([{ text: '完成' }], guards)
    const fingerprint = h.engine.fingerprint
    guards.push(askNow)
    const result = await h.engine
      .environment({ name: 'e', principal: { reachable: true } })
      .start(
        defineAgent({ id: 'a', instructions: [sys('x')] }),
        defineTask({ input: [user('hi')] }),
      ).result
    expect(result.status).toBe('completed')
    expect(h.engine.fingerprint).toBe(fingerprint)
  })

  it('AC-011 keeps the log intact when a subscriber tries to change events', async () => {
    const h = harness([{ text: '完成' }])
    const run = h.engine
      .environment({ name: 'e', principal: { reachable: true } })
      .start(
        defineAgent({ id: 'a', instructions: [sys('x')] }),
        defineTask({ input: [user('hi')] }),
      )
    const thrown: unknown[] = []
    run.subscribe({
      onEvent: (e) => {
        try {
          ;(e as { t: string }).t = 'tampered'
        } catch (error) {
          thrown.push(error)
        }
        if (e.t === 'model_responded') {
          ;(e.response as { text: string }).text = '篡改'
        }
      },
    })
    const result = await run.result
    expect(result).toMatchObject({ status: 'completed', text: '完成' })
    expect(thrown.length).toBeGreaterThan(0)
    expect(thrown.every((e) => e instanceof TypeError)).toBe(true)

    const events: RunEvent[] = []
    for await (const e of h.archive.read(run.runId)) events.push(e)
    expect(events.some((e) => (e.t as string) === 'tampered')).toBe(false)
    const responded = events.find((e) => e.t === 'model_responded')
    expect(responded).toMatchObject({ response: { text: '完成' } })
    expect(strictReplay(events).violations).toEqual([])
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('订阅者'))).toBe(true)
  })

  it('AC-011 hands callers a mutable result and output although the log is frozen', async () => {
    const h = harness([{ toolCalls: [{ id: 's1', name: 'submit', input: { meta: { n: 1 } } }] }])
    const agent = defineAgent({
      id: 'a',
      instructions: [sys('x')],
      // z.unknown() 原样交回输入里的子对象：没有复制时它就是日志里冻结的那一个。
      deliverable: { output: structured(z.object({ meta: z.unknown() })), checks: [] },
    })
    const run = h.engine
      .environment({ name: 'e', principal: { reachable: true } })
      .start(agent, defineTask({ input: [user('提交')] }))
    const notices: Notice[] = []
    run.subscribe({ onNotice: (n) => void notices.push(n) })
    const result = await run.result
    expect(result).toMatchObject({ status: 'completed', output: { meta: { n: 1 } } })
    const output = result.output as { meta: { n: number } }
    output.meta.n = 2
    expect(output.meta.n).toBe(2)
    const delivered = notices.find((n) => n.t === 'delivered')
    expect(Object.isFrozen((delivered as { output: { meta: object } }).output.meta)).toBe(false)
    expect(result.usage).toBeDefined()
    expect(Object.isFrozen(result.usage)).toBe(false)
  })
})
