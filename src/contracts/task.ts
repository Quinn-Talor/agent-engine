// 任务契约：输入、背景、作业范围、业务上下文、交付物、目标、守卫、预算、归属（设计 §1.5、§2）。

import type { Deliverable } from './agent.js'
import type { JsonValue, ModelMessage, Segment, TaskScope } from './common.js'
import type { Guard } from './component.js'

export interface Budget {
  maxSteps?: number
  maxTotalMs?: number
  finalizeReserveMs?: number
  maxInputTokens?: number
  /** 需要模型库里有该模型的价格。 */
  maxCost?: number
}

export interface TaskDef {
  input: Segment[]
  /** 要求工具调用成对。 */
  history?: ModelMessage[]
  volatile?: Segment[]
  scope?: TaskScope
  /** 业务上下文：引擎不解释，只读地交给工具和组件，计入任务指纹。 */
  context?: Record<string, JsonValue>
  /** 整体覆盖 Agent 的默认交付物。 */
  deliverable?: Deliverable
  /** 任务目标，纠偏消息引用它；缺省为任务输入的前 200 字。 */
  goal?: string
  /** 任务的守卫，来源为 `task:<id>`。 */
  guards?: Guard[]
  budget?: Budget
  subject?: string
  tags?: Record<string, string>
}

export interface Task extends Readonly<TaskDef> {
  readonly fingerprint: string
}
