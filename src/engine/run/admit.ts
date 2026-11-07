// 受理（设计 §3.3、§1.8）：核对 Agent 与任务的指纹、预算对执行环境上限、解析模型并核对要求；
// 得出生效的预算、交付物与工具呈现（方案 D13）。准入排队在运行驱动里。

import type { Agent, Deliverable } from '../../contracts/agent.js'
import type { ContentPart, ModelMessage } from '../../contracts/common.js'
import type { Exposure, Fallback } from '../../contracts/component.js'
import type { Caps } from '../../contracts/environment.js'
import type { Modality, ModelHub, ModelPort, ModelPrice, ModelRef } from '../../contracts/model.js'
import type { Budget, Task } from '../../contracts/task.js'
import { agentFingerprint, taskFingerprint } from '../../core/definition/fingerprint.js'
import { MODALITIES, modalityOf } from '../../core/run/modality.js'
import { DEFAULT_BUDGET } from '../../core/run/state.js'

const CAPPED = ['maxSteps', 'maxTotalMs', 'maxInputTokens', 'maxCost'] as const
/** 收尾预留不给或放不下时，最多占生效总时长的这一比例。 */
const RESERVE_RATIO = 0.2

export interface AdmitInput {
  agent: Agent
  task: Task
  /** 带入的前文：会话的一轮是推导出的窗口，否则是任务的 history。 */
  history?: readonly ModelMessage[]
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

/**
 * 应用声明的输入用到的模态（BR-003）：Agent 指令、任务输入、易变信息、前文的 user 消息。文本文件不算，
 * 所有模型都接收；运行中才出现的（工具结果、组件给的段）不在这里检查，由适配器换成说明。
 */
function usedInputs(
  agent: Agent,
  task: Task,
  history: readonly ModelMessage[],
): { modalities: Set<Modality> } | { unknown: string } {
  const parts: ContentPart[] = [
    ...[...agent.instructions, ...task.input, ...(task.volatile ?? [])].flatMap((s) => s.parts),
    ...history.flatMap((m) => (m.role === 'user' && Array.isArray(m.content) ? m.content : [])),
  ]
  const modalities = new Set<Modality>()
  for (const p of parts) {
    if (p.type === 'image') modalities.add('image')
    if (p.type !== 'file') continue
    const modality = modalityOf(p.mediaType)
    if (modality === undefined) return { unknown: p.mediaType }
    if (modality !== 'text') modalities.add(modality)
  }
  return { modalities }
}

const missing = (wanted: Iterable<Modality>, inputs: readonly Modality[]): Modality[] => {
  const set = new Set(wanted)
  return MODALITIES.filter((m) => set.has(m) && !inputs.includes(m))
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

/** 模型不满足 Agent 与交付物的要求时返回结局 code 与原因；用到不认识的文件类型时为 invalid_task。 */
function unsuitable(
  port: ModelPort,
  agent: Agent,
  task: Task,
  history: readonly ModelMessage[],
  deliverable: Deliverable,
): { code: 'model_unsuitable' | 'invalid_task'; message: string } | undefined {
  const caps = port.capabilities
  const req = agent.model?.requires ?? {}
  const unsuitableFor = (message: string) => ({ code: 'model_unsuitable' as const, message })
  const required = missing(req.inputs ?? [], caps.inputs)
  if (required.length > 0)
    return unsuitableFor(`模型 ${port.ref} 不支持 ${required.join('、')} 输入`)
  if (req.minContext !== undefined && req.minContext > caps.contextLimit) {
    return unsuitableFor(
      `模型 ${port.ref} 的上下文窗口 ${caps.contextLimit} 小于要求的 ${req.minContext}`,
    )
  }
  if (req.toolCalls && !caps.toolCalls) return unsuitableFor(`模型 ${port.ref} 不支持工具调用`)
  if (req.reasoning && caps.reasoning === 'none')
    return unsuitableFor(`模型 ${port.ref} 不支持推理`)
  if (deliverable.output.kind === 'structured' && !caps.toolCalls) {
    return unsuitableFor(`结构化交付需要模型支持工具调用，模型 ${port.ref} 不支持`)
  }
  const used = usedInputs(agent, task, history)
  if ('unknown' in used)
    return { code: 'invalid_task', message: `不支持的文件类型 ${used.unknown}` }
  const unsupported = missing(used.modalities, caps.inputs)
  if (unsupported.length > 0) {
    return unsuitableFor(`任务含 ${unsupported.join('、')} 输入，模型 ${port.ref} 不支持`)
  }
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
  const reason = unsuitable(port, agent, task, input.history ?? task.history ?? [], deliverable)
  if (reason) return { ok: false, ...reason, model: ref }

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
