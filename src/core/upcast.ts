// 事件升级器（设计 §8.5）：读取时把旧版本事件升级到当前版本。
// 当前只有版本 1；出现新版本时在这里按版本追加升级步骤。

import { SCHEMA_VERSION, type RunEvent } from '../contracts/events.js'

export function upcastEvent(event: RunEvent, fromVersion: number): RunEvent {
  if (fromVersion === SCHEMA_VERSION) return event
  throw new Error(`archive: 不支持的事件版本 ${fromVersion}`)
}
