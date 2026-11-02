// 受理（设计 §3.3、§1.8）：核对 Agent 与任务的指纹、预算对执行环境上限、解析模型并核对要求；
// 得出生效的预算、交付物与工具呈现（方案 D13）。准入排队在运行驱动里。

import type { Agent, Deliverable } from '../../contracts/agent.js'
import type { ContentPart, ModelMessage, Segment } from '../../contracts/common.js'
import type { Exposure, Fallback } from '../../contracts/component.js'
import type { Caps } from '../../contracts/environment.js'
import type { ModelHub, ModelPort, ModelPrice, ModelRef } from '../../contracts/model.js'
import type { Budget, Task } from '../../contracts/task.js'
import { agentFingerprint, taskFingerprint } from '../../core/definition/fingerprint.js'
import { DEFAULT_BUDGET } from '../../core/run/state.js'

const CAPPED = ['maxSteps', 'maxTotalMs', 'maxInputTokens', 'maxCost'] as const
/** 收尾预留不给或放不下时，最多占生效总时长的这一比例。 */
const RESERVE_RATIO = 0.2

export interface AdmitInput {
  agent: Agent
  task: Task
  assignment?: { model?: ModelRef }
  caps?: Caps
  hub: ModelHub
  defaults: { deliverable: Deliverable & { fallback: Fallback }; exposure: Exposure }
  /** 子运行：父运行的模型与剩余额度。 */
  inherited?: { model?: ModelRef; ceiling?: { maxTotalMs?: number; maxCost?: number } }
}

export interface Admitted {
  ok: true
  model: ModelRef
  port: ModelPort
  price?: ModelPrice
  budget: Budget
  deliverable: Deliverable & { fallback: Fallback }
  exposure: Exposure
}

export interface AdmitFailure {
  ok: false
  code: 'invalid_agent' | 'invalid_task' | 'model_unsuitable'
  message: string
  model?: ModelRef
}

const hasImage = (parts: readonly ContentPart[]) => parts.some((p) => p.type === 'image')

function taskHasImages(task: Task): boolean {
  const segments: Segment[] = [...task.input, ...(task.volatile ?? [])]
  if (segments.some((s) => hasImage(s.parts))) return true
  return (task.history ?? []).some(
    (m: ModelMessage) => m.role === 'user' && Array.isArray(m.content) && hasImage(m.content),
  )
}

function effectiveBudget(
  task: Task,
  caps: Caps | undefined,
  ceiling: { maxTotalMs?: number; maxCost?: number } = {},
): Budget {
  const budget: Budget = {}
  for (const k of CAPPED) {
    const limit = k === 'maxTotalMs' || k === 'maxCost' ? ceiling[k] : undefined
    const values = [task.budget?.[k], caps?.budget?.[k], limit].filter(
      (v): v is number => v !== undefined,
    )
    if (values.length > 0) budget[k] = Math.min(...values)
  }
  // 收尾预留按生效的 maxTotalMs 收紧：默认 120 秒放不进短任务（或被执行环境、父运行压短的任务）时，
  // 一开始就会被判为没时间而收尾。
  const reserve = task.budget?.finalizeReserveMs
  const total = budget.maxTotalMs
  if (total !== undefined && (reserve === undefined || reserve >= total)) {
    budget.finalizeReserveMs = Math.min(
      DEFAULT_BUDGET.finalizeReserveMs,
      Math.floor(total * RESERVE_RATIO),
    )
  } else if (reserve !== undefined) {
    budget.finalizeReserveMs = reserve
  }
  return budget
}

/** 模型不满足 Agent 与交付物的要求时返回原因。 */
function unsuitable(
  port: ModelPort,
  agent: Agent,
  task: Task,
  deliverable: Deliverable,
): string | undefined {
  const caps = port.capabilities
  const req = agent.model?.requires ?? {}
  if (req.vision && !caps.vision) return `模型 ${port.ref} 不支持视觉`
  if (req.minContext !== undefined && req.minContext > caps.contextLimit) {
    return `模型 ${port.ref} 的上下文窗口 ${caps.contextLimit} 小于要求的 ${req.minContext}`
  }
  if (req.toolCalls && !caps.toolCalls) return `模型 ${port.ref} 不支持工具调用`
  if (req.reasoning && caps.reasoning === 'none') return `模型 ${port.ref} 不支持推理`
  if (deliverable.output.kind === 'structured' && !caps.toolCalls) {
    return `结构化交付需要模型支持工具调用，模型 ${port.ref} 不支持`
  }
  if (!caps.vision && taskHasImages(task)) return `任务含图片，模型 ${port.ref} 不支持视觉`
  return undefined
}

export function admit(input: AdmitInput): Admitted | AdmitFailure {
  const { agent, task, caps, hub, defaults, inherited } = input
  if (agentFingerprint(agent) !== agent.fingerprint) {
    return { ok: false, code: 'invalid_agent', message: 'Agent 定义在 defineAgent 之后被修改' }
  }
  if (taskFingerprint(task) !== task.fingerprint) {
    return { ok: false, code: 'invalid_task', message: '任务定义在 defineTask 之后被修改' }
  }
  for (const k of CAPPED) {
    const own = task.budget?.[k]
    const cap = caps?.budget?.[k]
    if (own !== undefined && cap !== undefined && own > cap) {
      return { ok: false, code: 'invalid_task', message: `预算 ${k} 超过执行环境上限` }
    }
  }

  const ref = input.assignment?.model ?? agent.model?.prefer ?? inherited?.model ?? hub.defaultModel
  if (ref === undefined) return { ok: false, code: 'model_unsuitable', message: '没有可用的模型' }
  const port = hub.resolve(ref)
  if (!port) {
    return { ok: false, code: 'model_unsuitable', message: `模型 ${ref} 不存在`, model: ref }
  }
  const deliverable = task.deliverable ?? agent.deliverable ?? defaults.deliverable
  const reason = unsuitable(port, agent, task, deliverable)
  if (reason) return { ok: false, code: 'model_unsuitable', message: reason, model: ref }

  const price = hub.price(ref)
  if (task.budget?.maxCost !== undefined && !price) {
    return {
      ok: false,
      code: 'invalid_task',
      message: `模型 ${ref} 没有价格，不能设置 maxCost`,
      model: ref,
    }
  }

  return {
    ok: true,
    model: ref,
    port,
    ...(price ? { price } : {}),
    budget: effectiveBudget(task, caps, inherited?.ceiling),
    // 验收和兜底没写时用默认的；`checks: []` 表示不要验收。
    deliverable: {
      ...deliverable,
      checks: deliverable.checks ?? defaults.deliverable.checks ?? [],
      fallback: deliverable.fallback ?? defaults.deliverable.fallback,
    },
    exposure: agent.toolbox?.exposure ?? defaults.exposure,
  }
}
