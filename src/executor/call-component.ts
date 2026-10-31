// 组件调用（patterns P5）：每次调用都有超时，出错、超时与返回值不合格由调用方按组件类型降级
// （设计 §4.3 规约 5、6，§4.4）。

import type { Clock } from '../contracts/common.js'
import { abortError } from '../contracts/errors.js'

/** 组件单次调用的默认超时（设计 §3.14）。 */
export const COMPONENT_TIMEOUT_MS = 30_000
/** 记忆的默认超时：压缩要等一次摘要调用，输入大或用推理模型时常常超过 30 秒。 */
export const MEMORY_TIMEOUT_MS = 120_000

export type ComponentFailure = {
  ok: false
  error: unknown
  timedOut: boolean
  durationMs: number
  /** 返回值不符合组件契约：问题描述与原返回值。 */
  invalid?: { issue: string; value: unknown }
}

export type ComponentOutcome<T> = { ok: true; value: T; durationMs: number } | ComponentFailure

/** 写进诊断日志的失败细节：返回值不合格时是返回值，否则是错误与是否超时。 */
export const failureDetail = (f: ComponentFailure): Record<string, unknown> =>
  f.invalid ? { value: f.invalid.value } : { error: String(f.error), timedOut: f.timedOut }

/**
 * `validate` 检查返回值的形状，返回问题描述；不合格的返回值与出错一样按失败交回（设计 §4.4），
 * 调用方只需一条出错分支。
 */
export function callComponent<T>(
  fn: () => Promise<T>,
  opts: {
    clock: Clock
    timeoutMs?: number
    signal?: AbortSignal
    validate?: (value: T) => string | undefined
  },
): Promise<ComponentOutcome<T>> {
  const { clock, signal } = opts
  const start = clock.now()
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: ComponentOutcome<T>) => {
      if (settled) return
      settled = true
      cancelTimer()
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const elapsed = () => clock.now() - start
    const onAbort = () =>
      finish({ ok: false, error: abortError(), timedOut: false, durationMs: elapsed() })
    const cancelTimer = clock.setTimer(opts.timeoutMs ?? COMPONENT_TIMEOUT_MS, () =>
      finish({ ok: false, error: new Error('timeout'), timedOut: true, durationMs: elapsed() }),
    )
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          const issue = opts.validate?.(value)
          finish(
            issue === undefined
              ? { ok: true, value, durationMs: elapsed() }
              : {
                  ok: false,
                  error: new Error(`返回值不合格：${issue}`),
                  timedOut: false,
                  durationMs: elapsed(),
                  invalid: { issue, value },
                },
          )
        },
        (error: unknown) => finish({ ok: false, error, timedOut: false, durationMs: elapsed() }),
      )
  })
}
