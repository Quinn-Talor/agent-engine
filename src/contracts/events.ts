// 运行日志契约：事件、blob 引用、运行档案端口（设计 §6.2、§8.5）。

import type { CapabilitySnapshot } from './capability.js'
import type { JsonValue, TaskScope } from './common.js'
import type {
  AskRequest,
  CheckMode,
  Intervention,
  Observation,
  Opinion,
  Verdict,
} from './component.js'
import type { Budget } from './task.js'
import type { ModelError, ModelRef, ModelResponse, NormalizedUsage } from './model.js'
import type { RunResult, RunStatus, RunSummary } from './run.js'
import type { ToolEffect } from './tool.js'

/** 事件格式版本，写入 `run_started.schemaVersion`。 */
export const SCHEMA_VERSION = 1

/** blob 引用：`sha256:<64 位十六进制>`。 */
export type BlobRef = string

export interface AgentSnapshot {
  id: string
  version?: string
  fingerprint: string
}

export interface TaskSnapshot {
  fingerprint: string
  subject?: string
  tags?: Record<string, string>
  scope?: TaskScope
  context?: Record<string, JsonValue>
  budget?: Budget
  /** 任务目标（≤ 200 字）；回归重放据此重算纠偏消息。 */
  goal?: string
  /** 任务输入与 history 的 blob（`{ input, history }`）；回归重放据此重建交付验收的语料。 */
  content?: BlobRef
}

export type PermissionVerdict = 'allow' | { deny: string } | { ask: AskRequest }

export interface RememberScope {
  scope: 'session' | 'always'
  pattern?: string
}

export type RunEvent = { seq: number; at: number } & (
  | {
      t: 'run_started'
      agent: AgentSnapshot
      task: TaskSnapshot
      environment: { name: string; fingerprint: string; principalReachable: boolean }
      engine: { fingerprint: string }
      capabilities: CapabilitySnapshot[]
      unavailable: Array<{ capability: string; reason: string }>
      model: ModelRef
      /** 运行模型的上下文窗口；超限检查与压力只读日志即可得到（F2 §B.4.4）。 */
      contextLimit?: number
      queuedMs: number
      parentRunId?: string
      rootRunId: string
      schemaVersion: number
    }
  | { t: 'step_started'; step: number }
  | {
      t: 'intervention_applied'
      step: number
      intervention: Intervention
      source: string
      until?: number
    }
  | {
      t: 'context_built'
      step: number
      messages: BlobRef[]
      tools: string[]
      estimate: number
      compaction?: { replaced: [number, number]; summary: BlobRef; anchorsKept: number }
    }
  | {
      t: 'model_responded'
      step: number
      response: ModelResponse
      startedAt: number
      firstTokenAt?: number
    }
  | { t: 'model_failed'; step: number; error: ModelError; partialText?: string; startedAt: number }
  | {
      t: 'model_aborted'
      step: number
      partialText: string
      /** 不是取消：本步的模型调用到了收尾预留线被截断，剩余时间留给兜底交付。 */
      deadline?: true
    }
  | { t: 'permission_decided'; callId: string; verdict: PermissionVerdict; source: string }
  | {
      t: 'approval_answered'
      callId: string
      approved: boolean
      remember?: RememberScope
      waitedMs: number
    }
  | {
      t: 'tool_finished'
      callId: string
      capability: string
      effect: ToolEffect
      shown: BlobRef
      raw?: BlobRef
      isError: boolean
      errorCode?: string
      /** 有副作用的调用结果未知（超时、执行中抛错或取消、执行成功但结果没存下来），可能已经执行。 */
      possiblyExecuted?: true
      /** 工具在错误信封里声明的错误类别。 */
      errorClass?: 'deterministic' | 'transient'
      startedAt: number
      durationMs: number
      /** 发起的子运行；发起了多个时是最后一个，`childRunIds` 按发起顺序列出全部。 */
      childRunId?: string
      childRunIds?: string[]
      /** 子运行的用量与费用，计入父运行（F2 §B.4.4）。 */
      usage?: NormalizedUsage
      cost?: number
    }
  | {
      t: 'external_call'
      source: string
      kind: 'model' | 'hook' | 'record'
      request: BlobRef
      response: BlobRef
      usage?: NormalizedUsage
      startedAt: number
      durationMs: number
    }
  | { t: 'steer_received'; text: string }
  | {
      t: 'evaluated'
      step: number
      observation: Observation
      opinions: Array<{
        source: string
        opinion?: Opinion
        mode: 'active' | 'shadow'
        durationMs: number
        detail?: string
        /** 没有告知过就要求终止，本步改为告知。 */
        deferred?: true
        /** 守卫出错或超时。 */
        error?: true
      }>
      verdict: Verdict
      /** 判定时刻（守卫跑完之后）：剩余时长按它计算，回归重放按它重算。 */
      decidedAt?: number
    }
  | { t: 'step_ended'; step: number }
  | {
      t: 'delivery_checked'
      step: number
      path: 'normal' | 'fallback'
      attempt: number
      output: { ok: boolean; issues?: string[] }
      checks: Array<{ source: string; mode: CheckMode; pass: boolean; issues?: string[] }>
      /**
       * delivered：定稿；returned：带提示回到下一步；
       * fallback：正常路径放弃，转兜底路径；failed：结构化交付超过自修上限（F2 §B.4.4）；
       * stopped：本该退回但预算已经用完、又不能走兜底（token / 费用用完，或结构化交付没有下一步）。
       */
      outcome: 'delivered' | 'returned' | 'fallback' | 'failed' | 'stopped'
      /** fallback：收尾 code（缺省 empty_output）；stopped：停止 code。 */
      code?: string
      /** 退回时带给下一步的提示。 */
      hint?: string
    }
  | { t: 'fallback_generated'; code: string; text: string; degradation: 0 | 1 | 2 }
  | {
      t: 'run_ended'
      result: RunResult
      /** 没有 run_started 的运行（受理失败、排队超时、须知拦下、引擎已关闭）的归属，供运行摘要使用。 */
      origin?: RunOrigin
    }
)

