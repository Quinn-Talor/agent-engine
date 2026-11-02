// ③ 行动（设计 §3.7）：每个调用走一遍工具流水线；调用之间并发执行，审批串行排队，
// exclusive 工具独占执行；结果按调用顺序一次性产出（设计 I2）。

import type { Clock, TaskScope } from '../../contracts/common.js'
import { toolError, type ToolErrorEnvelope } from '../../contracts/errors.js'
import type { BlobRef, RunEventBody } from '../../contracts/events.js'
import type { NormalizedUsage } from '../../contracts/model.js'
import type { Notice } from '../../contracts/run.js'
import type { ToolCallView, ToolCtx, ToolEffect } from '../../contracts/tool.js'
import { matchBlock } from '../../core/supervision/facts.js'
import { inputHash, sha256Hex } from '../../core/definition/hash.js'
import { addUsage, emptyUsage, type ActiveBlock } from '../../core/run/state.js'
import { executeTool, normalizeOutput, type ExecOutcome } from './exec.js'
import { checkPermission, type PermissionDeps } from './permissions.js'
import { blockedError, lookupTool, validateInput } from './pipeline.js'
import type { PreparedTool } from './tools.js'

const DEFAULT_TOOL_CONCURRENCY = 5

export interface ToolCallRequest {
  id: string
  name: string
  input: unknown
}

export interface ActDeps {
  step: number
  toolset: ReadonlyMap<string, PreparedTool>
  visible: ReadonlySet<string>
  blocks: readonly ActiveBlock[]
  permissions: PermissionDeps
  toolConcurrency?: number
  clock: Clock
  signal: AbortSignal
  runId: string
  scope: TaskScope
  task: ToolCtx['task']
  spawn: ToolCtx['spawn']
  notify(notice: Notice): void
  redact(text: string): string
  putBlob(data: string): Promise<BlobRef>
}

/** 并发上限：FIFO 排队。 */
export class Limiter {
  private active = 0
  private waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((grant) => this.waiting.push(grant))
    else this.active += 1
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}

/** 执行闸门：普通工具共享，exclusive 工具独占；按到达顺序放行。 */
class ExecutionGate {
  private shared = 0
  private exclusive = false
  private queue: Array<{ exclusive: boolean; grant: () => void }> = []

  enter(exclusive: boolean): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({ exclusive, grant: () => resolve(() => this.leave(exclusive)) })
      this.drain()
    })
  }

  private leave(exclusive: boolean): void {
    if (exclusive) this.exclusive = false
    else this.shared -= 1
    this.drain()
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!
      const free = head.exclusive ? !this.exclusive && this.shared === 0 : !this.exclusive
      if (!free) return
      this.queue.shift()
      if (head.exclusive) this.exclusive = true
      else this.shared += 1
      head.grant()
    }
  }
}

const aborted = (): ExecOutcome => ({ error: toolError('TOOL_ABORTED', '运行已取消') })

const UNKNOWN_HINT =
  '结果未知，可能已经执行：先核实是否已经生效（例如查询状态），不要用相同输入重试'

