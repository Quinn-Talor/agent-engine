// 错误码、工具错误信封、模型调用错误与定义错误（设计 §8.1、§8.2）。

import type { ModelError } from './model.js'

/** 工具流水线 a–g 环节的信封码，以及引擎另外定义的错误码。 */
export const TOOL_ERROR_CODES = [
  'TOOL_NOT_AVAILABLE',
  'TOOL_BLOCKED',
  'INVALID_INPUT',
  'PERMISSION_DENIED',
  'USER_DENIED',
  'TOOL_UNAVAILABLE',
  'TOOL_TIMEOUT',
  'TOOL_ABORTED',
  'TOOL_EXCEPTION',
  'TOOL_MISSING_RESULT',
  'TOOL_INTERRUPTED',
  'OUTPUT_INVALID',
  'INTENT_NOT_ALONE',
  'SPAWN_DEPTH_EXCEEDED',
  'SPAWN_CYCLE',
  'SPAWN_BUDGET',
  'SPAWN_LIMIT',
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

/** 模型错误分类码（设计 §8.1 错误分类、§5.2 熔断打开）。 */
export const MODEL_ERROR_CODES = [
  'MODEL_TIMEOUT',
  'MODEL_CONNECTION',
  'RATE_LIMITED',
  'AUTH_FAILED',
  'CONTEXT_TOO_LONG',
  'CONTENT_FILTER',
  'MODEL_ERROR',
  'MODEL_UNAVAILABLE',
] as const

export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number]

/** `RunResult.error.code`：分类后的模型错误码，或引擎、工具的错误码。 */
export type ErrorCode = ModelErrorCode | ToolErrorCode | (string & {})

/** 工具层失败的结构化返回；判断出错只认 `__agent_error` 标记（设计 I5）。 */
export interface ToolErrorEnvelope {
  __agent_error: true
  code: string
  message: string
  hint?: string
  /**
   * 工具声明的错误类别：'deterministic' 表示同样的输入会得到同样的结果，'transient' 表示
   * 下次可能就好。不写时按错误码判断（只有 INVALID_INPUT、PERMISSION_DENIED、USER_DENIED、
   * SPAWN_* 算确定性的）。
   */
  errorClass?: 'deterministic' | 'transient'
}

export function toolError(code: string, message: string, hint?: string): ToolErrorEnvelope {
  return hint === undefined
    ? { __agent_error: true, code, message }
    : { __agent_error: true, code, message, hint }
}

export function isToolError(value: unknown): value is ToolErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.__agent_error === true && typeof v.code === 'string' && typeof v.message === 'string'
}

/** 模型端口失败时抛出，携带分类后的模型错误（设计 I9）。 */
export class ModelCallError extends Error {
  readonly detail: ModelError

  constructor(detail: ModelError) {
    super(`${detail.code}: ${detail.message}`)
    this.name = 'ModelCallError'
    this.detail = detail
  }
}

export function isModelCallError(value: unknown): value is ModelCallError {
  return value instanceof ModelCallError
}

/** 取消产生的错误，`name` 为 `AbortError`，与平台的取消错误一致。 */
export function abortError(message = 'aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError'
}

export type DefinitionErrorCode =
  'invalid_agent' | 'invalid_task' | 'invalid_engine' | 'invalid_environment'

/** 定义期校验失败：一次性带上全部问题。 */
export class DefinitionError extends Error {
  readonly code: DefinitionErrorCode
  readonly issues: readonly string[]

  constructor(code: DefinitionErrorCode, issues: readonly string[]) {
    super(`${code}: ${issues.join('; ')}`)
    this.name = 'DefinitionError'
    this.code = code
    this.issues = issues
  }
}
