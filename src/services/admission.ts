// 准入（设计 §5.3）：全局并发运行数与执行环境并发运行数；先满足执行环境，再满足全局。
// 按到达顺序扫描排队：执行环境已满的跳过，防止一个执行环境占满全局名额。

import type { Clock } from '../contracts/common.js'
import { abortError } from '../contracts/errors.js'

const DEFAULT_MAX_CONCURRENT_RUNS = 20
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000

export class AdmissionTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`admission: 排队超时（${waitedMs}ms）`)
    this.name = 'AdmissionTimeoutError'
  }
}

export interface AdmissionSlot {
  queuedMs: number
  release(): void
}

export interface Admission {
  acquire(req: {
    environment: string
    environmentLimit?: number
    signal?: AbortSignal
  }): Promise<AdmissionSlot>
  status(): { running: number; queued: number }
}

interface Waiter {
  environment: string
  environmentLimit?: number
  enqueuedAt: number
  grant(slot: AdmissionSlot): void
  cancelTimer(): void
}

export function createAdmission(opts: {
  maxConcurrentRuns?: number
  queueTimeoutMs?: number
  clock: Clock
}): Admission {
  const max = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS
  const timeoutMs = opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS
  const { clock } = opts
  const runningByEnv = new Map<string, number>()
  let running = 0
  let queue: Waiter[] = []

  const canStart = (w: Pick<Waiter, 'environment' | 'environmentLimit'>) =>
    running < max &&
    (w.environmentLimit === undefined ||
      (runningByEnv.get(w.environment) ?? 0) < w.environmentLimit)

  const occupy = (environment: string): (() => void) => {
    running += 1
    runningByEnv.set(environment, (runningByEnv.get(environment) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      running -= 1
      runningByEnv.set(environment, (runningByEnv.get(environment) ?? 1) - 1)
      drain()
    }
  }

  const drain = () => {
    for (const w of [...queue]) {
      if (!canStart(w)) continue
      queue = queue.filter((q) => q !== w)
      w.cancelTimer()
      w.grant({ queuedMs: clock.now() - w.enqueuedAt, release: occupy(w.environment) })
    }
  }

  return {
    acquire(req) {
      const { signal } = req
      if (signal?.aborted) return Promise.reject(abortError())
      return new Promise((resolve, reject) => {
        const leave = (error: Error) => {
          queue = queue.filter((q) => q !== waiter)
          waiter.cancelTimer()
          reject(error)
        }
        const onAbort = () => leave(abortError())
        const waiter: Waiter = {
          environment: req.environment,
          environmentLimit: req.environmentLimit,
          enqueuedAt: clock.now(),
          grant: (slot) => {
            signal?.removeEventListener('abort', onAbort)
            resolve(slot)
          },
          cancelTimer: () => {},
        }
        queue.push(waiter)
        drain()
        if (!queue.includes(waiter)) return
        const cancel = clock.setTimer(timeoutMs, () => {
          signal?.removeEventListener('abort', onAbort)
          leave(new AdmissionTimeoutError(clock.now() - waiter.enqueuedAt))
        })
        waiter.cancelTimer = cancel
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    status: () => ({ running, queued: queue.length }),
  }
}
