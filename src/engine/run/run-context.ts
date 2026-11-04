// 运行上下文（设计 §9.1、§4.3 规约 4）：组件取用时钟、随机数、模型、外部调用、诊断日志与宿主的唯一入口。
// 组件的每次模型调用和外部调用都记为 external_call，由驱动和所在环节的事件一起写入日志（I8）。

import type { CapabilityHost } from '../../contracts/capability.js'
import type { Clock, LogEntry, Logger, SecretResolver } from '../../contracts/common.js'
import type { ComponentCtx, RunInfo } from '../../contracts/component.js'
import type { Vault } from '../../contracts/engine.js'
import { abortError } from '../../contracts/errors.js'
import type { BlobRef, RunEventBody } from '../../contracts/events.js'
import type {
  ModelHub,
  ModelInput,
  SideModelRequest,
  SideModelResponse,
} from '../../contracts/model.js'
import { canonicalJson, sha256Hex } from '../../core/definition/hash.js'
import { seededRandom } from '../../core/run/random.js'
import { redactText, redactValue } from '../../core/log/redact.js'
import type { RunState } from '../../core/run/state.js'
import { COMPONENT_TIMEOUT_MS, MEMORY_TIMEOUT_MS } from '../../executor/call-component.js'

export interface RunContextDeps {
  run: RunInfo
  clock: Clock
  hub: ModelHub
  logger: Logger
  hosts: ReadonlyMap<string, CapabilityHost>
  signal: AbortSignal
  state(): RunState
  putBlob(data: string): Promise<BlobRef>
  /** 深度脱敏：凭据解析出的值与敏感模式。 */
  redact<T>(value: T): T
}

export interface RunContext {
  ctxFor(source: string): ComponentCtx
  /**
   * 以 `source` 的名义调用模型，与组件的 `ctx.callModel` 相同地记进日志、计入用量；`signal` 触发时一并取消。
   * 工具来源（`tool:` 开头）不加组件时限，只跟随工具这次调用的信号。
   */
  callModelFor(
    source: string,
    req: SideModelRequest,
    signal?: AbortSignal,
  ): Promise<SideModelResponse | undefined>
  /** 取走自上次以来组件产生的 external_call。 */
  drain(): RunEventBody[]
}

/** 外部调用插在环节的锚点事件之前，trace 才能把它们挂在所属的步里（设计 §6.6）。 */
const ANCHORS = new Set<RunEventBody['t']>(['run_started', 'context_built', 'evaluated'])

export function placeExternalCalls(stage: RunEventBody[], calls: RunEventBody[]): RunEventBody[] {
  if (calls.length === 0) return stage
  const anchor = stage.findIndex((e) => ANCHORS.has(e.t))
  const at = anchor === -1 ? 0 : anchor
  return [...stage.slice(0, at), ...calls, ...stage.slice(at)]
}

