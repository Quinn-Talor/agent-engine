// 控制台诊断日志（设计 §6.6）：引擎默认的 Logger。按级别过滤，写入前按模式脱敏；
// 运行凭据的脱敏由引擎在外层包装。

import { redactText, redactValue } from '../../api.js'
import type { LogLevel, Logger } from '../../contracts/common.js'

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

type Sink = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>

export function consoleLogger(opts: { level?: LogLevel; sink?: Sink } = {}): Logger {
  const min = ORDER[opts.level ?? 'info']
  const sink = opts.sink ?? globalThis.console
  return {
    log(entry) {
      if (ORDER[entry.level] < min) return
      const line = `[agent-engine] ${entry.level} ${redactText(entry.message)}`
      const context = Object.fromEntries(
        Object.entries({
          runId: entry.runId,
          step: entry.step,
          source: entry.source,
          detail: entry.detail,
        }).filter(([, v]) => v !== undefined),
      )
      if (Object.keys(context).length === 0) sink[entry.level](line)
      else sink[entry.level](line, redactValue(context))
    },
  }
}
