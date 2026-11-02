// 逐环节重放（设计 §6.5）：逐条应用事件，核对每条事件属于状态机期望的环节、run_ended 的结局与状态一致。
// 只看事件序列本身，不含不变量检查；严格重放与不变量的完整检查（I10）共用。

import type { RunEvent } from '../../contracts/events.js'
import type { RunResult } from '../../contracts/run.js'
import { apply, initial, nextStage, type RunState, type Stage } from '../run/state.js'

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

export interface StageReplay {
  state: RunState
  violations: Array<{ seq: number; message: string }>
}

export function replayStages(events: readonly RunEvent[]): StageReplay {
  const ended = events.find((e) => e.t === 'run_ended')
  let state = initial({ runId: ended?.t === 'run_ended' ? ended.result.runId : '' })
  const violations: StageReplay['violations'] = []
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
  return { state, violations }
}