/** 凭据：记下凭据库解析出的每个值，写日志前替换掉（设计 §6.2）。 */
export function secretKeeper(vault?: Vault): {
  vault: SecretResolver
  redact(text: string): string
  /** `freeze`：脱敏的同时冻结（写日志的事件用）。 */
  redactValue<T>(value: T, opts?: { freeze?: boolean }): T
} {
  const secrets: string[] = []
  return {
    vault: {
      async resolve(ref) {
        if (!vault) throw new Error('没有配置凭据库')
        const value = await vault.resolve(ref)
        secrets.push(value)
        return value
      },
    },
    redact: (text) => redactText(text, secrets),
    redactValue: (value, opts) => redactValue(value, secrets, opts),
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createRunContext(deps: RunContextDeps): RunContext {
  const { clock, run } = deps
  const random = seededRandom(parseInt(sha256Hex(run.runId).slice(0, 8), 16))
  const contexts = new Map<string, ComponentCtx>()
  let pending: RunEventBody[] = []

  /** 运行信号、另给的信号与计时任一触发即取消。 */
  const linkedSignal = (
    timeoutMs?: number,
    extra?: AbortSignal,
  ): { signal: AbortSignal; done(): void } => {
    if (timeoutMs === undefined && extra === undefined) {
      return { signal: deps.signal, done: () => {} }
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    const sources = extra ? [deps.signal, extra] : [deps.signal]
    for (const s of sources) {
      // 已经取消的信号不会再触发 abort 事件，先查一次。
      if (s.aborted) controller.abort()
      else s.addEventListener('abort', onAbort, { once: true })
    }
    const cancel =
      timeoutMs === undefined ? () => {} : clock.setTimer(timeoutMs, () => controller.abort())
    return {
      signal: controller.signal,
      done: () => {
        cancel()
        for (const s of sources) s.removeEventListener('abort', onAbort)
      },
    }
  }

  /** 组件内调用比组件时限提前结束的余量。 */
  const CALL_MARGIN_MS = 1_000

  const callModel = async (
    source: string,
    req: SideModelRequest,
    extra?: AbortSignal,
  ): Promise<SideModelResponse | undefined> => {
    // 运行取消后不再发起新的模型调用（设计 §3.14）。
    if (deps.signal.aborted) throw abortError()
    const callSource = `${source}/${req.purpose}`
    const ref = req.model ?? run.model.ref
    const port = deps.hub.resolve(ref)
    if (!port) throw new Error(`模型 ${ref} 不存在`)
    const input: ModelInput = {
      messages: [
        ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
        ...req.messages,
      ],
      tools: [],
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
    }
    const startedAt = clock.now()
    const request = await deps.putBlob(canonicalJson({ purpose: req.purpose, model: ref, input }))
    if (deps.signal.aborted) throw abortError()
    // 没写超时就比组件的时限早一点结束：组件放弃等待之前调用已经结束并记进日志，
    // 不会在之后还占着模型的并发名额，也不会在运行结束后才返回而漏记。
    const limit = source.startsWith('memory:') ? MEMORY_TIMEOUT_MS : COMPONENT_TIMEOUT_MS
    // 工具的调用只跟随工具这次调用的信号：工具自己的超时经它生效。
    const timeoutMs =
      req.timeoutMs ?? (source.startsWith('tool:') ? undefined : limit - CALL_MARGIN_MS)
    const { signal, done } = linkedSignal(timeoutMs, extra)
    try {
      const response = await port.call(input, { signal, onDelta: () => {} })
      pending.push({
        t: 'external_call',
        source: callSource,
        kind: 'model',
        request,
        response: await deps.putBlob(response.text),
        usage: response.usage,
        startedAt,
        durationMs: clock.now() - startedAt,
      })
      return {
        text: response.text,
        usage: response.usage,
        model: ref,
        finishReason: response.finishReason,
      }
    } catch (error) {
      pending.push({
        t: 'external_call',
        source: callSource,
        kind: 'model',
        request,
        response: await deps.putBlob(canonicalJson({ error: messageOf(error) })),
        startedAt,
        durationMs: clock.now() - startedAt,
      })
      throw error
    } finally {
      done()
    }
  }

  const create = (source: string): ComponentCtx => ({
    clock,
    random,
    signal: deps.signal,
    modelLimits(ref) {
      const caps = deps.hub.resolve(ref ?? run.model.ref)?.capabilities
      return caps && { contextLimit: caps.contextLimit, maxOutputTokens: caps.maxOutputTokens }
    },
    callModel: (req) => callModel(source, req),
    async record(name, fn, opts) {
      const startedAt = clock.now()
      const request = await deps.putBlob(canonicalJson({ name }))
      const kind = opts?.kind ?? 'record'
      const finish = async (body: unknown) => {
        pending.push({
          t: 'external_call',
          source: `${source}/${name}`,
          kind,
          request,
          response: await deps.putBlob(deps.redact(canonicalJson(body))),
          startedAt,
          durationMs: clock.now() - startedAt,
        })
      }
      let result: Awaited<ReturnType<typeof fn>>
      try {
        result = await fn()
      } catch (error) {
        await finish({ error: messageOf(error) })
        throw error
      }
      await finish(result ?? null)
      return result
    },
    log(level, message, detail) {
      const step = deps.state().step
      const entry: LogEntry = {
        level,
        message,
        runId: run.runId,
        ...(step > 0 ? { step } : {}),
        source,
        ...(detail !== undefined ? { detail } : {}),
      }
      deps.logger.log(deps.redact(entry))
    },
    host<T>(kind: string): T {
      const host = deps.hosts.get(kind)
      if (!host) throw new Error(`能力宿主不存在：${kind}`)
      return host as T
    },
  })

  return {
    callModelFor: (source, req, signal) => callModel(source, req, signal),
    ctxFor(source) {
      let ctx = contexts.get(source)
      if (!ctx) {
        ctx = create(source)
        contexts.set(source, ctx)
      }
      return ctx
    },
    drain() {
      const out = pending
      pending = []
      return out
    },
  }
}
