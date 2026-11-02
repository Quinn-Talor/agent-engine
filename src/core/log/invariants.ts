// 不变量检查（设计 §6.3、§7、§13）。结束时的自检：I1、I2、I11、I13、I14、I15、I16 与观测树完整性；
// 完整检查（测试用）再加 I4、I5、I6、I7、I9、I10。I3、I8、I12 不能只从单个运行的日志判断。
// 一次遍历事件，违规按发现顺序返回。

import { MODEL_ERROR_CODES } from '../../contracts/errors.js'
import type { RunEvent } from '../../contracts/events.js'
import { replayStages } from './stage-replay.js'

export interface InvariantViolation {
  invariant:
    | 'I1'
    | 'I2'
    | 'I4'
    | 'I5'
    | 'I6'
    | 'I7'
    | 'I9'
    | 'I10'
    | 'I11'
    | 'I13'
    | 'I14'
    | 'I15'
    | 'I16'
    | 'trace'
  message: string
  seq?: number
}

export interface InvariantOptions {
  /** 完整检查：加上只适合在测试里做的检查；运行结束时的自检不传，违规会让运行失败。 */
  complete?: boolean
}

type Report = (invariant: InvariantViolation['invariant'], message: string, seq?: number) => void
const MODEL_CODES: ReadonlySet<string> = new Set(MODEL_ERROR_CODES)

const BEFORE_START = new Set<RunEvent['t']>(['external_call', 'steer_received'])
/** 守卫的来源前缀；核心内置的 `guard:*` 与意图不受 I16 约束。 */
const GUARD_SOURCE = /^(task|environment|capability|engine):/

export function checkInvariants(
  events: readonly RunEvent[],
  opts: InvariantOptions = {},
): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const report: Report = (invariant, message, seq) =>
    violations.push(seq === undefined ? { invariant, message } : { invariant, message, seq })

  // 成对按步检查：提供方可能在不同步里复用调用 id。
  let pending = new Set<string>()
  let finished = new Set<string>()
  const flushPending = (seq: number) => {
    for (const id of pending) report('I2', `工具调用 ${id} 没有结果`, seq)
    pending = new Set()
    finished = new Set()
  }

  let started = false
  let invalidBeforeStart = false
  let openStep: number | undefined
  let lastStep = 0
  let runEnded = 0
  /** I16：运行开始或最近一次引导之后告知过的守卫来源。 */
  let warned = new Set<string>()

  events.forEach((e, i) => {
    const prev = events[i - 1]
    const expectedSeq = prev ? prev.seq + 1 : 1
    if (e.seq !== expectedSeq)
      report('I13', `seq 不连续：期望 ${expectedSeq}，实际 ${e.seq}`, e.seq)
    if (prev && e.at < prev.at) report('I13', `时间倒退：${prev.at} → ${e.at}`, e.seq)

    switch (e.t) {
      case 'run_started':
        if (started) report('I14', '出现第二条 run_started', e.seq)
        else if (invalidBeforeStart) report('I14', 'run_started 之前出现了其他事件', e.seq)
        started = true
        break
      case 'step_started':
        flushPending(e.seq)
        if (openStep !== undefined) report('trace', `第 ${openStep} 步缺少 step_ended`, e.seq)
        if (e.step !== lastStep + 1) {
          report('trace', `步编号不连续：期望 ${lastStep + 1}，实际 ${e.step}`, e.seq)
        }
        openStep = e.step
        lastStep = e.step
        break
      case 'step_ended':
        if (openStep === e.step) openStep = undefined
        break
      case 'model_responded':
        for (const c of e.response.toolCalls) pending.add(c.id)
        break
      case 'tool_finished':
        if (finished.has(e.callId)) {
          report('I15', `工具调用 ${e.callId} 出现了多个结果`, e.seq)
        } else if (pending.has(e.callId)) {
          pending.delete(e.callId)
          finished.add(e.callId)
        } else {
          report('I2', `工具结果 ${e.callId} 没有对应的调用`, e.seq)
        }
        break
      case 'permission_decided':
        if (!e.source) report('I11', `权限裁决 ${e.callId} 缺少来源`, e.seq)
        break
      case 'evaluated': {
        if (e.verdict.sources.length === 0) report('I11', `第 ${e.step} 步的裁决缺少来源`, e.seq)
        if (e.observation.interventions.applied.some((a) => a.kind === 'steer')) warned = new Set()
        // 先检查本步裁决，再记下本步的告知：同一步的告知不算"之前告知过"。
        const v = e.verdict
        const end = 'finalize' in v || ('stop' in v && !v.stop.code.startsWith('guard_error:'))
        if (end) {
          for (const source of v.sources.filter((s) => GUARD_SOURCE.test(s))) {
            if (!warned.has(source))
              report('I16', `第 ${e.step} 步：${source} 终止前没有告知`, e.seq)
          }
        }
        for (const r of e.opinions) {
          if (r.mode === 'active' && r.opinion && 'continue' in r.opinion) warned.add(r.source)
        }
        break
      }
      case 'delivery_checked':
        if (e.checks.some((c) => !c.source)) report('I11', `第 ${e.step} 步的验收缺少来源`, e.seq)
        break
      case 'run_ended':
        flushPending(e.seq)
        runEnded += 1
        openStep = undefined
        break
    }
    if (!started && e.t !== 'run_started' && !BEFORE_START.has(e.t) && e.t !== 'run_ended') {
      invalidBeforeStart = true
    }
  })

  const last = events[events.length - 1]
  if (runEnded !== 1 || last?.t !== 'run_ended') {
    report('I1', `运行必须以恰好一条 run_ended 结束（实际 ${runEnded} 条）`)
  }
  if (opts.complete) checkComplete(events, report)
  return violations
}

