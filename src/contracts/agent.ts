// Agent 契约：角色、能力、工具箱、默认交付物、模型偏好（设计 §1.4、§2）。

import type { Capability } from './capability.js'
import type { Segment } from './common.js'
import type { Check, Exposure, Fallback, OutputContract } from './component.js'
import type { ModelRef, ModelRequirements, ModelSettings } from './model.js'

/** 交什么、怎么验收、做不完时交什么。 */
export interface Deliverable {
  output: OutputContract
  /** 不写时用引擎默认的验收（createEngine 默认带完成审查）；`[]` 表示不要验收。 */
  checks?: Check[]
  fallback?: Fallback
}

export interface AgentDef {
  id: string
  /** 业务版本标签；统计和回放以指纹为准。 */
  version?: string
  instructions: Segment[]
  capabilities?: Capability[]
  /** 默认 searchExposure()。 */
  toolbox?: { exposure?: Exposure }
  /** 默认 { output: text(), checks: [completionReview()], fallback: standardFallback() }。 */
  deliverable?: Deliverable
  model?: { prefer?: ModelRef; requires?: ModelRequirements; settings?: ModelSettings }
}

export interface Agent extends Readonly<AgentDef> {
  readonly fingerprint: string
}
