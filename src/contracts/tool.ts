// 工具契约：工具定义、工具上下文、权限视角的调用视图（设计 §8.2、§9.10）。

import type { ZodType } from 'zod'
import type { Agent } from './agent.js'
import type { ImagePart, JsonSchema, JsonValue, TaskScope, TextPart } from './common.js'
import type { Environment } from './environment.js'
import type { ToolErrorEnvelope } from './errors.js'
import type { SideModelRequest, SideModelResponse } from './model.js'
import type { RunResult } from './run.js'
import type { Task } from './task.js'

/** 副作用类型（设计 §5.4）：每个工具都必须声明，没有缺省值。 */
export type ToolEffect = 'none' | 'idempotent' | 'side_effect'

export interface ToolAccess {
  read?: string[]
  write?: string[]
  network?: boolean
}

export interface ToolIntent {
  kind: 'complete' | 'await_input' | 'stop'
  code: string
  /**
   * 参数里给委托人看的那段话所在的字段（例如 ask_user 的 question）。模型以这个意图结束、没写正文时，
   * 这段话就是交付给委托人的文本。
   */
  reply?: string
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: ZodType | JsonSchema
  execute(input: unknown, ctx: ToolCtx): Promise<unknown>
  validate?(input: unknown, ctx: ToolCtx): { ok: true } | { error: ToolErrorEnvelope }
  /** 供权限和审批使用。 */
  safety?: {
    access?(input: unknown): ToolAccess
    risk?: 'low' | 'high'
  }
  /** 供流水线使用。 */
  execution: {
    effect: ToolEffect
    exclusive?: boolean
    /** 默认 30 秒。 */
    timeoutMs?: number
    /** 默认 8KB。 */
    maxOutputChars?: number
  }
  /** 供判定和监督使用。 */
  semantics?: {
    intent?: ToolIntent
    /** 轮询类工具，封路与无新信息守卫不统计。 */
    repeatable?: boolean
  }
}

export interface ToolCtx {
  runId: string
  callId: string
  /** runId + callId，重试时不变（设计 §5.4）。 */
  idempotencyKey: string
  scope: TaskScope
  /** 任务的归属和业务上下文。 */
  task: { subject?: string; context?: Readonly<Record<string, JsonValue>> }
  signal: AbortSignal
  /** `signal` 取消时子运行随之取消；工具环节会传入本次调用的信号。 */
  spawn(
    agent: Agent,
    task: Task,
    opts?: { environment?: Environment; signal?: AbortSignal },
  ): Promise<RunResult>
  progress(note: string): void
  /**
   * 经引擎调用模型：写进日志（`external_call`，来源 `tool:<工具名>/<用途>`），计入预算与 `tools` 用量（I8）；
   * 跟随这次调用的取消与超时。
   */
  callModel(req: SideModelRequest): Promise<SideModelResponse | undefined>
}

/** 权限规则看到的工具调用（设计 §9.10 `permit(call)`）。 */
export interface ToolCallView {
  callId: string
  toolName: string
  capability: string
  input: unknown
  access?: ToolAccess
  risk: 'low' | 'high'
  effect: ToolEffect
}

/**
 * 内容块结果：工具返回文本与图片（设计 §8.2 h 规整）。只认结构化标记 `__agent_content`，
 * 返回值里恰好有 `parts` 字段的业务数据不受影响。
 */
export interface ToolContent {
  __agent_content: true
  parts: Array<TextPart | ImagePart>
}

export function toolContent(parts: Array<TextPart | ImagePart>): ToolContent {
  return { __agent_content: true, parts }
}

export function isToolContent(value: unknown): value is ToolContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __agent_content?: unknown }).__agent_content === true &&
    Array.isArray((value as { parts?: unknown }).parts)
  )
}
