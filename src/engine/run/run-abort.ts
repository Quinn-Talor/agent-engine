// 取消与硬截止（设计 §3.14、§5.3）：本运行的取消信号、第一次取消的原因、截止计时；父运行取消时随之取消。
// 运行开始结束后不再接受取消；取消到达时记下是否已有结局，结束时据此判定按取消还是按结局结束。

import type { Clock } from '../../contracts/common.js'

export type AbortReason = 'user' | 'parent' | 'deadline' | 'shutdown'

export interface RunAbortDeps {
  clock: Clock
  /** 父运行的取消信号：它取消时本运行按 parent 取消。 */
  parentSignal?: AbortSignal
  /** 当前是否已有结局。 */
  hasOutcome(): boolean
  /** 运行已在结束：之后的取消一律忽略。 */
  ending(): boolean
}

export interface RunAbort {
  readonly signal: AbortSignal
  stop(reason: AbortReason): void
  /** 第一次生效的取消原因；没取消时为空。 */
  reason(): AbortReason | undefined
  /** 取消到达时是否已有结局。 */
  outcomeBeforeAbort(): boolean
  /** 设定硬截止的时刻（再设时替换前一个），到时按 deadline 取消。 */
  setDeadline(at: number): void
  /** 硬截止的时刻；没有 maxTotalMs 时为空。 */
  deadlineAt(): number | undefined
  /** 结束时撤掉截止计时和父运行信号上的监听。 */
  dispose(): void
}

export function createRunAbort(deps: RunAbortDeps): RunAbort {
  const { clock, parentSignal } = deps
  const controller = new AbortController()
  let reason: AbortReason | undefined
  let outcomeBeforeAbort = false
  let cancelDeadline = () => {}
  let deadlineAt: number | undefined

  const stop = (r: AbortReason) => {
    if (deps.ending() || reason) return
    reason = r
    outcomeBeforeAbort = deps.hasOutcome()
    controller.abort()
  }
  const onParentAbort = () => stop('parent')
  if (parentSignal) {
    if (parentSignal.aborted) stop('parent')
    else parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }

  return {
    signal: controller.signal,
    stop,
    reason: () => reason,
    outcomeBeforeAbort: () => outcomeBeforeAbort,
    setDeadline(at) {
      cancelDeadline()
      deadlineAt = at
      cancelDeadline = clock.setTimer(Math.max(0, at - clock.now()), () => stop('deadline'))
    },
    deadlineAt: () => deadlineAt,
    dispose() {
      cancelDeadline()
      parentSignal?.removeEventListener('abort', onParentAbort)
    },
  }
}

/** 在 ms 内等到 p 完成返回 true，超时返回 false；计时取自时钟。 */
export function settlesWithin(clock: Clock, p: Promise<unknown>, ms: number): Promise<boolean> {
  let cancel = () => {}
  const timeout = new Promise<boolean>((resolve) => {
    cancel = clock.setTimer(ms, () => resolve(false))
  })
  return Promise.race([p.then(() => true), timeout]).finally(() => cancel())
}
