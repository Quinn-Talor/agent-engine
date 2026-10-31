// 运行、断言与重放工具（设计 §13）：跑完一次运行并收集事件；断言 I1–I15；从档案读出运行做严格或回归重放。

import {
  checkInvariants,
  regressionReplay,
  strictReplay,
  type RegressionInput,
  type RegressionReport,
  type StrictReplay,
} from '../api.js'
import type { ArchiveStore, RunEvent } from '../contracts/events.js'
import type { Run, RunResult } from '../contracts/run.js'

const MAX_YIELDS = 1000
const yieldOnce = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * 订阅者的投递是异步的：结果返回后再等到收集到 run_ended。
 * 订阅者只收到已写入档案的事件：run_ended 写不进档案时（例如 chaos 的 `archive_write`）等待有上限，
 * 之后照样返回结果与已收到的事件，这时 `events` 里没有 run_ended。
 */
export async function runToEnd(run: Run): Promise<{ result: RunResult; events: RunEvent[] }> {
  const events: RunEvent[] = []
  run.subscribe({ onEvent: (e) => void events.push(e) })
  const result = await run.result
  for (let i = 0; i < MAX_YIELDS && events.at(-1)?.t !== 'run_ended'; i++) await yieldOnce()
  return { result, events }
}

export function assertInvariants(events: readonly RunEvent[]): void {
  const violations = checkInvariants(events)
  if (violations.length === 0) return
  const lines = violations.map((v) => `- ${v.invariant}（seq ${v.seq ?? '-'}）${v.message}`)
  throw new Error(`不变量违规：\n${lines.join('\n')}`)
}

export type RegressionMode = { mode: 'regression' } & Omit<RegressionInput, 'events' | 'getBlob'>

export function replay(archive: ArchiveStore, runId: string, mode: 'strict'): Promise<StrictReplay>
export function replay(
  archive: ArchiveStore,
  runId: string,
  mode: RegressionMode,
): Promise<RegressionReport>
export async function replay(
  archive: ArchiveStore,
  runId: string,
  mode: 'strict' | RegressionMode,
): Promise<StrictReplay | RegressionReport> {
  const events: RunEvent[] = []
  for await (const e of archive.read(runId)) events.push(e)
  if (mode === 'strict') return strictReplay(events)
  const { mode: _mode, ...components } = mode
  const decoder = new TextDecoder()
  return regressionReplay({
    ...components,
    events,
    getBlob: async (ref) => {
      const data = await archive.getBlob(ref)
      return typeof data === 'string' ? data : decoder.decode(data)
    },
  })
}
