// 模型库（设计 §1.2、§8.1）：提供方、默认模型、价格表。
// 每次调用先经过提供方的并发上限和模型的熔断，再到适配器；首 token、空闲、单次时长超时都经时钟计时。

import type { Clock } from '../contracts/common.js'
import type { BreakerStatus } from '../contracts/engine.js'
import { ModelCallError, abortError, isModelCallError } from '../contracts/errors.js'
import type {
  BreakerPolicy,
  ModelError,
  ModelHub,
  ModelPort,
  ModelProvider,
  ModelRef,
  PriceTable,
} from '../contracts/model.js'
import { createBreaker, type Breaker } from './breaker.js'
import { systemClock } from './clock.js'

export interface ModelHubOptions {
  providers: ModelProvider[]
  default?: ModelRef
  /** 按提供方，默认 4。 */
  concurrency?: Record<string, number>
  /** 按模型（设计 §5.2）。 */
  breaker?: BreakerPolicy
  /** 由应用提供；没有价格的模型，费用记为未知。 */
  pricing?: PriceTable
  clock?: Clock
  timeouts?: { firstTokenMs?: number; idleMs?: number; totalMs?: number }
}

const DEFAULT_CONCURRENCY = 4
const DEFAULT_FIRST_TOKEN_MS = 120_000
const DEFAULT_IDLE_MS = 120_000
const DEFAULT_TOTAL_MS = 600_000

/** 只有依赖本身的故障计入熔断：超时、连接错误、限流、5xx（设计 §5.2）。 */
function isDependencyFailure(e: ModelError): boolean {
  return (
    e.code === 'MODEL_TIMEOUT' ||
    e.code === 'MODEL_CONNECTION' ||
    e.code === 'RATE_LIMITED' ||
    (e.code === 'MODEL_ERROR' && (e.status ?? 0) >= 500)
  )
}

const failure = (code: ModelError['code'], message: string, retryable: boolean) =>
  new ModelCallError({ code, message, retryable, attempts: [] })

/** FIFO 信号量；等待中被取消的请求移出队列。 */
class Semaphore {
  private active = 0
  private waiters: Array<{ grant: () => void }> = []

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError())
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next.grant()
    else this.active -= 1
  }
}

export function modelHub(opts: ModelHubOptions): ModelHub {
  const clock = opts.clock ?? systemClock()
  const firstTokenMs = opts.timeouts?.firstTokenMs ?? DEFAULT_FIRST_TOKEN_MS
  const idleMs = opts.timeouts?.idleMs ?? DEFAULT_IDLE_MS
  const totalMs = opts.timeouts?.totalMs ?? DEFAULT_TOTAL_MS
  const semaphores = new Map<string, Semaphore>()
  const breakers = new Map<ModelRef, Breaker>()
  const ports = new Map<ModelRef, ModelPort>()
  const listeners = new Set<(status: BreakerStatus) => void>()

  const semaphoreOf = (providerId: string): Semaphore => {
    let s = semaphores.get(providerId)
    if (!s) {
      s = new Semaphore(opts.concurrency?.[providerId] ?? DEFAULT_CONCURRENCY)
      semaphores.set(providerId, s)
    }
    return s
  }

  const wrap = (providerId: string, port: ModelPort): ModelPort => {
    const breaker = createBreaker({
      key: port.ref,
      dependency: 'model',
      policy: opts.breaker,
      clock,
      onChange: (status) => listeners.forEach((fn) => fn(status)),
    })
    breakers.set(port.ref, breaker)
    const semaphore = semaphoreOf(providerId)

    return {
      ref: port.ref,
      // 每次读取都转给提供方：能力可能随应用配置变化，包装后的端口按引用缓存，不能在这里取快照
      get capabilities() {
        return port.capabilities
      },
      // 端口参数同样每次转给提供方，模型配置指纹读到的是当前配置。
      get settings() {
        return port.settings
      },
      async call(input, { signal, onDelta }) {
        await semaphore.acquire(signal)
        try {
          const ticket = breaker.admit()
          if (!ticket) throw failure('MODEL_UNAVAILABLE', '熔断打开', true)
          return await new Promise((resolve, reject) => {
            const controller = new AbortController()
            const cancels: Array<() => void> = []
            let settled = false
            let firstToken: (() => void) | undefined
            let idle: (() => void) | undefined

            const finish = (settle: () => void) => {
              if (settled) return
              settled = true
              firstToken?.()
              idle?.()
              cancels.forEach((cancel) => cancel())
              signal.removeEventListener('abort', onCallerAbort)
              settle()
            }
            const timeout = (label: string) => () =>
              finish(() => {
                controller.abort()
                ticket.onFailure()
                reject(failure('MODEL_TIMEOUT', `${label}超时`, true))
              })
            const onCallerAbort = () =>
              finish(() => {
                controller.abort()
                ticket.release()
                reject(abortError())
              })

            if (signal.aborted) return onCallerAbort()
            signal.addEventListener('abort', onCallerAbort, { once: true })
            firstToken = clock.setTimer(firstTokenMs, timeout('首 token '))
            cancels.push(clock.setTimer(totalMs, timeout('单次时长')))

            port
              .call(input, {
                signal: controller.signal,
                onDelta: (d) => {
                  if (settled) return
                  firstToken?.()
                  firstToken = undefined
                  idle?.()
                  idle = clock.setTimer(idleMs, timeout('空闲'))
                  onDelta(d)
                },
              })
              .then(
                (response) =>
                  finish(() => {
                    ticket.onSuccess()
                    resolve(response)
                  }),
                (error: unknown) =>
                  finish(() => {
                    if (!isModelCallError(error)) {
                      ticket.onSuccess()
                      reject(
                        failure('MODEL_ERROR', (error as Error)?.message ?? String(error), false),
                      )
                      return
                    }
                    if (isDependencyFailure(error.detail)) ticket.onFailure()
                    else ticket.onSuccess()
                    reject(error)
                  }),
              )
          })
        } finally {
          semaphore.release()
        }
      },
    }
  }

  return {
    defaultModel: opts.default,
    resolve(ref) {
      const cached = ports.get(ref)
      if (cached) return cached
      const providerId = ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : ref
      const provider = opts.providers.find((p) => p.id === providerId)
      const port = provider?.resolve(ref)
      if (!port) return undefined
      const wrapped = wrap(providerId, port)
      ports.set(ref, wrapped)
      return wrapped
    },
    price: (ref) => opts.pricing?.[ref],
    health: () => [...breakers.values()].map((b) => b.status()),
    onHealth(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
