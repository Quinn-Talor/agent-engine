// 准备（设计 §3.4）：并行准备能力 → 按声明顺序合并（同类合并、名字冲突、按委托人排除）
// → 冻结快照 → 不可用的能力记下原因 → 执行动态须知。工具集在运行中不再变化（I14）。

import type { Capability, CapabilitySnapshot, Prepared } from '../contracts/capability.js'
import type { Clock, LogLevel, ModelMessage, SecretResolver, Segment } from '../contracts/common.js'
import type {
  ComponentCtx,
  Exposure,
  Guard,
  NoticeProvider,
  OutputContract,
  RunInfo,
} from '../contracts/component.js'
import { toolError } from '../contracts/errors.js'
import type { BlobRef, RunEventBody } from '../contracts/events.js'
import type { ToolDef } from '../contracts/tool.js'
import { canonicalJson, hashOf } from '../core/hash.js'
import { callComponent } from '../executor/call-component.js'
import { prepareTool, type PreparedTool } from '../executor/tools.js'

const PREPARE_TIMEOUT_MS = 30_000

export interface PrepareInput {
  run: RunInfo
  capabilities: readonly Capability[]
  output: OutputContract
  exposure: Exposure
  host<T>(kind: string): T
  vault: SecretResolver
  clock: Clock
  signal: AbortSignal
  notice: ReadonlyArray<Segment | NoticeProvider>
  /** 任务的 history，只读地交给能力的准备。 */
  history: readonly ModelMessage[]
  ctxFor(source: string): ComponentCtx
  putBlob(data: string): Promise<BlobRef>
  log(level: LogLevel, message: string, detail?: unknown): void
}

export interface PreparedRun {
  toolset: Map<string, PreparedTool>
  exposureOf: Map<string, 'eager' | 'deferred'>
  descriptions: Segment[]
  guards: Guard[]
  snapshots: CapabilitySnapshot[]
  unavailable: Array<{ capability: string; reason: string }>
  releases: Array<() => void>
  /** 静态须知。 */
  notice: Segment[]
  /** 动态须知的 external_call，排在 run_started 之前。 */
  noticeEvents: RunEventBody[]
}

export type PrepareResult =
  | { ok: true; prepared: PreparedRun }
  | { ok: false; code: 'invalid_agent'; message: string }
  /** 动态须知拦下了这次运行（例如 UserPromptSubmit hook 拒绝）；message 为拦截原因。 */
  | { ok: false; code: 'notice_blocked'; message: string }

type Source = Pick<Capability, 'id' | 'kind' | 'version' | 'prepare'> & {
  /** 内置能力：快照指纹由工具名与 schema 哈希得出。 */
  system?: boolean
  fromOutput?: boolean
}

const isProvider = (n: Segment | NoticeProvider): n is NoticeProvider =>
  typeof (n as NoticeProvider).provide === 'function'

/** 输出契约与工具呈现自带的系统工具，作为两项内置能力参与准备。 */
function systemSource(
  id: string,
  kind: string,
  version: string,
  tools: ToolDef[],
  extra: { fromOutput?: boolean; exposure?: 'eager' } = {},
): Source {
  return {
    id,
    kind,
    version,
    system: true,
    fromOutput: extra.fromOutput,
    prepare: async () => ({
      tools,
      ...(extra.exposure ? { exposure: extra.exposure } : {}),
      snapshot: { fingerprint: '' },
    }),
  }
}

/** 意图 code 为 propose 的工具：动作里的工具必须在本次运行的工具集中（设计 §9.7）。 */
function withProposeCheck(
  tool: PreparedTool,
  toolset: ReadonlyMap<string, PreparedTool>,
): PreparedTool {
  const own = tool.def.validate
  const validate: ToolDef['validate'] = (input, ctx) => {
    const result = own?.(input, ctx)
    if (result && 'error' in result) return result
    const actions = (input as { actions?: Array<{ tool?: unknown }> } | null)?.actions ?? []
    const missing = actions.map((a) => String(a.tool)).filter((name) => !toolset.has(name))
    if (missing.length > 0) {
      return {
        error: toolError(
          'INVALID_INPUT',
          `动作里的工具不在本次运行的工具集中：${missing.join(', ')}`,
        ),
      }
    }
    return { ok: true }
  }
  return { ...tool, def: { ...tool.def, validate } }
}

