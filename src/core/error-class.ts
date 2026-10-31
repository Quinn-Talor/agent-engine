// 错误类别（方案 §3.2）：确定性错误重试也不会变，瞬时错误可能下次就好。

import type { ErrorClass } from '../contracts/component.js'
import type { ToolEffect } from '../contracts/tool.js'

export const DETERMINISTIC_CODES: ReadonlySet<string> = new Set([
  'INVALID_INPUT',
  'PERMISSION_DENIED',
  'USER_DENIED',
])

export function classifyError(code: string): ErrorClass {
  return DETERMINISTIC_CODES.has(code) || code.startsWith('SPAWN_') ? 'deterministic' : 'transient'
}

/**
 * 超时、进程中断与取消的有副作用调用可能已经执行（设计 §5.4）。取消时可能正在执行，
 * 无从区分，按可能已执行处理（I15）。执行中抛错、结果没存下来的由行动环节在事件上标记。
 */
const POSSIBLY_EXECUTED = new Set([
  'TOOL_INTERRUPTED',
  'TOOL_TIMEOUT',
  'TOOL_ABORTED',
  'TOOL_MISSING_RESULT',
])

/** 有副作用的调用失败了，但可能已经执行。 */
export function possiblyExecuted(e: {
  effect: ToolEffect
  isError: boolean
  errorCode?: string
  possiblyExecuted?: true
}): boolean {
  if (e.effect === 'none' || !e.isError) return false
  return e.possiblyExecuted === true || POSSIBLY_EXECUTED.has(e.errorCode ?? '')
}