export interface RunOrigin {
  rootRunId: string
  parentRunId?: string
  environment: string
  environmentFingerprint: string
  engineFingerprint: string
  agentId: string
  agentVersion?: string
  agentFingerprint: string
  subject?: string
}

export type RunEventType = RunEvent['t']

/** 尚未编号和打时间戳的事件；执行器追加时才写 `seq`、`at`。 */
export type RunEventBody = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, 'seq' | 'at'>
    : never
  : never

export interface RunFilter {
  subject?: string
  environment?: string
  agentId?: string
  status?: RunStatus
  parentRunId?: string
  rootRunId?: string
  startedAfter?: number
  startedBefore?: number
  limit?: number
}

export interface RetentionPolicy {
  /** 默认保留天数（设计 §8.5 默认 30 天）。 */
  defaultDays: number
  /** 按执行环境覆盖保留天数。 */
  environments?: Record<string, number>
  now: number
}

export interface RetainReport {
  removedRuns: number
  removedBlobs: number
}

/** 运行档案的存储端口（设计 §8.5）。 */
export interface ArchiveStore {
  /** 原子写入，seq 必须连续。 */
  append(runId: string, events: RunEvent[]): Promise<void>
  /** 读取时经过升级器。 */
  read(runId: string, fromSeq?: number): AsyncIterable<RunEvent>
  /** 按 sha256 去重。 */
  putBlob(data: string | Uint8Array): Promise<BlobRef>
  getBlob(ref: BlobRef): Promise<string | Uint8Array>
  query(filter: RunFilter): Promise<RunSummary[]>
  pin(runId: string, reason: string): Promise<void>
  retain(policy: RetentionPolicy): Promise<RetainReport>
}

/** `EngineConfig.services.archive` 使用的运行档案。 */
export type Archive = ArchiveStore
