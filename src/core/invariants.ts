// 结束时的不变量自检（设计 §6.3、§7）：I2、I11、I13、I14、I15、I16 与观测树完整性。
// 一次遍历事件，违规按发现顺序返回。

import type { RunEvent } from '../contracts/events.js'

export interface InvariantViolation {
  invariant: 'I2' | 'I11' | 'I13' | 'I14' | 'I15' | 'I16' | 'trace'
  message: string
  seq?: number
}

const BEFORE_START = new Set<RunEvent['t']>(['external_call', 'steer_received'])
/** 守卫的来源前缀；核心内置的 `guard:*` 与意图不受 I16 约束。 */
const GUARD_SOURCE = /^(task|environment|capability|engine):/

export function checkInvariants(events: readonly RunEvent[]): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const report = (invariant: InvariantViolation['invariant'], message: string, seq?: number) =>
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
    report('trace', `运行必须以恰好一条 run_ended 结束（实际 ${runEnded} 条）`)
  }
  return violations
}
