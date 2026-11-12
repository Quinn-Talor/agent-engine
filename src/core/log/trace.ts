// Trace 投影（设计 §6.6）：运行 → 步 → 模型调用 / 工具 / 外部调用 / 反思参与者 / 交付验收，时间信息全部取自运行日志。

import type { RunEvent } from '../../contracts/events.js'

export interface TraceNode {
  kind: 'run' | 'step' | 'model' | 'tool' | 'external' | 'opinion' | 'check'
  name: string
  startedAt: number
  durationMs?: number
  attrs: Record<string, unknown>
  children: TraceNode[]
}

const node = (
  kind: TraceNode['kind'],
  name: string,
  startedAt: number,
  durationMs: number | undefined,
  attrs: Record<string, unknown>,
): TraceNode => ({
  kind,
  name,
  startedAt,
  ...(durationMs !== undefined ? { durationMs } : {}),
  attrs,
  children: [],
})

/** 只保留有值的属性。 */
const defined = (attrs: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined))

export function buildTrace(events: readonly RunEvent[]): TraceNode | undefined {
  if (events.length === 0) return undefined
  const started = events.find((e) => e.t === 'run_started')
  const run = node('run', 'run', started?.at ?? events[0]!.at, undefined, {})
  if (started?.t === 'run_started') {
    run.attrs.queuedMs = started.queuedMs
    run.attrs.model = started.model
    run.attrs.agentId = started.agent.id
    // 会话的一轮：子运行的 run_started 没有 session，不推算。
    if (started.session) {
      run.attrs.session = started.session.id
      run.attrs.turn = started.session.turn
    }
  }

  const toolNames = new Map<string, string>()
  const waited = new Map<string, number>()
  let step: TraceNode | undefined
  const container = () => step ?? run

  for (const e of events) {
    switch (e.t) {
      case 'step_started':
        step = node('step', `step ${e.step}`, e.at, undefined, {})
        run.children.push(step)
        break
      case 'step_ended':
        if (step) step.durationMs = e.at - step.startedAt
        step = undefined
        break
      case 'model_responded':
        for (const c of e.response.toolCalls) toolNames.set(c.id, c.name)
        container().children.push(
          node(
            'model',
            'model',
            e.startedAt,
            e.at - e.startedAt,
            defined({
              firstTokenAt: e.firstTokenAt,
              attempts: e.response.attempts,
              finishReason: e.response.finishReason,
              usage: e.response.usage,
            }),
          ),
        )
        break
      case 'model_failed':
        container().children.push(
          node('model', 'model', e.startedAt, e.at - e.startedAt, {
            error: e.error.code,
            attempts: e.error.attempts,
          }),
        )
        break
      case 'approval_answered':
        waited.set(e.callId, e.waitedMs)
        break
      case 'tool_finished': {
        const name = toolNames.get(e.callId) ?? e.callId
        const tool = node(
          'tool',
          name,
          e.startedAt,
          e.durationMs,
          defined({
            callId: e.callId,
            capability: e.capability,
            isError: e.isError,
            errorCode: e.errorCode,
            childRunId: e.childRunId,
            waitedMs: waited.get(e.callId),
          }),
        )
        // 一次调用发起了多个子运行：其余的各挂一个链接节点，导出时子运行能挂到它们下面。
        for (const childRunId of (e.childRunIds ?? []).filter((id) => id !== e.childRunId)) {
          tool.children.push(node('tool', name, e.startedAt, 0, { callId: e.callId, childRunId }))
        }
        container().children.push(tool)
        break
      }
      case 'external_call':
        container().children.push(
          node(
            'external',
            e.source,
            e.startedAt,
            e.durationMs,
            defined({ kind: e.kind, usage: e.usage }),
          ),
        )
        break
      case 'evaluated':
        for (const o of e.opinions) {
          container().children.push(
            node('opinion', o.source, e.at - o.durationMs, o.durationMs, { mode: o.mode }),
          )
        }
        break
      case 'delivery_checked': {
        // 没通过的验收不是出错：属性不用 isError、error，导出器据 pass 标出。
        const delivery = { attempt: e.attempt, path: e.path, outcome: e.outcome }
        container().children.push(
          node('check', 'output', e.at, 0, {
            pass: e.output.ok,
            mode: 'gate',
            ...delivery,
            issues: e.output.issues?.length ?? 0,
          }),
        )
        for (const c of e.checks) {
          container().children.push(
            node('check', c.source, e.at, 0, {
              pass: c.pass,
              mode: c.mode,
              ...delivery,
              issues: c.issues?.length ?? 0,
            }),
          )
        }
        break
      }
      case 'run_ended':
        if (step) step.durationMs = e.at - step.startedAt
        step = undefined
        run.durationMs = e.at - run.startedAt
        run.attrs.status = e.result.status
        if (e.result.code !== undefined) run.attrs.code = e.result.code
        break
    }
  }
  return run
}
