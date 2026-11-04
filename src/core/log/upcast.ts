// 事件升级器（设计 §8.5）：读取时把旧版本事件升级到当前版本。
// 版本 2：`run_started.modelFingerprint` 与 `RunUsage.tools` 成为必填。

import { SCHEMA_VERSION, type RunEvent } from '../../contracts/events.js'
import { modelFingerprint } from '../definition/fingerprint.js'

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** 版本 1 → 2：补上新的必填字段；旧日志里端口没有声明参数，工具也没有经引擎调用过模型。 */
function fromVersion1(event: RunEvent): RunEvent {
  if (event.t === 'run_started' && event.modelFingerprint === undefined) {
    return { ...event, modelFingerprint: modelFingerprint(undefined) }
  }
  if (event.t === 'run_ended' && event.result.usage.tools === undefined) {
    return {
      ...event,
      result: { ...event.result, usage: { ...event.result.usage, tools: zero() } },
    }
  }
  return event
}

export function upcastEvent(event: RunEvent, fromVersion: number): RunEvent {
  if (fromVersion === SCHEMA_VERSION) return event
  if (fromVersion === 1) return fromVersion1(event)
  throw new Error(`archive: 不支持的事件版本 ${fromVersion}`)
}
