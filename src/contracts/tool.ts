// 工具契约：工具定义、工具上下文、权限视角的调用视图（设计 §8.2、§9.10）。

import type { ZodType } from 'zod'
import type { Agent } from './agent.js'
import type { JsonSchema, JsonValue, TaskScope } from './common.js'
import type { Environment } from './environment.js'
import type { ToolErrorEnvelope } from './errors.js'
import type { RunResult } from './run.js'
import type { Task } from './task.js'

/** 副作用类型（设计 §5.4），默认 `side_effect`。 */
export type ToolEffect = 'none' | 'idempotent' | 'side_effect'

export interface ToolAccess {
  read?: string[]
  write?: string[]
  network?: boolean
}

export interface ToolIntent {
  kind: 'complete' | 'await_input' | 'stop'
  code: string
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
  execution?: {
    effect?: ToolEffect
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