function withUnknownHint(outcome: { error: ToolErrorEnvelope }): ExecOutcome {
  const { hint } = outcome.error
  return { error: { ...outcome.error, hint: hint ? `${UNKNOWN_HINT}；${hint}` : UNKNOWN_HINT } }
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function act(
  calls: readonly ToolCallRequest[],
  deps: ActDeps,
): Promise<RunEventBody[]> {
  const { clock, signal } = deps
  const limiter = new Limiter(deps.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY)
  const gate = new ExecutionGate()

  const runCall = async (call: ToolCallRequest): Promise<RunEventBody[]> => {
    const startedAt = clock.now()
    const events: RunEventBody[] = []
    let tool: PreparedTool | undefined
    const childRunIds: string[] = []
    let childUsage: NormalizedUsage | undefined
    let childCost = 0

    const ctx: ToolCtx = {
      runId: deps.runId,
      callId: call.id,
      idempotencyKey: `${deps.runId}:${call.id}`,
      scope: deps.scope,
      task: deps.task,
      signal,
      spawn: async (agent, task, opts) => {
        const result = await deps.spawn(agent, task, opts)
        const { input, output, cacheRead, cacheWrite } = result.usage
        childRunIds.push(result.runId)
        childUsage = addUsage(childUsage ?? emptyUsage(), { input, output, cacheRead, cacheWrite })
        childCost += result.cost ?? 0
        return result
      },
      progress: (note) => deps.notify({ t: 'tool_progress', callId: call.id, note }),
    }

    const outcome = await (async (): Promise<ExecOutcome> => {
      if (signal.aborted) return aborted()
      const found = lookupTool(call.name, deps.toolset, deps.visible)
      if ('error' in found) return found
      tool = found.tool
      if (calls.length > 1 && tool.def.semantics?.intent) {
        return {
          error: toolError(
            'INTENT_NOT_ALONE',
            '意图工具必须单独调用',
            '先完成其他工具调用，下一步再单独调用该意图工具',
          ),
        }
      }
      const block = matchBlock(deps.blocks, deps.step, call.name, inputHash(call.input))
      if (block) return { error: blockedError(block) }
      // 输出契约的提交工具不在这里校验：参数交给交付环节解析，不合格按自修计数（maxRepairs），
      // 而不是算作工具失败去触发失败连击。
      const submitted =
        tool.capability.startsWith('output:') && tool.def.semantics?.intent?.kind === 'complete'
      const validated = submitted ? { value: call.input } : validateInput(tool, call.input)
      if ('error' in validated) return validated
      try {
        const own = tool.def.validate?.(validated.value, ctx)
        if (own && 'error' in own) return { error: own.error }
      } catch (error) {
        return { error: toolError('TOOL_EXCEPTION', (error as Error)?.message ?? String(error)) }
      }
      const access = tool.def.safety?.access?.(validated.value)
      const view: ToolCallView = {
        callId: call.id,
        toolName: call.name,
        capability: tool.capability,
        input: call.input,
        ...(access ? { access } : {}),
        risk: tool.def.safety?.risk ?? 'low',
        effect: tool.effect,
      }
      const permission = await checkPermission(view, { ...deps.permissions, signal })
      events.push(...permission.events)
      if (!permission.allowed) return { error: permission.error }
      if (signal.aborted) return aborted()
      const release = await gate.enter(tool.def.execution?.exclusive === true)
      try {
        return await executeTool(tool, validated.value, ctx, { clock, signal })
      } finally {
        release()
      }
    })().catch(
      // 流水线里工具之外的出错（如 safety.access 抛错）同样包成信封（I5）。
      (error: unknown): ExecOutcome => ({ error: toolError('TOOL_EXCEPTION', messageOf(error)) }),
    )

    const effect: ToolEffect = tool?.effect ?? 'none'
    // 有副作用的调用结果未知：提示模型先核实，不要用相同输入重试（I15）。
    let unknown = effect !== 'none' && 'error' in outcome && outcome.unknown === true
    const shownOutcome: ExecOutcome =
      unknown && 'error' in outcome ? withUnknownHint(outcome) : outcome
    const maxOutputChars = tool?.def.execution?.maxOutputChars
    let out = normalizeOutput(shownOutcome, maxOutputChars, deps.redact)
    let shown: BlobRef
    let raw: BlobRef | undefined
    try {
      shown = await deps.putBlob(out.shown)
      raw = out.raw === undefined ? undefined : await deps.putBlob(out.raw)
    } catch (error) {
      // 结果写不进 blob：改为错误信封，保证每个调用都有结果（I2、I5）。执行成功的副作用
      // 已经发生，只是结果丢了。
      const lost = effect !== 'none' && 'value' in outcome
      const failed = lost
        ? toolError(
            'TOOL_RESULT_LOST',
            `工具已执行，但结果保存失败：${messageOf(error)}`,
            UNKNOWN_HINT,
          )
        : toolError('TOOL_EXCEPTION', `工具结果保存失败：${messageOf(error)}`)
      unknown ||= lost
      out = normalizeOutput({ error: failed }, maxOutputChars, deps.redact)
      raw = undefined
      shown = await deps.putBlob(out.shown).catch(() => `sha256:${sha256Hex(out.shown)}`)
    }
    events.push({
      t: 'tool_finished',
      callId: call.id,
      capability: tool?.capability ?? '',
      effect,
      shown,
      ...(raw ? { raw } : {}),
      isError: out.isError,
      ...(out.errorCode !== undefined ? { errorCode: out.errorCode } : {}),
      ...(unknown ? { possiblyExecuted: true as const } : {}),
      ...('error' in outcome && outcome.error.errorClass
        ? { errorClass: outcome.error.errorClass }
        : {}),
      startedAt,
      durationMs: clock.now() - startedAt,
      ...(childRunIds.length > 0 ? { childRunId: childRunIds.at(-1)! } : {}),
      ...(childRunIds.length > 1 ? { childRunIds } : {}),
      ...(childUsage ? { usage: childUsage, cost: childCost } : {}),
    })
    return events
  }

  const groups = await Promise.all(calls.map((c) => limiter.run(() => runCall(c))))
  return groups.flat()
}
