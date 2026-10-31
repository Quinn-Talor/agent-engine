// 熔断器（设计 §5.2）：关闭 → 打开 → 半开。默认连续失败 5 次打开；冷却 30 秒后半开，放行 1 次探测。
// 熔断跟着依赖走：模型库按模型、MCP 连接池按服务器、能力宿主按工具各自创建。
// 放行的调用拿到一张凭证，结果经凭证上报：只有探测凭证占用、归还探测名额；熔断在放行之后打开过的调用，
// 迟到的失败不再计入（不会重新打开、重置冷却）。

import type { Clock } from '../contracts/common.js'
import type { BreakerStatus } from '../contracts/engine.js'
import type { BreakerPolicy } from '../contracts/model.js'

const DEFAULT_THRESHOLD = 5
const DEFAULT_COOLDOWN_MS = 30_000

/** 一次放行的调用；每张凭证只上报一次结果，之后的上报被忽略。 */
export interface BreakerTicket {
  onSuccess(): void
  onFailure(): void
  /** 调用被取消、没有结果：探测凭证归还探测名额，不改变状态。 */
  release(): void
}

export interface Breaker {
  readonly key: string
  /** 放行一次调用并返回凭证，不放行时返回 undefined；半开时只发一张探测凭证。 */
  admit(): BreakerTicket | undefined
  /** 不经放行的依赖事件（例如连接意外断开）直接计入。 */
  onSuccess(): void
  onFailure(): void
  /** 打开且仍在冷却中：此时调用会被直接拒绝（只读，不占用探测名额）。 */
  cooling(): boolean
  status(): BreakerStatus
}

export function createBreaker(opts: {
  key: string
  dependency: BreakerStatus['dependency']
  policy?: BreakerPolicy
  clock: Clock
  onChange?: (status: BreakerStatus) => void
}): Breaker {
  const threshold = opts.policy?.failureThreshold ?? DEFAULT_THRESHOLD
  const cooldown = opts.policy?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  let state: BreakerStatus['state'] = 'closed'
  let since = opts.clock.now()
  let failures = 0
  /** 打开的次数：凭证记下放行时的值，之后打开过的凭证的失败不再计入。 */
  let openings = 0
  let probe: BreakerTicket | undefined

  const status = (): BreakerStatus => ({ key: opts.key, dependency: opts.dependency, state, since })
  const moveTo = (next: BreakerStatus['state']) => {
    if (next === state) return
    if (next === 'open') openings += 1
    probe = undefined
    state = next
    since = opts.clock.now()
    opts.onChange?.(status())
  }
  const succeed = () => {
    failures = 0
    moveTo('closed')
  }
  const fail = () => {
    failures += 1
    // 探测失败立即重新打开；关闭状态下连续失败达到阈值才打开。
    if (state === 'half_open' || (state === 'closed' && failures >= threshold)) moveTo('open')
  }

  const ticket = (): BreakerTicket => {
    const opening = openings
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      if (probe === t) probe = undefined
      fn()
    }
    const t: BreakerTicket = {
      onSuccess: () => settle(succeed),
      onFailure: () =>
        settle(() => {
          if (opening === openings) fail()
        }),
      release: () => settle(() => undefined),
    }
    return t
  }

  return {
    key: opts.key,
    admit() {
      if (state === 'open') {
        if (opts.clock.now() - since < cooldown) return undefined
        moveTo('half_open')
      } else if (state === 'closed') return ticket()
      if (probe) return undefined
      probe = ticket()
      return probe
    },
    onSuccess: succeed,
    onFailure: fail,
    cooling: () => state === 'open' && opts.clock.now() - since < cooldown,
    status,
  }
}