export async function prepareRun(input: PrepareInput): Promise<PrepareResult> {
  const { run, clock, signal } = input
  const sources: Source[] = [...input.capabilities]
  if (input.output.tools?.length) {
    sources.push(
      systemSource(
        `output:${input.output.id}`,
        'output',
        input.output.version,
        input.output.tools,
        {
          fromOutput: true,
        },
      ),
    )
  }
  if (input.exposure.tools?.length) {
    sources.push(
      systemSource(
        `exposure:${input.exposure.id}`,
        'exposure',
        input.exposure.version,
        input.exposure.tools,
        {
          exposure: 'eager',
        },
      ),
    )
  }

  const outcomes = await Promise.all(
    sources.map((source) => {
      const pending = source.prepare({
        run,
        signal,
        deadline: clock.now() + PREPARE_TIMEOUT_MS,
        host: (kind) => input.host(kind),
        vault: input.vault,
        history: input.history,
      })
      return callComponent(() => pending, { clock, timeoutMs: PREPARE_TIMEOUT_MS, signal }).then(
        (outcome) => {
          // 超时后才准备好的能力不会进入本次运行，归还它占用的资源。
          if (!outcome.ok)
            pending.then(
              (p) => p.release?.(),
              () => undefined,
            )
          return outcome
        },
      )
    }),
  )

  const prepared: PreparedRun = {
    toolset: new Map(),
    exposureOf: new Map(),
    descriptions: [],
    guards: [],
    snapshots: [],
    unavailable: [],
    releases: [],
    notice: [],
    noticeEvents: [],
  }
  /** 不进入运行时归还每个已准备好的能力，包括排在出错项之后的。 */
  const releaseAll = () => {
    for (const outcome of outcomes) {
      if (!outcome.ok || !outcome.value.release) continue
      try {
        outcome.value.release()
      } catch (error) {
        input.log('warn', '释放能力出错', { error: (error as Error)?.message ?? String(error) })
      }
    }
  }
  const fail = (message: string): PrepareResult => {
    releaseAll()
    return { ok: false, code: 'invalid_agent', message }
  }

  for (const [i, source] of sources.entries()) {
    const outcome = outcomes[i]!
    if (!outcome.ok) {
      const reason = outcome.timedOut
        ? '准备超时'
        : ((outcome.error as Error)?.message ?? String(outcome.error))
      prepared.unavailable.push({ capability: source.id, reason })
      continue
    }
    const result: Prepared = outcome.value
    if (result.release) prepared.releases.push(() => result.release!())
    const kept: CapabilitySnapshot['tools'] = []
    for (const def of result.tools) {
      const existing = prepared.toolset.get(def.name)
      if (existing) {
        if (existing.def === def) continue
        return fail(`工具名冲突：${def.name}`)
      }
      if (!run.environment.principalReachable && def.semantics?.intent?.kind === 'await_input') {
        continue
      }
      let tool: PreparedTool
      try {
        tool = prepareTool(def, source.id, {
          invalidInputCode: source.fromOutput ? 'OUTPUT_INVALID' : 'INVALID_INPUT',
          ...(result.available ? { available: () => result.available!() } : {}),
        })
      } catch (error) {
        return fail((error as Error).message)
      }
      prepared.toolset.set(def.name, tool)
      prepared.exposureOf.set(
        def.name,
        result.toolExposure?.[def.name] ?? result.exposure ?? 'eager',
      )
      kept.push({
        name: def.name,
        schemaHash: hashOf(tool.jsonSchema),
        ...(def.semantics?.intent ? { intent: def.semantics.intent } : {}),
        effect: tool.effect,
        ...(def.semantics?.repeatable !== undefined
          ? { repeatable: def.semantics.repeatable }
          : {}),
      })
    }
    const fingerprint = source.system
      ? hashOf(kept.map((t) => ({ name: t.name, schemaHash: t.schemaHash })))
      : result.snapshot.fingerprint
    prepared.snapshots.push({
      capability: source.id,
      kind: source.kind,
      version: source.version,
      fingerprint,
      tools: kept,
      ...(result.snapshot.detail !== undefined ? { detail: result.snapshot.detail } : {}),
    })
    prepared.descriptions.push(...(result.description ?? []))
    for (const guard of result.guards ?? []) {
      const existing = prepared.guards.find((g) => g.id === guard.id)
      if (existing === guard) continue
      // 来源是 capability:<id>：同名守卫会共用来源，告知记录与外部调用都会串在一起。
      if (existing) return fail(`守卫 id 重复：${guard.id}`)
      prepared.guards.push(guard)
    }
  }

  for (const [name, tool] of prepared.toolset) {
    if (tool.def.semantics?.intent?.code === 'propose') {
      prepared.toolset.set(name, withProposeCheck(tool, prepared.toolset))
    }
  }

  for (const item of input.notice) {
    if (!isProvider(item)) {
      prepared.notice.push(item)
      continue
    }
    const startedAt = clock.now()
    const outcome = await callComponent(
      () => item.provide(run, input.ctxFor(`provider:${item.id}`)),
      { clock, timeoutMs: PREPARE_TIMEOUT_MS, signal },
    )
    if (!outcome.ok) {
      input.log('warn', `须知 ${item.id} 生成失败`, { error: String(outcome.error) })
      continue
    }
    // 拦截不是须知：不写入运行记录，后面的须知也不再执行。
    if (!Array.isArray(outcome.value)) {
      releaseAll()
      return { ok: false, code: 'notice_blocked', message: outcome.value.block }
    }
    prepared.noticeEvents.push({
      t: 'external_call',
      source: `notice:${item.id}`,
      kind: 'record',
      request: await input.putBlob(canonicalJson({ provider: item.id })),
      response: await input.putBlob(canonicalJson(outcome.value)),
      startedAt,
      durationMs: outcome.durationMs,
    })
  }
  return { ok: true, prepared }
}
