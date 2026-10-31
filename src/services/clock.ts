// 系统时钟：真实时间的 Clock 实现，引擎默认使用；测试使用 FakeClock。

import type { Clock } from '../contracts/common.js'

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    setTimer(ms, fn) {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    },
  }
}
