// 引擎测试数据：最小的 Agent、任务、默认组件与模型库构造。只在测试中使用，不进构建与覆盖率。

import type { Agent, AgentDef, Deliverable } from '../contracts/agent.js'
import type { Exposure, Fallback, Memory, OutputContract } from '../contracts/component.js'
import type { ModelHub, ModelPort, ModelPrice, ModelRef } from '../contracts/model.js'
import type { Task, TaskDef } from '../contracts/task.js'
import { defineAgent, defineTask } from '../core/define.js'

export const textOutput = (): OutputContract => ({
  id: 'plain',
  version: '1',
  kind: 'text',
  async validate(candidate) {
    if ((candidate.text ?? '').trim().length > 0) return { ok: true }
    if (candidate.observation.intent?.kind === 'complete') return { ok: true }
    return { ok: false, issues: ['交付文本为空'], hint: '请给出回答' }
  },
})

export const fixedFallback = (): Fallback => ({
  instructions: { '*': { reachable: '说明进展并提问', unreachable: '报告进展' } },
  fixedText: '任务未能完成',
})

export const passMemory = (): Memory => ({
  id: 'pass',
  version: '1',
  start: () => ({ recall: async (s) => ({ history: s.history, transcript: s.transcript }) }),
})

export const allExposure = (): Exposure => ({
  id: 'all',
  version: '1',
  start: () => ({ visible: (s) => s.prepared.map((p) => p.name) }),
})

export const defaults = (): {
  deliverable: Deliverable & { fallback: Fallback }
  exposure: Exposure
} => ({
  deliverable: { output: textOutput(), fallback: fixedFallback() },
  exposure: allExposure(),
})

export const agentOf = (patch: Partial<AgentDef> = {}): Agent =>
  defineAgent({
    id: 'helper',
    instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是助手' }] }],
    ...patch,
  })

export const taskOf = (patch: Partial<TaskDef> = {}): Task =>
  defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }], ...patch })

/** 最小模型库：按引用返回端口，健康状态可以由测试推送。 */
export function hubOf(
  ports: readonly ModelPort[],
  opts: { defaultModel?: ModelRef; prices?: Record<ModelRef, ModelPrice> } = {},
): ModelHub & { emitHealth(): void; breakers: ReturnType<ModelHub['health']> } {
  const listeners = new Set<Parameters<ModelHub['onHealth']>[0]>()
  const hub = {
    breakers: [] as ReturnType<ModelHub['health']>,
    ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
    resolve: (ref: ModelRef) => ports.find((p) => p.ref === ref),
    price: (ref: ModelRef) => opts.prices?.[ref],
    health: () => hub.breakers,
    onHealth(fn: Parameters<ModelHub['onHealth']>[0]) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emitHealth() {
      for (const fn of listeners) for (const b of hub.breakers) fn(b)
    },
  }
  return hub
}
