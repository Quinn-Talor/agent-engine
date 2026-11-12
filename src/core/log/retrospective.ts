// 复盘投影（设计 §10.8）：确定性地由运行日志推导时间线（守卫信号、干预、审批、模型失败、压缩）、
// 每步的模型尝试次数与工具成败、交付记录与每条验收的结论、结束原因、已执行的副作用、用量、排队与耗时、
// 子运行概况（patterns P7）。

import type { CheckMode } from '../../contracts/component.js'
import type { ModelErrorCode } from '../../contracts/errors.js'
import type { CompactionReason, RunEvent } from '../../contracts/events.js'
import type { RunUsage } from '../../contracts/model.js'
import type { RunStatus } from '../../contracts/run.js'
import { foldState } from './projections.js'
import { sideEffects, type SideEffect } from './projections.js'

export type RetrospectiveEntry =
  | {
      step: number
      kind: 'signal'
      source: string
      signal: 'warn' | 'end' | 'awaitInput'
      detail?: string
      deferred?: true
    }
  | { step: number; kind: 'intervention'; intervention: 'hint' | 'block'; source: string }
  | {
      step: number
      kind: 'approval'
      callId: string
      answer: 'approved' | 'denied' | 'deferred'
      waitedMs: number
    }
  | { step: number; kind: 'model_failed'; code: ModelErrorCode; attempts: number }
  /** 只在压缩发生变化的那一步出现；之后沿用同一压缩的步不算。 */
  | { step: number; kind: 'compaction'; reason: CompactionReason }

export interface RunRetrospective {
  runId: string
  end?: { status: RunStatus; code?: string; message?: string }
  /** 准入排队时长；没有 run_started 时没有。 */
  queuedMs?: number
  timeline: RetrospectiveEntry[]
  /** 每步一条（模型调用成功的步）；`attempts` 是这次模型调用实际发出的请求数，含重试。 */
  steps: Array<{
    step: number
    attempts: number
    tools: Array<{ name: string; ok: boolean; errorCode?: string }>
  }>
  deliveries: Array<{
    step: number
    path: 'normal' | 'fallback'
    attempt: number
    outcome: string
    issues: string[]
    /** 输出校验（source 为 output）与每条验收的结论。 */
    checks: Array<{ source: string; mode: CheckMode; pass: boolean }>
  }>
  sideEffects: SideEffect[]
  children: Array<{ callId: string; childRunId: string; ok: boolean }>
  usage: RunUsage
  durationMs?: number
  toolCalls: number
}

type Of<T extends RunEvent['t']> = Extract<RunEvent, { t: T }>

/** 工具结果按步配对：提供方可能在不同步里复用调用 id。 */
const callKey = (step: number, callId: string) => `${step}\u0000${callId}`

export function retrospective(events: readonly RunEvent[]): RunRetrospective {
  const finished = new Map<string, Of<'tool_finished'>>()
  let step = 0
  for (const e of events) {
    if (e.t === 'step_started') step = e.step
    else if (e.t === 'tool_finished') finished.set(callKey(step, e.callId), e)
  }

  const retro: RunRetrospective = {
    runId: '',
    timeline: [],
    steps: [],
    deliveries: [],
    sideEffects: sideEffects(events),
    children: [],
    usage: foldState(events).usage,
    toolCalls: finished.size,
  }
  let startedAt: number | undefined
  let current = 0
  for (const e of events) {
    switch (e.t) {
      case 'run_started':
        startedAt = e.at
        retro.queuedMs = e.queuedMs
        break
      case 'step_started':
        current = e.step
        break
      case 'context_built':
        if (e.compaction?.reason) {
          retro.timeline.push({ step: e.step, kind: 'compaction', reason: e.compaction.reason })
        }
        break
      case 'model_responded':
        retro.steps.push({
          step: e.step,
          attempts: Math.max(1, e.response.attempts.length),
          tools: e.response.toolCalls.map((c) => {
            const f = finished.get(callKey(e.step, c.id))
            const ok = f !== undefined && !f.isError
            return f?.errorCode !== undefined
              ? { name: c.name, ok, errorCode: f.errorCode }
              : { name: c.name, ok }
          }),
        })
        break
      case 'model_failed':
        retro.timeline.push({
          step: e.step,
          kind: 'model_failed',
          code: e.error.code,
          attempts: e.error.attempts.length,
        })
        break
      case 'approval_answered':
        // 审批答复不带步号：取当时所在的步。
        retro.timeline.push({
          step: current,
          kind: 'approval',
          callId: e.callId,
          answer: e.deferred ? 'deferred' : e.approved ? 'approved' : 'denied',
          waitedMs: e.waitedMs,
        })
        break
      case 'evaluated':
        for (const r of e.opinions) {
          if (r.mode !== 'active' || !r.opinion || 'complete' in r.opinion) continue
          const signal =
            'continue' in r.opinion ? 'warn' : 'awaitInput' in r.opinion ? 'awaitInput' : 'end'
          retro.timeline.push({
            step: e.step,
            kind: 'signal',
            source: r.source,
            signal,
            ...(r.detail !== undefined ? { detail: r.detail } : {}),
            ...(r.deferred ? { deferred: true as const } : {}),
          })
        }
        break
      case 'intervention_applied':
        retro.timeline.push({
          step: e.step,
          kind: 'intervention',
          intervention: 'hint' in e.intervention ? 'hint' : 'block',
          source: e.source,
        })
        break
      case 'tool_finished':
        for (const childRunId of e.childRunIds ?? (e.childRunId ? [e.childRunId] : [])) {
          retro.children.push({ callId: e.callId, childRunId, ok: !e.isError })
        }
        break
      case 'delivery_checked':
        retro.deliveries.push({
          step: e.step,
          path: e.path,
          attempt: e.attempt,
          outcome: e.outcome,
          issues: [
            ...(e.output.issues ?? []),
            ...e.checks.filter((c) => !c.pass).flatMap((c) => c.issues ?? []),
          ],
          checks: [
            { source: 'output', mode: 'gate', pass: e.output.ok },
            ...e.checks.map(({ source, mode, pass }) => ({ source, mode, pass })),
          ],
        })
        break
      case 'run_ended': {
        const { status, code, error } = e.result
        retro.runId = e.result.runId
        retro.end = {
          status,
          ...(code !== undefined ? { code } : {}),
          ...(error ? { message: error.message } : {}),
        }
        if (startedAt !== undefined) retro.durationMs = e.at - startedAt
        break
      }
    }
  }
  return retro
}
