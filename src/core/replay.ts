// 严格重放（设计 §6.5）：所有环节的结果直接从日志读取。逐条应用事件，核对每条事件属于状态机期望的环节，
// 得到最终状态、结果与投影；日志不一致时给出违规而不抛出，用于审计和排查。

import type { RunEvent } from '../contracts/events.js'
import type { QualityReport, RunResult } from '../contracts/run.js'
import { checkInvariants } from './invariants.js'
import { qualityOf } from './projections.js'
import { replayStages } from './stage-replay.js'
import type { RunState, TranscriptEntry } from './state.js'
import { buildTrace, type TraceNode } from './trace.js'

export interface StrictReplay {
  state: RunState
  result?: RunResult
  transcript: TranscriptEntry[]
  trace?: TraceNode
  quality?: QualityReport
  violations: Array<{ seq: number; message: string }>
}

export function strictReplay(events: readonly RunEvent[]): StrictReplay {
  const { state, violations } = replayStages(events)

  for (const v of checkInvariants(events)) {
    violations.push({ seq: v.seq ?? 0, message: `${v.invariant} ${v.message}` })
  }
  const trace = buildTrace(events)
  const quality = qualityOf(events)
  return {
    state,
    ...(state.result ? { result: state.result } : {}),
    transcript: [...state.transcript],
    ...(trace ? { trace } : {}),
    ...(quality ? { quality } : {}),
    violations,
  }
}
