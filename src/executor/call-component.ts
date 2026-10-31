// 组件调用（patterns P5）：每次调用都有超时，出错与超时由调用方按组件类型降级（设计 §4.3 规约 5、6）。

import type { Clock } from '../contracts/common.js'
import { abortError } from '../contracts/errors.js'

/** 组件单次调用的默认超时（设计 §3.14）。 */
export const COMPONENT_TIMEOUT_MS = 30_000
/** 记忆的默认超时：压缩要等一次摘要调用，输入大或用推理模型时常常超过 30 秒。 */
export const MEMORY_TIMEOUT_MS = 120_000

export type ComponentOutcome<T> =
  | { ok: true; value: T; durationMs: number }
  | { ok: false; error: unknown; timedOut: boolean; durationMs: number }

export function callComponent<T>(
  fn: () => Promise<T>,
  opts: { clock: Clock; timeoutMs?: number; signal?: AbortSignal },
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
        (value) => finish({ ok: true, value, durationMs: elapsed() }),
        (error: unknown) => finish({ ok: false, error, timedOut: false, durationMs: elapsed() }),
      )
  })
}
