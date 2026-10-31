// 测试时钟（设计 §13）：手动推进时间，按到期顺序触发计时器；推进时清空微任务，
// 让被唤醒的 Promise 续体在下一个计时器之前执行。

import type { Clock } from '../contracts/common.js'

interface Timer {
  id: number
  due: number
  fn: () => void
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

export class FakeClock implements Clock {
  private current: number
  private timers: Timer[] = []
  private nextId = 0

  constructor(start = 0) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  setTimer(ms: number, fn: () => void): () => void {
    const timer: Timer = { id: this.nextId++, due: this.current + Math.max(0, ms), fn }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter((t) => t !== timer)
    }
  }

  /** 推进 `ms` 毫秒，依次触发到期的计时器；时间只能前进，负数与非有限数直接拒绝。 */
  async tick(ms: number): Promise<void> {
    if (!(Number.isFinite(ms) && ms >= 0)) {
      throw new RangeError(`FakeClock.tick：时长必须是非负有限数：${ms}`)
    }
    const target = this.current + ms
    await flush()
    for (;;) {
      const next = this.earliest()
      if (!next || next.due > target) break
      this.timers = this.timers.filter((t) => t !== next)
      this.current = next.due
      next.fn()
      await flush()
    }
    this.current = target
    await flush()
  }

  pending(): number {
    return this.timers.length
  }

  private earliest(): Timer | undefined {
    let best: Timer | undefined
    for (const t of this.timers) {
      if (!best || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t
    }
    return best
  }
}
