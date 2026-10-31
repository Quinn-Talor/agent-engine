// 严格重放（设计 §6.5）：所有环节的结果直接从日志读取。逐条应用事件，核对每条事件属于状态机期望的环节，
// 得到最终状态、结果与投影；日志不一致时给出违规而不抛出，用于审计和排查。

import type { RunEvent } from '../contracts/events.js'
import type { QualityReport, RunResult } from '../contracts/run.js'
import { checkInvariants } from './invariants.js'
import { qualityOf } from './projections.js'
import {
  apply,
  initial,
  nextStage,
  type RunState,
  type Stage,
  type TranscriptEntry,
} from './state.js'
import { buildTrace, type TraceNode } from './trace.js'

type EventType = RunEvent['t']

/** 每个环节允许出现的事件；引导与 run_ended 在任何环节都可能出现（取消、引擎出错时驱动直接结束）。 */
const ALLOWED: Record<Stage, ReadonlySet<EventType>> = {
  prepare: new Set(['run_started', 'external_call']),
  compose: new Set(['step_started', 'intervention_applied', 'external_call', 'context_built']),
  reason: new Set(['model_responded', 'model_failed', 'model_aborted']),
  act: new Set(['permission_decided', 'approval_answered', 'tool_finished', 'external_call']),
  evaluate: new Set(['external_call', 'evaluated', 'step_ended']),
  deliver: new Set(['external_call', 'delivery_checked', 'fallback_generated']),
  end: new Set(),
}
const ANYWHERE = new Set<EventType>(['steer_received', 'run_ended'])

export interface StrictReplay {
  state: RunState
  result?: RunResult
  transcript: TranscriptEntry[]
  trace?: TraceNode
  quality?: QualityReport
  violations: Array<{ seq: number; message: string }>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const label = (o: { status: string; code?: string }) =>
  o.code === undefined ? o.status : `${o.status}/${o.code}`

/**
 * run_ended 的结局必须与状态机已得出的结局一致。例外：取消的结局由取消原因决定
 * （截止时间到为 stopped/timeout）；结束自检失败时执行器改为 failed/engine_error。
 */
function outcomeMismatch(state: RunState, result: RunResult): string | undefined {
  const outcome = state.outcome
  if (!outcome || outcome.status === 'aborted') return undefined
  if (result.status === 'failed' && result.code === 'engine_error') return undefined
  if (result.status === outcome.status && result.code === outcome.code) return undefined
  return `run_ended 的结局 ${label(result)} 与状态机的结局 ${label(outcome)} 不一致`
}

export function strictReplay(events: readonly RunEvent[]): StrictReplay {
  const ended = events.find((e) => e.t === 'run_ended')
  let state = initial({ runId: ended?.t === 'run_ended' ? ended.result.runId : '' })
  const violations: StrictReplay['violations'] = []
  let stage: Stage | null = 'prepare'

  for (const e of events) {
    // 批内的中间相位（composing、evaluated）没有下一环节：沿用上一个合法环节。
    try {
      stage = nextStage(state)
    } catch {
      // 保留 stage。
    }
    if (stage && !ANYWHERE.has(e.t) && !ALLOWED[stage].has(e.t)) {
      violations.push({ seq: e.seq, message: `seq ${e.seq}：${e.t} 不应出现在 ${stage} 环节` })
    }
    const mismatch = e.t === 'run_ended' ? outcomeMismatch(state, e.result) : undefined
    if (mismatch) violations.push({ seq: e.seq, message: `seq ${e.seq}：${mismatch}` })
    try {
      state = apply(state, e)
    } catch (error) {
      violations.push({ seq: e.seq, message: `seq ${e.seq}：${messageOf(error)}` })
      break
    }
  }

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
