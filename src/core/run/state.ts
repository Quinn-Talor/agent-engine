// 运行状态机（设计 §6.1）：状态只由事件推导，下一环节只由状态决定（BR-001）。
// 受理在状态机之外：执行器完成受理后从 initial() 开始，第一个环节是 prepare（F2 §B.2）。

import type { ModelMessage, ReasoningPart, TextPart, ToolCallPart } from '../../contracts/common.js'
import type { CallBlock, Intervention, Observation, Verdict } from '../../contracts/component.js'
import type { BlobRef, RunEvent } from '../../contracts/events.js'
import type { ModelRef, ModelResponse, NormalizedUsage, RunUsage } from '../../contracts/model.js'
import type { RunResult, RunStatus } from '../../contracts/run.js'
import type { ToolEffect, ToolIntent } from '../../contracts/tool.js'
import { nextCalibration } from './estimate.js'

export type Stage = 'prepare' | 'compose' | 'reason' | 'act' | 'evaluate' | 'deliver' | 'end'

export interface RunSnapshot {
  runId: string
}

export type RunPhase =
  | 'prepare'
  | 'compose'
  | 'composing'
  | 'composed'
  | 'responded'
  | 'acted'
  | 'evaluated'
  | 'deliver'
  | 'ended'

type AssistantMessage = Extract<ModelMessage, { role: 'assistant' }>
type ToolFinished = Extract<RunEvent, { t: 'tool_finished' }>

export type TranscriptEntry =
  | { origin: 'model'; step: number; message: AssistantMessage }
  | {
      origin: 'tool'
      step: number
      results: Array<{ callId: string; toolName: string; shown: BlobRef; isError: boolean }>
    }
  | { origin: 'hint'; step: number; source: string; text: string }
  | { origin: 'steer'; step: number; text: string }
  | { origin: 'hook'; source: string; content: BlobRef }

export interface ToolMeta {
  name: string
  capability: string
  intent?: ToolIntent
  effect: ToolEffect
  repeatable: boolean
}

/** 生效中的封路：持续到运行结束，委托人引导生效时全部解除；带 clearOnChange 的在写操作成功时解除。 */
export type ActiveBlock = CallBlock & {
  source: string
  /** 施加封路的步。 */
  since: number
  /** 最后生效的步（含）；缺省为 Infinity。 */
  until: number
}

export type SourcedIntervention = Intervention & { source: string }

export interface RunOutcome {
  status: RunStatus
  code?: string
  message?: string
  error?: { code: string; message: string; retryable: boolean }
}

export interface EffectiveBudget {
  maxSteps: number
  maxTotalMs?: number
  finalizeReserveMs: number
  maxInputTokens?: number
  maxCost?: number
}

export interface RunCandidate {
  step: number
  text: string
  intent?: { tool: string; kind: ToolIntent['kind']; code: string; input: unknown }
}

export interface RunState {
  runId: string
  phase: RunPhase
  startedAt?: number
  model?: ModelRef
  /** 输入上限：模型窗口减去输出预留；估算达到它就不调用模型（I7）。 */
  inputLimit: number
  budget: EffectiveBudget
  principalReachable: boolean
  tools: Readonly<Record<string, ToolMeta>>
  step: number
  toolCallCount: number
  /** 本步的模型回复。 */
  response?: ModelResponse
  /** 本步的工具结果，按 callId。 */
  results: Readonly<Record<string, ToolFinished>>
  transcript: readonly TranscriptEntry[]
  pendingSteers: readonly string[]
  pendingInterventions: readonly SourcedIntervention[]
  blocks: readonly ActiveBlock[]
  seenOutputs: readonly string[]
  lastEstimate: number
  calibration: number
  /** 本步的模型调用被收尾预留线截断：回复不完整，不能当最终候选。 */
  deadlineCut: boolean
  verdict?: Verdict
  /** 最近一次 evaluated 的观察；交付环节用它构造候选。 */
  observation?: Observation
  deliveryPath?: 'normal' | 'fallback'
  candidate?: RunCandidate
  fallbackCode?: string
  fallbackText?: string
  usage: RunUsage
  childCost: number
  outcome?: RunOutcome
  result?: RunResult
  lastSeq: number
  /** 最近一条事件的时间；评估据此计算时间压力与剩余时间，回放时得到相同结果。 */
  lastAt: number
}

