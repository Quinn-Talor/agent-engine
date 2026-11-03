// 执行环境契约：委托人、须知、权限、规定、强制验收、上限（设计 §1.3、§2、§3.14）。

import type { Agent } from './agent.js'
import type { Segment } from './common.js'
import type { Approver, Check, Guard, NoticeProvider, PermissionRule } from './component.js'
import type { ModelRef } from './model.js'
import type { Run } from './run.js'
import type { Task } from './task.js'

export interface Principal {
  /** 运行中能否联系上。 */
  reachable: boolean
  approver?: Approver
}

/** 执行环境的上限（设计 §3.14 限额归属）。 */
export interface Caps {
  /** 任务预算的上限；任务预算超过时受理失败。 */
  budget?: { maxSteps?: number; maxTotalMs?: number; maxInputTokens?: number; maxCost?: number }
  /** 并发运行数，默认不限（仍受全局准入约束）。 */
  maxConcurrentRuns?: number
  /** 每次运行的工具并发，默认 5。 */
  toolConcurrency?: number
  /** 委托：深度默认 3；每个子 agent 次数默认 3（按根运行）；子运行并发默认 10（按根运行）。 */
  delegation?: { depth?: number; perAgent?: number; concurrency?: number }
  /** 审批等待，默认 5 分钟；超时按拒绝处理。 */
  approvalTimeoutMs?: number
  /** 等待子运行交付，默认 10 秒；超时子运行记为 aborted。 */
  childDeliveryWaitMs?: number
}

export interface EnvironmentConfig {
  /** 写入日志，可以按它查询、设置保留策略。 */
  name: string
  principal: Principal
  notice?: Array<Segment | NoticeProvider>
  permissions?: PermissionRule[]
  /** 执行环境的守卫，来源为 `environment:<id>`。 */
  guards?: Guard[]
  /** 强制验收。 */
  checks?: Check[]
  caps?: Caps
}

/** 一次运行的安排：模型、运行 id，以及它属于哪个会话（会话方案 §4）。 */
export interface Assignment {
  model?: ModelRef
  runId?: string
  /** 会话 id：这次运行是会话的一轮，前文由引擎从会话日志推导，任务不能再给 history。 */
  session?: string
  /** 接在会话里哪一轮之后（runId）；`null` 从头开始；不写时取会话里最新的一轮。 */
  continues?: string | null
}

export interface Environment {
  readonly name: string
  readonly fingerprint: string
  start(agent: Agent, task: Task, assignment?: Assignment): Run
}
