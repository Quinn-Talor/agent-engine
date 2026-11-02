// 运行结果（设计 §2、§3.14）：由最终状态、取消、失败与交付通知得出结局和交给调用方的结果；
// 写 run_ended 之前带上它自检不变量，不满足时按引擎出错失败。

import type { RunEvent } from '../../contracts/events.js'
import type { ModelRef } from '../../contracts/model.js'
import type { RunResult, RunStatus } from '../../contracts/run.js'
import { runCost } from '../../core/supervision/facts.js'
import { copyData } from '../../core/definition/freeze.js'
import { checkInvariants, type InvariantViolation } from '../../core/log/invariants.js'
import { qualityOf } from '../../core/log/projections.js'
import type { RunState } from '../../core/run/state.js'
import type { Admitted } from './admit.js'
import type { AbortReason } from './run-abort.js'

export type Outcome = {
  status: RunStatus
  code?: string
  message?: string
  error?: RunResult['error']
}

/** 没走到结局的原因：拒绝执行、受理或准入失败、准备失败、引擎出错。 */
export interface Failure {
  code: string
  message: string
  status?: RunStatus
}

const ABORT_OUTCOME: Record<AbortReason, Outcome> = {
  user: { status: 'aborted', code: 'user' },
  parent: { status: 'aborted', code: 'parent' },
  shutdown: { status: 'aborted', code: 'interrupted' },
  deadline: { status: 'stopped', code: 'timeout' },
}

const INTENT_STATUSES = new Set<RunStatus>(['completed', 'awaiting_input', 'stopped'])

export interface Ending {
  runId: string
  state: RunState
  events: readonly RunEvent[]
  abortReason: AbortReason | undefined
  /** 取消到达时是否已有结局。 */
  outcomeBeforeAbort: boolean
  failure: Failure | undefined
  /** 最后一次交付通知带的文本与结构化输出。 */
  delivered: { text?: string; output?: unknown } | undefined
  admitted: Pick<Admitted, 'model' | 'price'> | undefined
  /** 受理失败时试过的模型。 */
  attemptedModel: ModelRef | undefined
}

export function outcomeOf(
  e: Pick<Ending, 'state' | 'abortReason' | 'outcomeBeforeAbort' | 'failure'>,
): Outcome {
  const { abortReason, failure } = e
  const o = e.state.outcome
  // 取消先于结局到达：按取消结束，不算完成或收尾（设计 §3.14 取消后不再交付）。
  const cancelledFirst =
    abortReason !== undefined &&
    ABORT_OUTCOME[abortReason].status === 'aborted' &&
    !e.outcomeBeforeAbort
  if (o && o.status !== 'aborted' && !cancelledFirst) return o
  if (abortReason) return ABORT_OUTCOME[abortReason]
  if (failure) {
    return { status: failure.status ?? 'failed', code: failure.code, message: failure.message }
  }
  return { status: 'failed', code: 'engine_error', message: '运行未正常结束' }
}

export function buildResult(e: Ending): RunResult {
  const { runId, state, delivered, admitted } = e
  const o = outcomeOf(e)
  const candidate = state.candidate
  const text =
    delivered?.text ??
    // 时间到停止时，最后一步的文本只是过程中的话（"我先查一下"），不当交付。
    ((o.status === 'awaiting_input' || (o.status === 'stopped' && o.code !== 'timeout')) &&
    candidate?.text
      ? candidate.text
      : undefined) ??
    (o.code === 'notice_blocked' ? o.message : undefined)
  const intent =
    candidate?.intent && o.code === candidate.intent.code && INTENT_STATUSES.has(o.status)
      ? { tool: candidate.intent.tool, input: candidate.intent.input }
      : undefined
  const error =
    o.status !== 'failed'
      ? undefined
      : (o.error ?? {
          code: o.code ?? 'engine_error',
          message: o.message ?? o.code ?? 'engine_error',
          retryable: o.code === 'admission_timeout',
        })
  const quality = qualityOf(e.events)
  const price = admitted?.price
  const cost = price ? runCost(state, price) : state.childCost > 0 ? state.childCost : undefined
  // 交给调用方的是普通的可变副本：状态里的值来自冻结的日志事件，不随输出契约有没有 schema 而不同。
  return copyData({
    runId,
    status: o.status,
    ...(o.code !== undefined ? { code: o.code } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(delivered?.output !== undefined ? { output: delivered.output } : {}),
    ...(intent ? { intent } : {}),
    ...(error ? { error } : {}),
    ...(quality ? { quality } : {}),
    model: state.model ?? admitted?.model ?? e.attemptedModel ?? '',
    usage: state.usage,
    ...(cost !== undefined ? { cost } : {}),
    steps: state.step,
    toolCalls: state.toolCallCount,
  })
}

/** 带上 run_ended（seq、at 为它将写入时的值）自检不变量；不满足时改为 engine_error 失败。 */
export function checkResult(
  result: RunResult,
  events: readonly RunEvent[],
  end: { seq: number; at: number },
): { result: RunResult; violations: InvariantViolation[] } {
  const violations = checkInvariants([...events, { t: 'run_ended', result, ...end }])
  if (violations.length === 0) return { result, violations }
  const message = violations.map((v) => `${v.invariant} ${v.message}`).join('；')
  return {
    result: {
      ...result,
      status: 'failed',
      code: 'engine_error',
      error: { code: 'engine_error', message, retryable: false },
    },
    violations,
  }
}