/** 预算默认值（设计 §3.14 限额归属）。 */
export const DEFAULT_BUDGET = {
  maxSteps: 1000,
  finalizeReserveMs: 120_000,
} as const

const DEFAULT_RETURN_HINT = '交付未通过验收，请修正后重新交付'

export const emptyUsage = (): NormalizedUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

export const addUsage = (a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

export const emptyRunUsage = (): RunUsage => ({
  ...emptyUsage(),
  main: emptyUsage(),
  memory: emptyUsage(),
  supervision: emptyUsage(),
  children: emptyUsage(),
})

export type UsageBucket = 'main' | 'memory' | 'supervision' | 'children'

function addToBucket(usage: RunUsage, bucket: UsageBucket, delta: NormalizedUsage): RunUsage {
  return { ...usage, ...addUsage(usage, delta), [bucket]: addUsage(usage[bucket], delta) }
}

/** 外部调用的用量归属：按来源前缀（memory → 记忆，deliver → 主模型，其余 → 监督）。 */
export function bucketOf(source: string): UsageBucket {
  if (source.startsWith('memory')) return 'memory'
  if (source.startsWith('deliver')) return 'main'
  return 'supervision'
}

export function initial(snapshot: RunSnapshot): RunState {
  return {
    runId: snapshot.runId,
    phase: 'prepare',
    inputLimit: Infinity,
    budget: { ...DEFAULT_BUDGET },
    principalReachable: false,
    tools: {},
    step: 0,
    toolCallCount: 0,
    results: {},
    transcript: [],
    pendingSteers: [],
    pendingInterventions: [],
    blocks: [],
    seenOutputs: [],
    lastEstimate: 0,
    deadlineCut: false,
    calibration: 1,
    usage: emptyRunUsage(),
    childCost: 0,
    lastSeq: 0,
    lastAt: 0,
  }
}

function assistantMessage(response: ModelResponse): AssistantMessage {
  const parts: Array<TextPart | ReasoningPart | ToolCallPart> = []
  if (response.reasoning) {
    const part: ReasoningPart = { type: 'reasoning', text: response.reasoning.text }
    if (response.reasoning.providerData !== undefined) {
      part.providerData = response.reasoning.providerData
    }
    parts.push(part)
  }
  if (response.text.length > 0) parts.push({ type: 'text', text: response.text })
  for (const c of response.toolCalls) {
    parts.push({
      type: 'tool-call',
      toolCallId: c.id,
      toolName: c.name,
      input: c.input,
      ...(c.providerData !== undefined ? { providerData: c.providerData } : {}),
    })
  }
  return { role: 'assistant', content: parts.length > 0 ? parts : '' }
}

function outputHash(shown: BlobRef): string {
  return shown.startsWith('sha256:') ? shown.slice('sha256:'.length) : shown
}

function onStepEnded(state: RunState): RunState {
  // 只认本步的裁决：上一步留下的 verdict 不算。
  const verdict = state.phase === 'evaluated' ? state.verdict : undefined
  if (!verdict) throw new Error('unreachable: step_ended without evaluated')
  if ('continue' in verdict) {
    const fallbackSource = verdict.sources[0] ?? 'unknown'
    const pending = (verdict.continue.interventions ?? []).map((i) => ({
      ...i,
      source: (i as Partial<SourcedIntervention>).source ?? fallbackSource,
    }))
    return { ...state, phase: 'compose', pendingInterventions: pending }
  }
  if ('complete' in verdict) return { ...state, phase: 'deliver', deliveryPath: 'normal' }
  if ('finalize' in verdict) {
    return {
      ...state,
      phase: 'deliver',
      deliveryPath: 'fallback',
      fallbackCode: verdict.finalize.code,
    }
  }
  if ('awaitInput' in verdict) {
    return { ...state, outcome: { status: 'awaiting_input', code: verdict.awaitInput.code } }
  }
  return {
    ...state,
    outcome: { status: 'stopped', code: verdict.stop.code, message: verdict.stop.message },
  }
}

function onDelivery(state: RunState, e: Extract<RunEvent, { t: 'delivery_checked' }>): RunState {
  switch (e.outcome) {
    case 'delivered': {
      if (e.path === 'normal') {
        const intent = state.candidate?.intent
        const code = intent?.kind === 'complete' ? intent.code : undefined
        return {
          ...state,
          outcome: code === undefined ? { status: 'completed' } : { status: 'completed', code },
        }
      }
      return { ...state, outcome: { status: 'finalized', code: state.fallbackCode } }
    }
    case 'returned':
      return {
        ...state,
        phase: 'compose',
        pendingInterventions: [
          { hint: { text: e.hint ?? DEFAULT_RETURN_HINT }, source: 'delivery' },
        ],
      }
    case 'fallback':
      return { ...state, deliveryPath: 'fallback', fallbackCode: e.code ?? 'empty_output' }
    case 'stopped':
      return { ...state, outcome: { status: 'stopped', code: e.code ?? 'budget' } }
    case 'failed':
      return { ...state, outcome: { status: 'failed', code: 'output_invalid' } }
  }
}

export function apply(state: RunState, e: RunEvent): RunState {
  if (state.phase === 'ended') throw new Error('unreachable: event after run_ended')
  const s: RunState = { ...state, lastSeq: e.seq, lastAt: e.at }
  switch (e.t) {
    case 'run_started': {
      const tools: Record<string, ToolMeta> = {}
      for (const cap of e.capabilities) {
        for (const t of cap.tools) {
          tools[t.name] = {
            name: t.name,
            capability: cap.capability,
            ...(t.intent ? { intent: t.intent } : {}),
            effect: t.effect ?? 'side_effect',
            repeatable: t.repeatable ?? false,
          }
        }
      }
      return {
        ...s,
        phase: 'compose',
        // 排队时间计入总时长（设计 §5.3）：从受理开始算，与硬截止时间一致。
        startedAt: e.at - e.queuedMs,
        model: e.model,
        inputLimit: e.contextLimit - e.outputReserve,
        budget: { ...DEFAULT_BUDGET, ...e.task.budget },
        principalReachable: e.environment.principalReachable,
        tools,
      }
    }
    case 'step_started':
      return {
        ...s,
        phase: 'composing',
        step: e.step,
        response: undefined,
        deadlineCut: false,
        results: {},
        pendingInterventions: [],
        blocks: s.blocks.filter((b) => b.until >= e.step),
      }
    case 'intervention_applied': {
      const i = e.intervention
      if ('hint' in i) {
        return {
          ...s,
          transcript: [
            ...s.transcript,
            { origin: 'hint', step: e.step, source: e.source, text: i.hint.text },
          ],
        }
      }
      const block: ActiveBlock = {
        ...i.block,
        source: e.source,
        since: e.step,
        until: e.until ?? Infinity,
      }
      return { ...s, blocks: [...s.blocks, block] }
    }
    case 'context_built': {
      let next: RunState = { ...s, phase: 'composed', lastEstimate: e.estimate }
      if (s.pendingSteers.length > 0) {
        // 引导生效：封路全部解除（含本步刚施加的），守卫在评估时重新开始。
        next = {
          ...next,
          blocks: [],
          transcript: [
            ...s.transcript,
            { origin: 'steer', step: e.step, text: s.pendingSteers.join('\n\n') },
          ],
          pendingSteers: [],
        }
      }
      if (e.estimate >= s.inputLimit) {
        next = { ...next, outcome: { status: 'stopped', code: 'context_overflow' } }
      }
      return next
    }
    case 'model_responded':
      return {
        ...s,
        phase: 'responded',
        response: e.response,
        usage: addToBucket(s.usage, 'main', e.response.usage),
        // 用量四项是加法关系：全部输入 = 未命中缓存 + 缓存读 + 缓存写。
        calibration: nextCalibration(
          s.calibration,
          s.lastEstimate,
          e.response.usage.input + e.response.usage.cacheRead + e.response.usage.cacheWrite,
        ),
        transcript: [
          ...s.transcript,
          { origin: 'model', step: e.step, message: assistantMessage(e.response) },
        ],
      }
    case 'model_failed':
      return {
        ...s,
        outcome:
          e.error.code === 'CONTEXT_TOO_LONG'
            ? { status: 'stopped', code: 'context_overflow' }
            : {
                status: 'failed',
                code: 'model_error',
                error: {
                  code: e.error.code,
                  message: e.error.message,
                  retryable: e.error.retryable,
                },
              },
      }
    case 'model_aborted': {
      if (!e.deadline) return { ...s, outcome: { status: 'aborted' } }
      // 收尾预留线截断：按一次没有工具调用、不完整的回复处理，接着评估（预算检查会转兜底）。
      const response: ModelResponse = {
        text: e.partialText,
        toolCalls: [],
        finishReason: 'other',
        usage: emptyUsage(),
        warnings: [],
        attempts: [],
      }
      return {
        ...s,
        phase: 'responded',
        response,
        deadlineCut: true,
        transcript: e.partialText
          ? [
              ...s.transcript,
              { origin: 'model', step: e.step, message: assistantMessage(response) },
            ]
          : s.transcript,
      }
    }
    case 'tool_finished': {
      const results = { ...s.results, [e.callId]: e }
      // 写操作成功：环境变了，依赖环境状态的封路解除（F25）。
      const changed = !e.isError && e.effect === 'side_effect'
      let next: RunState = {
        ...s,
        ...(changed && s.blocks.some((b) => b.clearOnChange)
          ? { blocks: s.blocks.filter((b) => !b.clearOnChange) }
          : {}),
        results,
        toolCallCount: s.toolCallCount + 1,
        usage: e.usage ? addToBucket(s.usage, 'children', e.usage) : s.usage,
        childCost: s.childCost + (e.cost ?? 0),
      }
      const calls = s.response?.toolCalls ?? []
      if (s.phase === 'responded' && calls.length > 0 && calls.every((c) => results[c.id])) {
        next = {
          ...next,
          phase: 'acted',
          transcript: [
            ...s.transcript,
            {
              origin: 'tool',
              step: s.step,
              results: calls.map((c) => ({
                callId: c.id,
                toolName: c.name,
                shown: results[c.id]!.shown,
                isError: results[c.id]!.isError,
              })),
            },
          ],
        }
      }
      return next
    }
    case 'external_call': {
      let next = s
      if (e.kind === 'model' && e.usage) {
        next = { ...next, usage: addToBucket(next.usage, bucketOf(e.source), e.usage) }
      }
      if (s.phase === 'prepare' && e.kind === 'record' && e.source.startsWith('notice:')) {
        next = {
          ...next,
          transcript: [
            ...next.transcript,
            { origin: 'hook', source: e.source, content: e.response },
          ],
        }
      }
      return next
    }
    case 'steer_received':
      return { ...s, pendingSteers: [...s.pendingSteers, e.text] }
    case 'evaluated': {
      const seen = new Set(s.seenOutputs)
      for (const r of Object.values(s.results)) seen.add(outputHash(r.shown))
      const intent = e.observation.intent
      const intentCall = intent
        ? s.response?.toolCalls.find((c) => c.name === intent.tool)
        : undefined
      return {
        ...s,
        phase: 'evaluated',
        verdict: e.verdict,
        observation: e.observation,
        seenOutputs: [...seen],
        candidate: {
          step: e.step,
          text: s.response?.text ?? '',
          ...(intent
            ? {
                intent: {
                  tool: intent.tool,
                  kind: intent.kind,
                  code: intent.code,
                  input: intentCall?.input,
                },
              }
            : {}),
        },
      }
    }
    case 'step_ended':
      return onStepEnded(s)
    case 'delivery_checked':
      return onDelivery(s, e)
    case 'fallback_generated':
      return { ...s, fallbackText: e.text, fallbackCode: e.code }
    case 'run_ended':
      return { ...s, phase: 'ended', result: e.result }
    case 'permission_decided':
    case 'approval_answered':
      return s
  }
}

export function nextStage(state: RunState): Stage | null {
  if (state.phase === 'ended') return null
  if (state.outcome) return 'end'
  switch (state.phase) {
    case 'prepare':
    case 'compose':
    case 'deliver':
      return state.phase
    case 'composed':
      return 'reason'
    case 'responded':
      return (state.response?.toolCalls.length ?? 0) > 0 ? 'act' : 'evaluate'
    case 'acted':
      return 'evaluate'
    case 'composing':
      throw new Error('unreachable: step_started without context_built')
    case 'evaluated':
      throw new Error('unreachable: evaluated without step_ended')
  }
}