/** 完整检查：I4 可见工具 ⊆ 已准备；I5 出错有错误码；I6 completed 必经定稿；I7 超限不调模型；I9 模型错误有分类码；I10 严格重放。 */
function checkComplete(events: readonly RunEvent[], report: Report): void {
  const prepared = new Set<string>()
  let contextLimit: number | undefined
  let overLimitStep: number | undefined
  let lastDelivery: Extract<RunEvent, { t: 'delivery_checked' }> | undefined
  for (const e of events) {
    switch (e.t) {
      case 'run_started':
        for (const c of e.capabilities) for (const t of c.tools) prepared.add(t.name)
        contextLimit = e.contextLimit
        break
      case 'context_built': {
        const unknown = e.tools.filter((name) => !prepared.has(name))
        if (unknown.length > 0) {
          report('I4', `第 ${e.step} 步可见的工具不在已准备之列：${unknown.join(', ')}`, e.seq)
        }
        overLimitStep =
          contextLimit !== undefined && e.estimate >= contextLimit ? e.step : undefined
        break
      }
      case 'model_responded':
      case 'model_failed':
        if (overLimitStep === e.step) {
          report('I7', `第 ${e.step} 步上下文估算已达上限，仍调用了模型`, e.seq)
        }
        break
      case 'tool_finished':
        if (e.isError && !e.errorCode) report('I5', `工具调用 ${e.callId} 出错但没有错误码`, e.seq)
        break
      case 'delivery_checked':
        lastDelivery = e
        break
      case 'run_ended': {
        const r = e.result
        const delivered =
          lastDelivery?.path === 'normal' &&
          lastDelivery.outcome === 'delivered' &&
          lastDelivery.output.ok
        if (r.status === 'completed' && !delivered) {
          report('I6', '以 completed 结束，但最后一次交付检查不是正常路径的定稿', e.seq)
        }
        if (
          r.status === 'failed' &&
          r.code === 'model_error' &&
          !MODEL_CODES.has(r.error?.code ?? '')
        ) {
          report('I9', `model_error 缺少分类后的错误码（${r.error?.code ?? '无'}）`, e.seq)
        }
        break
      }
    }
  }
  for (const v of replayStages(events).violations) report('I10', v.message, v.seq)
}
