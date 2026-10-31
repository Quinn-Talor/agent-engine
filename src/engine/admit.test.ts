import { describe, expect, it } from 'vitest'
import type { Check, Exposure } from '../contracts/component.js'
import type { ModelCapabilities } from '../contracts/model.js'
import { fakeModel } from '../testing/fake-model.js'
import { admit, type AdmitInput } from './admit.js'
import { agentOf, defaults, fixedFallback, hubOf, taskOf, textOutput } from './engine.fixture.js'

const port = (model: string, capabilities: Partial<ModelCapabilities> = {}) =>
  fakeModel({ model, replies: [], capabilities }).port

const main = port('main')
const small = port('small', { contextLimit: 8000, vision: false, toolCalls: false })
const seeing = port('seeing', { vision: true })

const input = (patch: Partial<AdmitInput> = {}): AdmitInput => ({
  agent: agentOf(),
  task: taskOf(),
  hub: hubOf([main, small, seeing], { defaultModel: 'fake:main' }),
  defaults: defaults(),
  ...patch,
})

const structuredOutput = { ...textOutput(), id: 'json', kind: 'structured' as const }

describe('admit', () => {
  it('AC-001 resolves assignment > agent preference > inherited > default', () => {
    const agent = agentOf({ model: { prefer: 'fake:small' } })
    const pick = (patch: Partial<AdmitInput>) => {
      const r = admit(input(patch))
      return r.ok ? r.model : r.code
    }
    expect(pick({ agent, assignment: { model: 'fake:seeing' } })).toBe('fake:seeing')
    expect(pick({ agent, inherited: { model: 'fake:seeing' } })).toBe('fake:small')
    expect(pick({ inherited: { model: 'fake:seeing' } })).toBe('fake:seeing')
    expect(pick({})).toBe('fake:main')
  })

  it.each([
    ['no model at all', { hub: hubOf([main]) }, '没有可用的模型'],
    ['unknown reference', { assignment: { model: 'fake:nope' } }, '模型 fake:nope 不存在'],
    [
      'vision required',
      { agent: agentOf({ model: { requires: { vision: true } } }) },
      '不支持视觉',
    ],
    [
      'context too small',
      {
        agent: agentOf({ model: { requires: { minContext: 100_000 } } }),
        assignment: { model: 'fake:small' },
      },
      '上下文窗口',
    ],
    [
      'tool calls required',
      {
        agent: agentOf({ model: { requires: { toolCalls: true } } }),
        assignment: { model: 'fake:small' },
      },
      '不支持工具调用',
    ],
    [
      'reasoning required',
      { agent: agentOf({ model: { requires: { reasoning: true } } }) },
      '不支持推理',
    ],
    [
      'structured delivery needs tool calls',
      {
        task: taskOf({ deliverable: { output: structuredOutput } }),
        assignment: { model: 'fake:small' },
      },
      '结构化交付',
    ],
    [
      'image input without vision',
      {
        task: taskOf({
          input: [{ role: 'user', parts: [{ type: 'image', image: 'data:image/png;base64,AA' }] }],
        }),
      },
      '图片',
    ],
  ] as const)('AC-002 model_unsuitable: %s', (_name, patch, message) => {
    const r = admit(input(patch as Partial<AdmitInput>))
    expect(r).toMatchObject({ ok: false, code: 'model_unsuitable' })
    expect(!r.ok && r.message).toContain(message)
  })

  it('AC-002 accepts images on a vision model', () => {
    const task = taskOf({
      history: [{ role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,AA' }] }],
    })
    expect(admit(input({ task, assignment: { model: 'fake:seeing' } })).ok).toBe(true)
    expect(admit(input({ task })).ok).toBe(false)
  })

  it('AC-003 rejects definitions changed after define*', () => {
    const agent = agentOf()
    const forgedAgent = {
      ...agent,
      instructions: [{ role: 'system' as const, parts: [{ type: 'text' as const, text: 'x' }] }],
    }
    expect(admit(input({ agent: forgedAgent }))).toMatchObject({ ok: false, code: 'invalid_agent' })
    const task = taskOf()
    const forgedTask = { ...task, context: { dossier: 'other' } }
    expect(admit(input({ task: forgedTask }))).toMatchObject({ ok: false, code: 'invalid_task' })
  })

  it('AC-003 rejects a budget above the environment caps and maxCost without a price', () => {
    const task = taskOf({ budget: { maxSteps: 50 } })
    expect(admit(input({ task, caps: { budget: { maxSteps: 20 } } }))).toMatchObject({
      ok: false,
      code: 'invalid_task',
      message: '预算 maxSteps 超过执行环境上限',
    })
    expect(admit(input({ task, caps: { budget: { maxSteps: 50 } } })).ok).toBe(true)
    const costly = taskOf({ budget: { maxCost: 1 } })
    expect(admit(input({ task: costly }))).toMatchObject({
      ok: false,
      code: 'invalid_task',
      model: 'fake:main',
    })
    const priced = hubOf([main], {
      defaultModel: 'fake:main',
      prices: { 'fake:main': { input: 1, output: 2 } },
    })
    expect(admit(input({ task: costly, hub: priced }))).toMatchObject({
      ok: true,
      price: { input: 1, output: 2 },
    })
  })

  it('AC-004 takes the smallest budget and resolves deliverable and exposure', () => {
    const task = taskOf({
      budget: { maxSteps: 30, maxTotalMs: 600_000, finalizeReserveMs: 1000 },
    })
    const r = admit(
      input({
        task,
        caps: { budget: { maxSteps: 40, maxInputTokens: 9000 } },
        inherited: { ceiling: { maxTotalMs: 200_000, maxCost: 3 } },
      }),
    )
    expect(r.ok && r.budget).toEqual({
      maxSteps: 30,
      maxTotalMs: 200_000,
      maxInputTokens: 9000,
      maxCost: 3,
      finalizeReserveMs: 1000,
    })
    expect(admit(input()).ok && (admit(input()) as { budget: unknown }).budget).toEqual({})
  })

  it('§3.14 clamps the finalize reserve to the effective maxTotalMs', () => {
    const reserveOf = (patch: Partial<AdmitInput>) => {
      const r = admit(input(patch))
      return r.ok ? r.budget.finalizeReserveMs : r.code
    }
    // 没给收尾预留：取 120 秒与 maxTotalMs 的 20% 中较小者。
    expect(reserveOf({ task: taskOf({ budget: { maxTotalMs: 60_000 } }) })).toBe(12_000)
    expect(reserveOf({ task: taskOf({ budget: { maxTotalMs: 3_600_000 } }) })).toBe(120_000)
    expect(
      reserveOf({
        task: taskOf(),
        caps: { budget: { maxTotalMs: 10_000 } },
      }),
    ).toBe(2_000)
    // 给了但不小于生效的 maxTotalMs（被父运行的剩余时长压低）：同样收紧。
    expect(
      reserveOf({
        task: taskOf({ budget: { maxTotalMs: 100_000, finalizeReserveMs: 50_000 } }),
        inherited: { ceiling: { maxTotalMs: 30_000 } },
      }),
    ).toBe(6_000)
    expect(
      reserveOf({
        task: taskOf({ budget: { maxTotalMs: 100_000, finalizeReserveMs: 5_000 } }),
        inherited: { ceiling: { maxTotalMs: 30_000 } },
      }),
    ).toBe(5_000)
    expect(reserveOf({ task: taskOf({ budget: { finalizeReserveMs: 5_000 } }) })).toBe(5_000)
  })

  it('AC-004 picks task > agent > default deliverable and agent > default exposure', () => {
    const own: Exposure = { id: 'own', version: '1', start: () => ({ visible: () => [] }) }
    const agentDeliverable = { output: { ...textOutput(), id: 'agent' } }
    const taskDeliverable = { output: { ...textOutput(), id: 'task' }, fallback: fixedFallback() }
    const agent = agentOf({ deliverable: agentDeliverable, toolbox: { exposure: own } })

    const fromTask = admit(input({ agent, task: taskOf({ deliverable: taskDeliverable }) }))
    expect(fromTask.ok && fromTask.deliverable.output.id).toBe('task')
    expect(fromTask.ok && fromTask.deliverable.fallback).toBe(taskDeliverable.fallback)

    const fromAgent = admit(input({ agent }))
    expect(fromAgent.ok && fromAgent.deliverable.output.id).toBe('agent')
    expect(fromAgent.ok && fromAgent.deliverable.fallback.fixedText).toBe('任务未能完成')
    expect(fromAgent.ok && fromAgent.exposure.id).toBe('own')

    const fromDefault = admit(input())
    expect(fromDefault.ok && fromDefault.deliverable.output.id).toBe('plain')
    expect(fromDefault.ok && fromDefault.exposure.id).toBe('all')
  })

  it('AC-004 uses the default checks unless the deliverable lists its own', () => {
    const check = (id: string): Check => ({
      id,
      version: '1',
      mode: 'gate',
      start: () => ({ accept: async () => ({ pass: true }) }),
    })
    const base = defaults()
    const withChecks = { ...base, deliverable: { ...base.deliverable, checks: [check('review')] } }
    const ids = (agent = agentOf()) => {
      const r = admit(input({ agent, defaults: withChecks }))
      return r.ok ? (r.deliverable.checks ?? []).map((c) => c.id) : undefined
    }
    expect(ids()).toEqual(['review'])
    expect(ids(agentOf({ deliverable: { output: textOutput() } }))).toEqual(['review'])
    expect(ids(agentOf({ deliverable: { output: textOutput(), checks: [] } }))).toEqual([])
    expect(ids(agentOf({ deliverable: { output: textOutput(), checks: [check('own')] } }))).toEqual(
      ['own'],
    )
  })
})
