// 运行契约：运行句柄、结果、质量报告、瞬时通知、运行摘要（设计 §2、§3.12、§8.5）。

import type { ErrorCode } from './errors.js'
import type { RunEvent } from './events.js'
import type { ModelRef, RunUsage } from './model.js'

export type RunStatus =
  'completed' | 'awaiting_input' | 'finalized' | 'stopped' | 'failed' | 'aborted'

/** 验收未解决的问题和标注结果。 */
export interface QualityReport {
  unresolved: Array<{ source: string; issues: string[] }>
  annotations: Array<{ source: string; pass: boolean; issues?: string[] }>
}

export interface RunResult {
  runId: string
  status: RunStatus
  code?: string
  text?: string
  /** 结构化交付通过校验的结果。 */
  output?: unknown
  /** 以意图结束时，该调用的参数。 */
  intent?: { tool: string; input: unknown }
  error?: { code: ErrorCode; message: string; retryable: boolean }
  quality?: QualityReport
  model: ModelRef
  usage: RunUsage
  cost?: number
  steps: number
  toolCalls: number
}

/** 瞬时通知：只推送、不写日志（设计 §6.2）。 */
export type Notice =
  | { t: 'text_delta'; step: number; text: string }
  | { t: 'reasoning_delta'; step: number; text: string }
  | { t: 'tool_progress'; callId: string; note: string }
  | { t: 'delivered'; text?: string; output?: unknown }

export interface RunSubscriber {
  /** `run.runId`：事件所属的运行，同一个订阅者接收多次运行时据此区分。 */
  onEvent?(e: RunEvent, run: { runId: string }): void | Promise<void>
  /** `run.runId`：通知所属的运行（订阅了子运行时据此区分）。 */
  onNotice?(n: Notice, run: { runId: string }): void
}

export interface Run {
  readonly runId: string
  readonly result: Promise<RunResult>
  /**
   * 先从日志回放，再接上实时事件。`children: true` 时也接收子运行（及其子运行）的事件和通知，
   * 用回调的 `run.runId` 区分；子运行从它的第一条事件开始送。
   */
  subscribe(sub: RunSubscriber, opts?: { fromSeq?: number; children?: boolean }): () => void
  steer(text: string): void
  abort(reason?: string): void
}

/** 运行摘要：运行档案 `runs` 表的一行（设计 §8.5）。 */
export interface RunSummary {
  runId: string
  rootRunId: string
  parentRunId?: string
  environment: string
  environmentFingerprint: string
  engineFingerprint: string
  agentId: string
  agentVersion?: string
  agentFingerprint: string
  model: ModelRef
  subject?: string
  status?: RunStatus
  code?: string
  startedAt: number
  endedAt?: number
  steps: number
  toolCalls: number
  usage: RunUsage
  cost?: number
  pinned: boolean
}
