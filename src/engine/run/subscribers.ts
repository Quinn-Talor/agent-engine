// 订阅与通知（设计 §4.4、§6.2）：订阅者先从日志补齐，再各自按顺序异步收到新事件，不拖住写入；
// 瞬时通知同步推送；订阅者出错只记日志。交付通知扣到定稿写进日志之后再发。

import type { Clock, LogLevel } from '../../contracts/common.js'
import type { RunEvent } from '../../contracts/events.js'
import type { Notice, Run, RunSubscriber } from '../../contracts/run.js'
import { settlesWithin } from './run-abort.js'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface Subscription {
  sub: RunSubscriber
  chain: Promise<void>
  /** 也接收子运行的事件与通知。 */
  children: boolean
  /** 在子运行上的订阅，退订时一起退。 */
  detach: Array<() => void>
}

export interface SubscribersDeps {
  runId: string
  clock: Clock
  /** 已写入日志的事件：新订阅者从这里补齐。 */
  events(): readonly RunEvent[]
  /** 进行中的子运行：要子运行事件的新订阅者挂上去。 */
  childRuns(): Iterable<Run>
  log(level: LogLevel, message: string, detail?: unknown): void
}

export interface Subscribers {
  subscribe: Run['subscribe']
  /** 一批已写入日志的事件：订阅者各自按顺序异步收到，不拖住写入（设计 §4.4）。 */
  publish(batch: readonly RunEvent[]): void
  notify(notice: Notice): void
  /** 扣下交付通知，等 release 再发。 */
  hold(notice: Notice): void
  /** 定稿写进了日志（settled）才发出扣下的交付通知，否则丢掉。 */
  release(settled: boolean): void
  /** 新开的子运行：已有的、要子运行事件的订阅者挂上去。 */
  attachChild(run: Run): void
  /** 最后一次交付通知带的文本与结构化输出。 */
  delivered(): { text?: string; output?: unknown } | undefined
  /** 结束时等订阅者处理完已发出的事件，最多等 ms；卡住的订阅者不拖住运行（设计 §4.4）。 */
  drain(ms: number): Promise<void>
}

export function createSubscribers(deps: SubscribersDeps): Subscribers {
  const { runId, clock, log } = deps
  const subscribers = new Set<Subscription>()
  let held: Notice | undefined
  let delivered: { text?: string; output?: unknown } | undefined

  const deliverTo = (s: Subscription, batch: readonly RunEvent[]): Promise<void> => {
    s.chain = s.chain.then(async () => {
      for (const e of batch) {
        if (!subscribers.has(s)) return
        try {
          await s.sub.onEvent?.(e, { runId })
        } catch (error) {
          log('warn', '订阅者出错', { error: messageOf(error) })
        }
      }
    })
    return s.chain
  }

  const notify = (notice: Notice) => {
    if (notice.t === 'delivered') {
      delivered = {
        ...(notice.text !== undefined ? { text: notice.text } : {}),
        ...(notice.output !== undefined ? { output: notice.output } : {}),
      }
    }
    for (const s of subscribers) {
      try {
        s.sub.onNotice?.(notice, { runId })
      } catch (error) {
        log('warn', '订阅者出错', { error: messageOf(error) })
      }
    }
  }

  return {
    subscribe(sub, opts) {
      const children = opts?.children === true
      const s: Subscription = { sub, chain: Promise.resolve(), children, detach: [] }
      subscribers.add(s)
      const fromSeq = opts?.fromSeq ?? 1
      void deliverTo(
        s,
        deps.events().filter((e) => e.seq >= fromSeq),
      )
      if (children) {
        for (const child of deps.childRuns()) s.detach.push(child.subscribe(sub, { children }))
      }
      return () => {
        subscribers.delete(s)
        for (const off of s.detach.splice(0)) off()
      }
    },
    publish(batch) {
      for (const s of subscribers) void deliverTo(s, batch)
    },
    notify,
    hold(notice) {
      held = notice
    },
    release(settled) {
      const notice = held
      held = undefined
      if (notice && settled) notify(notice)
    },
    attachChild(run) {
      for (const s of subscribers) {
        if (s.children) s.detach.push(run.subscribe(s.sub, { children: true }))
      }
    },
    delivered: () => delivered,
    async drain(ms) {
      if (subscribers.size === 0) return
      const chains = Promise.all([...subscribers].map((s) => s.chain))
      if (!(await settlesWithin(clock, chains, ms))) {
        log('warn', `订阅者 ${ms}ms 内没有处理完事件`)
      }
    },
  }
}
