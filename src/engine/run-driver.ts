// 运行驱动（设计 §6.1、§3）：受理 → 准入 → 准备 → 步循环 → 交付 → 结束。
// 唯一产生副作用的地方：每批事件先写日志、再改状态、再通知订阅者（I13）；取消随时生效，已发出的调用都有结果（I2）。

import type { Agent, Deliverable } from '../contracts/agent.js'
import type { CapabilityHost } from '../contracts/capability.js'
import type { Clock, LogLevel, Logger, ModelMessage } from '../contracts/common.js'
import type {
  ComponentCtx,
  Corpus,
  Exposure,
  Fallback,
  Guard,
  Memory,
  PermissionRule,
  RunInfo,
  ToolboxState,
} from '../contracts/component.js'
import type { Vault } from '../contracts/engine.js'
import type { Caps, Environment, EnvironmentConfig } from '../contracts/environment.js'
import { isModelCallError, toolError } from '../contracts/errors.js'
import {
  SCHEMA_VERSION,
  type ArchiveStore,
  type BlobRef,
  type RunEvent,
  type RunEventBody,
  type RunOrigin,
} from '../contracts/events.js'
import type { ModelHub, ModelInput, ModelRef, NormalizedUsage } from '../contracts/model.js'
import type { Notice, Run, RunResult, RunStatus, RunSubscriber } from '../contracts/run.js'
import type { Task } from '../contracts/task.js'
import type { ToolCtx } from '../contracts/tool.js'
import { runCost } from '../core/facts.js'
import { copyData } from '../core/freeze.js'
import { canonicalJson } from '../core/hash.js'
import { checkInvariants } from '../core/invariants.js'
import { layout } from '../core/layout.js'
import { buildCorpus, qualityOf, sideEffects } from '../core/projections.js'
import { addUsage, apply, emptyUsage, initial, nextStage, type RunState } from '../core/state.js'
import { act } from '../executor/act.js'
import { createComposer, type Composer } from '../executor/compose.js'
import { createDelivery, type Delivery } from '../executor/deliver.js'
import { createEvaluator, type Evaluator } from '../executor/evaluate.js'
import { normalizeOutput } from '../executor/exec.js'
import { Mutex } from '../executor/permissions.js'
import type { PreparedTool } from '../executor/tools.js'
import { AdmissionTimeoutError, type Admission, type AdmissionSlot } from '../services/admission.js'
import { admit, type Admitted } from './admit.js'
import { checkSpawn, rootLineage, type Lineage } from './lineage.js'
import { prepareRun, type PreparedRun } from './prepare.js'
import { createRunContext, placeExternalCalls, secretKeeper } from './run-context.js'

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000
const DEFAULT_CHILD_CONCURRENCY = 10
const DEFAULT_CHILD_DELIVERY_WAIT_MS = 10_000
/** 结束时等订阅者处理完已发出事件的上限；卡住的订阅者不拖住运行（设计 §4.4）。 */
const SUBSCRIBER_DRAIN_MS = 5_000

export type AbortReason = 'user' | 'parent' | 'deadline' | 'shutdown'

export interface EngineRuntime {
  hub: ModelHub
  archive: ArchiveStore
  clock: Clock
  logger: Logger
  admission: Admission
  hosts: ReadonlyMap<string, CapabilityHost>
  vault?: Vault
  memory: Memory
  guards: readonly Guard[]
  defaults: { deliverable: Deliverable & { fallback: Fallback }; exposure: Exposure }
  fingerprint: string
  environmentOf(e: Environment): EnvironmentRuntime | undefined
}

export interface EnvironmentRuntime {
  config: EnvironmentConfig
  fingerprint: string
  handle: Environment
}

export interface ParentLink {
  runId: string
  model: ModelRef
  signal: AbortSignal
  /** 子运行自己的血缘（已加深一层）。 */
  lineage: Lineage
  ceiling: { maxTotalMs?: number; maxCost?: number }
  /** 根运行执行环境的委托上限。 */
  delegation: Caps['delegation']
  /** 父运行生效的权限规则：子运行在其后叠加自己执行环境的规则，只会更严（I4）。 */
  permissions: readonly PermissionRule[]
  /** 等子运行并发名额的时长，计入子运行的总时长（设计 §5.3）。 */
  queuedMs: number
}

export interface RunRequest {
  agent: Agent
  task: Task
  assignment?: { model?: ModelRef; runId?: string }
  parent?: ParentLink
  /** 不执行，直接以 failed 结束（例如引擎已关闭）。 */
  refuse?: { code: string; message: string }
}

export interface StartedRun {
  run: Run
  stop(reason: AbortReason): void
}

type Outcome = { status: RunStatus; code?: string; message?: string; error?: RunResult['error'] }

const ABORT_OUTCOME: Record<AbortReason, Outcome> = {
  user: { status: 'aborted', code: 'user' },
  parent: { status: 'aborted', code: 'parent' },
  shutdown: { status: 'aborted', code: 'interrupted' },
  deadline: { status: 'stopped', code: 'timeout' },
}

const INTENT_STATUSES = new Set<RunStatus>(['completed', 'awaiting_input', 'stopped'])

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const textOf = (task: Task) =>
  task.input
    .flatMap((s) => s.parts)
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('\n')

const MAX_GOAL_CHARS = 200

interface Subscription {
  sub: RunSubscriber
  chain: Promise<void>
  /** 也接收子运行的事件与通知。 */
  children: boolean
  /** 在子运行上的订阅，退订时一起退。 */
  detach: Array<() => void>
}

/** 进行中的子运行。 */
interface Child {
  /** 运行中按费用上限整笔预留（I12）。 */
  reserved: number
  abort(): void
  /** 子运行结束（或被拒绝）时完成，不会失败。 */
  done: Promise<unknown>
}

/** 已准备好的环节模块；准备完成后才有。 */
interface Stages {
  prepared: PreparedRun
  composer: Composer
  evaluator: Evaluator
  delivery: Delivery
}

export function startRun(
  engine: EngineRuntime,
  env: EnvironmentRuntime,
  req: RunRequest,
): StartedRun {
  const { clock, archive, logger } = engine
  const { agent, task, parent } = req
  const caps = env.config.caps ?? {}
  const runId = req.assignment?.runId ?? globalThis.crypto.randomUUID()
  const lineage =
    parent?.lineage ??
    rootLineage(runId, agent.id, caps.delegation?.concurrency ?? DEFAULT_CHILD_CONCURRENCY)
  const delegation = parent ? parent.delegation : caps.delegation
  // 子运行的权限：祖先的规则在前，再叠加自己执行环境的（同一规则只算一次）；任一拒绝即拒绝。
  const permissions: readonly PermissionRule[] = parent
    ? [
        ...parent.permissions,
        ...(env.config.permissions ?? []).filter((r) => !parent.permissions.includes(r)),
      ]
    : (env.config.permissions ?? [])
  const childWaitMs = caps.childDeliveryWaitMs ?? DEFAULT_CHILD_DELIVERY_WAIT_MS
  const startAt = clock.now() - (parent?.queuedMs ?? 0)
  const controller = new AbortController()
  const signal = controller.signal
  const keeper = secretKeeper(engine.vault)

  const events: RunEvent[] = []
  const subscribers = new Set<Subscription>()
  /** 进行中的子运行句柄：要子运行事件的订阅者挂到它们上面。 */
  const childRuns = new Set<Run>()
  const inbox: string[] = []
  let state: RunState = initial({ runId })
  let writes: Promise<unknown> = Promise.resolve()
  let abortReason: AbortReason | undefined
  let ending = false
  let admitted: Admitted | undefined
  let attemptedModel: ModelRef | undefined
  let failure: { code: string; message: string; status?: RunStatus } | undefined
  let slot: AdmissionSlot | undefined
  let stages: Stages | undefined
  let lastInput: ModelInput | undefined
  let heldDelivered: Notice | undefined
  let lastVisible: ReadonlySet<string> = new Set()
  let lastDelivered: { text?: string; output?: unknown } | undefined
  let cancelDeadline = () => {}
  /** 硬截止的时刻；没有 maxTotalMs 时为空。 */
  let deadlineAt: number | undefined
  /** 取消到达时是否已有结局。 */
  let outcomeBeforeAbort = false
  const children = new Set<Child>()
  /** 已结束子运行的用量与费用，不论是否已计入状态。 */
  let childSpent = { usage: emptyUsage(), cost: 0 }
  const driverCalls: RunEventBody[] = []
  const releases: Array<() => void> = []
  let resolveResult!: (r: RunResult) => void
  const result = new Promise<RunResult>((resolve) => (resolveResult = resolve))

  const log = (level: LogLevel, message: string, detail?: unknown) =>
    logger.log(
      keeper.redactValue({
        level,
        message,
        runId,
        ...(state.step > 0 ? { step: state.step } : {}),
        ...(detail !== undefined ? { detail } : {}),
      }),
    )

  const stop = (reason: AbortReason) => {
    if (ending || abortReason) return
    abortReason = reason
    outcomeBeforeAbort = state.outcome !== undefined
    controller.abort()
  }
  const onParentAbort = () => stop('parent')
  if (parent) {
    if (parent.signal.aborted) stop('parent')
    else parent.signal.addEventListener('abort', onParentAbort, { once: true })
  }

  const setDeadline = (at: number) => {
    cancelDeadline()
    deadlineAt = at
    cancelDeadline = clock.setTimer(Math.max(0, at - clock.now()), () => stop('deadline'))
  }

  /** 在 ms 内等到 p 完成返回 true，超时返回 false；计时取自时钟。 */
  const settlesWithin = (p: Promise<unknown>, ms: number): Promise<boolean> => {
    let cancel = () => {}
    const timeout = new Promise<boolean>((resolve) => {
      cancel = clock.setTimer(ms, () => resolve(false))
    })
    return Promise.race([p.then(() => true), timeout]).finally(() => cancel())
  }

  /** 调用方已返回、还在进行的子运行：最多等 childDeliveryWaitMs，之后取消并等它结束（设计 §3.14）。 */
  const settleChildren = async () => {
    if (children.size === 0) return
    const pending = [...children]
    const all = Promise.all(pending.map((c) => c.done))
    if (await settlesWithin(all, childWaitMs)) return
    for (const c of pending) c.abort()
    await all
  }

  // ── 日志、订阅与通知 ──────────────────────────────────────────────

  const deliverTo = (s: Subscription, batch: readonly RunEvent[]): Promise<void> => {
    s.chain = s.chain.then(async () => {
      for (const e of batch) {
        if (!subscribers.has(s)) return
        try {
          await s.sub.onEvent?.(e, { runId })
        } catch (error) {
          log('warn', '订阅者出错', { error: messageOf(error) })
        }
      }
    })
    return s.chain
  }

  const notify = (notice: Notice) => {
    if (notice.t === 'delivered') {
      lastDelivered = {
        ...(notice.text !== undefined ? { text: notice.text } : {}),
        ...(notice.output !== undefined ? { output: notice.output } : {}),
      }
    }
    for (const s of subscribers) {
      try {
        s.sub.onNotice?.(notice, { runId })
      } catch (error) {
        log('warn', '订阅者出错', { error: messageOf(error) })
      }
    }
  }

  /** 编号 → 脱敏 → 写入档案 → 应用到状态 → 通知订阅者；全部写入串行。 */
  const commit = (bodies: readonly RunEventBody[]): Promise<void> => {
    const write = writes.then(async () => {
      if (bodies.length === 0) return
      let at = events.at(-1)?.at ?? -Infinity
      const stamped = bodies.map((body, i) => {
        at = Math.max(clock.now(), at)
        // 脱敏时一并冻结，再写档案、推给订阅者：订阅者改不了运行（设计 §4.4）。
        return keeper.redactValue({ ...body, seq: state.lastSeq + 1 + i, at } as RunEvent, {
          freeze: true,
        })
      })
      const next = stamped.reduce(apply, state)
      await archive.append(runId, stamped)
      events.push(...stamped)
      state = next
      // 订阅者各自按顺序异步收到事件，不拖住写入（设计 §4.4）。
      for (const s of subscribers) void deliverTo(s, stamped)
    })
    writes = write.catch(() => undefined)
    return write
  }

  const flushInbox = async () => {
    if (inbox.length === 0) return
    const texts = inbox.splice(0)
    await commit(texts.map((text) => ({ t: 'steer_received', text })))
  }

  const putBlob = (data: string): Promise<BlobRef> => archive.putBlob(keeper.redact(data))
  const getBlob = async (ref: BlobRef): Promise<string> => {
    const data = await archive.getBlob(ref)
    return typeof data === 'string' ? data : new TextDecoder().decode(data)
  }

  // ── 环节 ─────────────────────────────────────────────────────────

  const main = async () => {
    if (req.refuse) {
      failure = req.refuse
      return
    }
    const admission = admit({
      agent,
      task,
      ...(req.assignment ? { assignment: req.assignment } : {}),
      caps,
      hub: engine.hub,
      defaults: engine.defaults,
      ...(parent ? { inherited: { model: parent.model, ceiling: parent.ceiling } } : {}),
    })
    if (!admission.ok) {
      attemptedModel = admission.model
      failure = { code: admission.code, message: admission.message }
      return
    }
    const a = admission
    admitted = a
    if (a.budget.maxTotalMs !== undefined) setDeadline(startAt + a.budget.maxTotalMs)

    let queuedMs = parent?.queuedMs ?? 0
    if (!parent) {
      try {
        slot = await engine.admission.acquire({
          environment: env.config.name,
          ...(caps.maxConcurrentRuns !== undefined
            ? { environmentLimit: caps.maxConcurrentRuns }
            : {}),
          signal,
        })
        queuedMs = slot.queuedMs
      } catch (error) {
        if (error instanceof AdmissionTimeoutError) {
          failure = { code: 'admission_timeout', message: error.message }
        }
        return
      }
    }

    const goal = (task.goal ?? textOf(task)).slice(0, MAX_GOAL_CHARS)
    const runInfo: RunInfo = {
      runId,
      ...(parent ? { parentRunId: parent.runId } : {}),
      rootRunId: lineage.rootRunId,
      environment: { name: env.config.name, principalReachable: env.config.principal.reachable },
      agent: { id: agent.id, ...(agent.version !== undefined ? { version: agent.version } : {}) },
      task: {
        ...(task.subject !== undefined ? { subject: task.subject } : {}),
        ...(task.tags !== undefined ? { tags: task.tags } : {}),
        ...(task.scope !== undefined ? { scope: task.scope } : {}),
        ...(task.context !== undefined ? { context: task.context } : {}),
        input: textOf(task),
        ...(goal ? { goal } : {}),
      },
      model: { ref: a.model, contextLimit: a.port.capabilities.contextLimit },
    }
    const context = createRunContext({
      run: runInfo,
      clock,
      hub: engine.hub,
      logger,
      hosts: engine.hosts,
      signal,
      state: () => state,
      putBlob,
      redact: keeper.redactValue,
    })
    const { ctxFor } = context
    const drain = () => [...driverCalls.splice(0), ...context.drain()]

    const prepare = async (): Promise<boolean> => {
      const r = await prepareRun({
        run: runInfo,
        capabilities: agent.capabilities ?? [],
        output: a.deliverable.output,
        exposure: a.exposure,
        host: <T>(kind: string): T => {
          const host = engine.hosts.get(kind)
          if (!host) throw new Error(`能力宿主不存在：${kind}`)
          return host as T
        },
        vault: keeper.vault,
        clock,
        signal,
        notice: env.config.notice ?? [],
        history: task.history ?? [],
        ctxFor,
        putBlob,
        log,
      })
      if (!r.ok) {
        failure =
          r.code === 'notice_blocked'
            ? { code: r.code, message: r.message, status: 'stopped' }
            : { code: r.code, message: r.message }
        if (r.code === 'notice_blocked') log('info', '运行被须知拦下', { reason: r.message })
        return false
      }
      const p = r.prepared
      releases.push(...p.releases)
      const started: RunEventBody = {
        t: 'run_started',
        agent: {
          id: agent.id,
          ...(agent.version !== undefined ? { version: agent.version } : {}),
          fingerprint: agent.fingerprint,
        },
        task: {
          fingerprint: task.fingerprint,
          ...(task.subject !== undefined ? { subject: task.subject } : {}),
          ...(task.tags !== undefined ? { tags: task.tags } : {}),
          ...(task.scope !== undefined ? { scope: task.scope } : {}),
          ...(task.context !== undefined ? { context: task.context } : {}),
          budget: a.budget,
          ...(goal ? { goal } : {}),
          content: await putBlob(canonicalJson({ input: task.input, history: task.history ?? [] })),
        },
        environment: {
          name: env.config.name,
          fingerprint: env.fingerprint,
          principalReachable: env.config.principal.reachable,
        },
        engine: { fingerprint: engine.fingerprint },
        capabilities: p.snapshots,
        unavailable: p.unavailable,
        model: a.model,
        contextLimit: a.port.capabilities.contextLimit,
        queuedMs,
        ...(parent ? { parentRunId: parent.runId } : {}),
        rootRunId: lineage.rootRunId,
        schemaVersion: SCHEMA_VERSION,
      }
      await commit(placeExternalCalls([started], [...p.noticeEvents, ...drain()]))
      // 硬截止与时间压力同一起点：run_started 减去排队时长（设计 §5.3），准备的耗时也算在内。
      const startedAt = events.find((e) => e.t === 'run_started')?.at
      if (a.budget.maxTotalMs !== undefined && startedAt !== undefined) {
        setDeadline(startedAt - queuedMs + a.budget.maxTotalMs)
      }
      stages = buildStages(p, runInfo, ctxFor)
      return true
    }

    const buildStages = (
      p: PreparedRun,
      run: RunInfo,
      ctx: (source: string) => ComponentCtx,
    ): Stages => {
      const memory = engine.memory.start(run, ctx(`memory:${engine.memory.id}`))
      let exposure: { visible(state: ToolboxState): string[] } | undefined
      try {
        exposure = a.exposure.start(run, ctx(`exposure:${a.exposure.id}`))
      } catch (error) {
        log('warn', '工具呈现启动出错，退回全部可见', { error: messageOf(error) })
      }
      const history: ModelMessage[] = task.history ?? []
      const minimalView = () =>
        layout({
          notice: p.notice,
          instructions: agent.instructions,
          capabilities: [],
          history: [],
          input: task.input,
          transcript: [],
          tail: [],
          tools: [],
        })
      const corpus = async (): Promise<Corpus> => {
        const effects = new Map(
          events.flatMap((e) => (e.t === 'tool_finished' ? [[e.callId, e.effect] as const] : [])),
        )
        const toolOutputs: Parameters<typeof buildCorpus>[0]['toolOutputs'][number][] = []
        for (const entry of state.transcript) {
          if (entry.origin !== 'tool') continue
          for (const r of entry.results) {
            toolOutputs.push({
              callId: r.callId,
              text: await getBlob(r.shown),
              toolName: r.toolName,
              effect: effects.get(r.callId) ?? 'none',
              isError: r.isError,
            })
          }
        }
        return buildCorpus({ input: task.input, history, toolOutputs })
      }
      const composer = createComposer({
        run,
        clock,
        notice: p.notice,
        instructions: agent.instructions,
        capabilities: p.descriptions,
        task: { input: task.input, history, volatile: task.volatile ?? [] },
        unavailable: p.unavailable,
        toolset: p.toolset,
        exposureOf: p.exposureOf,
        memory,
        ...(exposure ? { exposure } : {}),
        getBlob,
        putBlob,
        log,
      })
      return {
        prepared: p,
        composer,
        evaluator: createEvaluator({
          run,
          clock,
          guards: {
            task: task.guards ?? [],
            environment: env.config.guards ?? [],
            capability: p.guards,
            engine: engine.guards,
          },
          ctxFor: ctx,
          ...(a.price ? { price: a.price } : {}),
          structured: a.deliverable.output.kind === 'structured',
          getBlob,
        }),
        delivery: createDelivery({
          run,
          clock,
          ...(a.price ? { price: a.price } : {}),
          deliverable: a.deliverable,
          environmentChecks: env.config.checks ?? [],
          ctxFor: ctx,
          corpus,
          // 交付通知等 delivery_checked 写入成功后再发（见主循环的 deliver 环节）。
          notify: (n) => (n.t === 'delivered' ? (heldDelivered = n) : notify(n)),
          generate,
          // 上一次视图接上本步的回复和工具结果：兜底要看到最后一步拿到的东西。
          currentView: async () =>
            lastInput
              ? {
                  ...lastInput,
                  messages: [...lastInput.messages, ...(await composer.lastStep(state))],
                }
              : minimalView(),
          minimalView,
          sideEffects: () =>
            sideEffects(events).map(
              (s) =>
                `${s.toolName} ${JSON.stringify(s.input)}${s.status === 'possibly_executed' ? '（可能已执行）' : ''}`,
            ),
          finalizeReserveMs: state.budget.finalizeReserveMs,
          ...(deadlineAt !== undefined ? { timeLeftMs: () => deadlineAt! - clock.now() } : {}),
          signal,
          // 到截止时间不算取消：兜底照样交出固定文本。
          cancelled: () => signal.aborted && abortReason !== 'deadline',
        }),
      }
    }

    /** 兜底交付：禁用工具调用一次模型，记为 external_call（deliver:fallback）。 */
    const generate = async (input: ModelInput, timeoutMs: number): Promise<string | undefined> => {
      // 取消后不再发起模型调用（设计 §3.14）；写请求期间取消的，信号不会再触发 abort 事件，所以写完再查一次。
      if (signal.aborted) return undefined
      const startedAt = clock.now()
      const request = await putBlob(canonicalJson(input))
      if (signal.aborted) return undefined
      const timed = new AbortController()
      const onAbort = () => timed.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      const cancel = clock.setTimer(timeoutMs, () => timed.abort())
      const record = async (response: string, usage?: NormalizedUsage) =>
        driverCalls.push({
          t: 'external_call',
          source: 'deliver:fallback',
          kind: 'model',
          request,
          response: await putBlob(response),
          ...(usage ? { usage } : {}),
          startedAt,
          durationMs: clock.now() - startedAt,
        })
      try {
        const response = await a.port.call(input, { signal: timed.signal, onDelta: () => {} })
        await record(response.text, response.usage)
        // 被截断或被过滤的文本不能当阶段性交付，退到下一级。
        const cut = response.finishReason === 'length' || response.finishReason === 'content-filter'
        return cut ? undefined : response.text
      } catch (error) {
        await record(canonicalJson({ error: messageOf(error) }))
        return undefined
      } finally {
        cancel()
        signal.removeEventListener('abort', onAbort)
      }
    }

    const reason = async (): Promise<RunEventBody[]> => {
      const step = state.step
      const startedAt = clock.now()
      let partial = ''
      let firstTokenAt: number | undefined
      // 收尾预留线：模型调用最晚在这里截断，剩下的时间留给兜底交付（设计 §3.11）。
      const reserve = state.budget.finalizeReserveMs
      const cutAt = deadlineAt !== undefined && reserve > 0 ? deadlineAt - reserve : undefined
      if (cutAt !== undefined && clock.now() >= cutAt) {
        return [{ t: 'model_aborted', step, partialText: '', deadline: true }]
      }
      const cut = new AbortController()
      const cancelCut =
        cutAt === undefined ? () => {} : clock.setTimer(cutAt - clock.now(), () => cut.abort())
      try {
        const response = await a.port.call(lastInput!, {
          signal: cutAt === undefined ? signal : AbortSignal.any([signal, cut.signal]),
          onDelta: (d) => {
            if (firstTokenAt === undefined) firstTokenAt = clock.now()
            if (d.type === 'text') partial += d.text
            notify({ t: d.type === 'text' ? 'text_delta' : 'reasoning_delta', step, text: d.text })
          },
        })
        return [
          {
            t: 'model_responded',
            step,
            response,
            startedAt,
            ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
          },
        ]
      } catch (error) {
        if (signal.aborted) return [{ t: 'model_aborted', step, partialText: partial }]
        if (cut.signal.aborted) {
          return [{ t: 'model_aborted', step, partialText: partial, deadline: true }]
        }
        const detail = isModelCallError(error)
          ? error.detail
          : {
              code: 'MODEL_ERROR' as const,
              message: messageOf(error),
              retryable: false,
              attempts: [],
            }
        return [
          {
            t: 'model_failed',
            step,
            error: detail,
            ...(partial ? { partialText: partial } : {}),
            startedAt,
          },
        ]
      } finally {
        cancelCut()
      }
    }

    const approvals = new Mutex()
    /** 已花掉与已预留的费用：自己的、已结束子运行的实际费用、进行中子运行的上限（I12）。 */
    const committedCost = () =>
      runCost(state, a.price) -
      state.childCost +
      childSpent.cost +
      [...children].reduce((sum, c) => sum + c.reserved, 0)

    const spawn: ToolCtx['spawn'] = async (childAgent, childTask, opts) => {
      const childEnv = opts?.environment ? engine.environmentOf(opts.environment) : env
      if (!childEnv) throw toolError('TOOL_EXCEPTION', '执行环境不属于本引擎')
      const budget = state.budget
      if (budget.maxCost !== undefined) {
        // 子运行的模型没有价格：费用上限约束不了它，不委托。
        const childModel = childAgent.model?.prefer ?? a.model
        if (!engine.hub.price(childModel)) {
          throw toolError('SPAWN_BUDGET', `子运行的模型 ${childModel} 没有价格，无法约束费用上限`)
        }
      }
      // 子运行的时长不占父运行的收尾预留：父运行到时间仍要给出兜底交付。
      const remaining = {
        ...(deadlineAt !== undefined
          ? { timeMs: deadlineAt - budget.finalizeReserveMs - clock.now() }
          : {}),
        ...(budget.maxCost !== undefined ? { cost: budget.maxCost - committedCost() } : {}),
      }
      const check = checkSpawn({
        lineage,
        delegation,
        agent: childAgent,
        task: childTask,
        remaining,
      })
      if (!check.ok) throw check.error
      const ceilingCost = check.ceiling.maxCost
      // 子运行最多能花的（任务、执行环境上限、父运行剩余额度中最小的）在运行中整笔预留。
      const reserved =
        ceilingCost === undefined
          ? 0
          : Math.min(
              ceilingCost,
              childTask.budget?.maxCost ?? Infinity,
              childEnv.config.caps?.budget?.maxCost ?? Infinity,
            )
      // 子运行挂在取消树上：本运行或调用方的信号取消时随之取消；结束后摘掉监听（设计 §3.14）。
      const link = new AbortController()
      const abortChild = () => link.abort()
      const sources = opts?.signal ? [signal, opts.signal] : [signal]
      for (const s of sources) s.addEventListener('abort', abortChild, { once: true })
      if (sources.some((s) => s.aborted)) link.abort()
      const child: Child = { reserved, abort: abortChild, done: Promise.resolve() }
      children.add(child)
      const childLineage: Lineage = {
        ...lineage,
        depth: lineage.depth + 1,
        agentIds: [...lineage.agentIds, childAgent.id],
      }
      const queuedFrom = clock.now()
      const settled = (async () => {
        try {
          const result = await lineage.root.limiter(childLineage.depth).run(async () => {
            const started = startRun(engine, childEnv, {
              agent: childAgent,
              task: childTask,
              parent: {
                runId,
                model: a.model,
                signal: link.signal,
                lineage: childLineage,
                ceiling: check.ceiling,
                delegation,
                permissions,
                queuedMs: clock.now() - queuedFrom,
              },
            })
            childRuns.add(started.run)
            for (const s of subscribers) {
              if (s.children) s.detach.push(started.run.subscribe(s.sub, { children: true }))
            }
            try {
              return await started.run.result
            } finally {
              childRuns.delete(started.run)
            }
          })
          const { input, output, cacheRead, cacheWrite } = result.usage
          childSpent = {
            usage: addUsage(childSpent.usage, { input, output, cacheRead, cacheWrite }),
            cost: childSpent.cost + (result.cost ?? 0),
          }
          return result
        } finally {
          children.delete(child)
          for (const s of sources) s.removeEventListener('abort', abortChild)
        }
      })()
      child.done = settled.catch(() => undefined)
      return settled
    }

    /** 调用方返回后才结束的子运行：用量与费用补记到本批的 tool_finished，计入父运行（设计 §8.3）。 */
    const withLateChildren = (batch: RunEventBody[]): RunEventBody[] => {
      type Finished = Extract<RunEventBody, { t: 'tool_finished' }>
      const finished = batch.filter((e): e is Finished => e.t === 'tool_finished')
      let counted = state.usage.children
      let countedCost = state.childCost
      for (const e of finished) {
        if (e.usage) counted = addUsage(counted, e.usage)
        countedCost += e.cost ?? 0
      }
      const spent = childSpent.usage
      const late = {
        input: Math.max(0, spent.input - counted.input),
        output: Math.max(0, spent.output - counted.output),
        cacheRead: Math.max(0, spent.cacheRead - counted.cacheRead),
        cacheWrite: Math.max(0, spent.cacheWrite - counted.cacheWrite),
      }
      const target =
        finished.find((e) => e.errorCode === 'TOOL_TIMEOUT' || e.errorCode === 'TOOL_ABORTED') ??
        finished.at(-1)
      if (!target || Object.values(late).every((v) => v === 0)) return batch
      // 分不出是哪个调用发起的：记到超时或取消的调用上，没有时记到最后一个。
      const patched: Finished = {
        ...target,
        usage: addUsage(target.usage ?? emptyUsage(), late),
        cost: (target.cost ?? 0) + Math.max(0, childSpent.cost - countedCost),
      }
      return batch.map((e) => (e === target ? patched : e))
    }

    const actStage = async (toolset: ReadonlyMap<string, PreparedTool>) => {
      const batch = await act(state.response?.toolCalls ?? [], {
        step: state.step,
        toolset,
        visible: lastVisible,
        blocks: state.blocks,
        permissions: {
          rules: permissions,
          ...(env.config.principal.approver ? { approver: env.config.principal.approver } : {}),
          principalReachable: env.config.principal.reachable,
          approvalTimeoutMs: caps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
          run: runInfo,
          ctxFor,
          clock,
          approvals,
        },
        ...(caps.toolConcurrency !== undefined ? { toolConcurrency: caps.toolConcurrency } : {}),
        clock,
        signal,
        runId,
        scope: task.scope ?? {},
        task: {
          ...(task.subject !== undefined ? { subject: task.subject } : {}),
          ...(task.context !== undefined ? { context: task.context } : {}),
        },
        spawn,
        notify,
        redact: keeper.redact,
        putBlob,
      })
      await settleChildren()
      return withLateChildren(batch)
    }

    for (let stage = nextStage(state); stage && stage !== 'end'; stage = nextStage(state)) {
      await flushInbox()
      if (signal.aborted) {
        // 取消后不再推进；已发出的调用补上 TOOL_ABORTED，保证成对（I2）。
        if (stage === 'act' && stages)
          await commit(placeExternalCalls(await actStage(stages.prepared.toolset), drain()))
        return
      }
      switch (stage) {
        case 'prepare':
          if (!(await prepare())) return
          break
        case 'compose': {
          const r = await stages!.composer.compose(state)
          lastInput = r.input
          lastVisible = r.visible
          await commit(placeExternalCalls(r.events, drain()))
          break
        }
        case 'reason':
          await commit(await reason())
          break
        case 'act':
          await commit(placeExternalCalls(await actStage(stages!.prepared.toolset), drain()))
          break
        case 'evaluate':
          await commit(placeExternalCalls(await stages!.evaluator.evaluate(state), drain()))
          break
        case 'deliver': {
          const bodies = await stages!.delivery.deliver(state)
          await commit(placeExternalCalls(bodies, drain()))
          const held = heldDelivered
          heldDelivered = undefined
          // 只有定稿真的写进了日志才发通知（取消或写失败时都不发）。
          const settled = bodies.some(
            (b) => b.t === 'delivery_checked' && b.outcome === 'delivered',
          )
          if (held && settled) notify(held)
          break
        }
      }
    }
  }

  // ── 结束 ─────────────────────────────────────────────────────────

  const outcomeOf = (): Outcome => {
    const o = state.outcome
    // 取消先于结局到达：按取消结束，不算完成或收尾（设计 §3.14 取消后不再交付）。
    const cancelledFirst =
      abortReason !== undefined &&
      ABORT_OUTCOME[abortReason].status === 'aborted' &&
      !outcomeBeforeAbort
    if (o && o.status !== 'aborted' && !cancelledFirst) return o
    if (abortReason) return ABORT_OUTCOME[abortReason]
    if (failure) {
      return { status: failure.status ?? 'failed', code: failure.code, message: failure.message }
    }
    return { status: 'failed', code: 'engine_error', message: '运行未正常结束' }
  }

  const buildResult = (): RunResult => {
    const o = outcomeOf()
    const candidate = state.candidate
    const text =
      lastDelivered?.text ??
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
    const quality = qualityOf(events)
    const price = admitted?.price
    const cost = price ? runCost(state, price) : state.childCost > 0 ? state.childCost : undefined
    // 交给调用方的是普通的可变副本：状态里的值来自冻结的日志事件，不随输出契约有没有 schema 而不同。
    return copyData({
      runId,
      status: o.status,
      ...(o.code !== undefined ? { code: o.code } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(lastDelivered?.output !== undefined ? { output: lastDelivered.output } : {}),
      ...(intent ? { intent } : {}),
      ...(error ? { error } : {}),
      ...(quality ? { quality } : {}),
      model: state.model ?? admitted?.model ?? attemptedModel ?? '',
      usage: state.usage,
      ...(cost !== undefined ? { cost } : {}),
      steps: state.step,
      toolCalls: state.toolCallCount,
    })
  }

  /** 工具结果没能写进日志（例如存储暂时失败）时补上 TOOL_MISSING_RESULT，保证调用都有结果（I2）。 */
  const recordMissingResults = async () => {
    const pending = (state.response?.toolCalls ?? []).filter((c) => !state.results[c.id])
    if (pending.length === 0) return
    try {
      const { shown } = normalizeOutput({
        error: toolError('TOOL_MISSING_RESULT', '调用结果没有写入日志；如有副作用，可能已经执行'),
      })
      const ref = await putBlob(shown)
      const at = clock.now()
      await commit(
        pending.map((c) => ({
          t: 'tool_finished' as const,
          callId: c.id,
          capability: state.tools[c.name]?.capability ?? '',
          effect: state.tools[c.name]?.effect ?? 'side_effect',
          shown: ref,
          isError: true,
          errorCode: 'TOOL_MISSING_RESULT',
          startedAt: at,
          durationMs: 0,
        })),
      )
    } catch (error) {
      log('error', '补写缺失的工具结果失败', { error: messageOf(error) })
    }
  }

  const finish = async () => {
    try {
      // 写入期间又到的引导也写进去：收件箱清空才标记结束，之后的引导按已结束忽略。
      while (inbox.length > 0) await flushInbox()
    } catch (error) {
      log('error', '写入引导失败', { error: messageOf(error) })
    }
    ending = true
    // 还在进行的子运行：等它交付，超时后取消（设计 §3.14）。
    await settleChildren()
    await recordMissingResults()
    let runResult = buildResult()
    const violations = checkInvariants([
      ...events,
      { t: 'run_ended', result: runResult, seq: state.lastSeq + 1, at: clock.now() },
    ])
    if (violations.length > 0) {
      const message = violations.map((v) => `${v.invariant} ${v.message}`).join('；')
      log('error', '不变量自检失败', { violations })
      runResult = {
        ...runResult,
        status: 'failed',
        code: 'engine_error',
        error: { code: 'engine_error', message, retryable: false },
      }
    }
    // 没开始就结束的运行：带上归属，档案才能按状态、主题查到它，并按保留期清理。
    const origin: RunOrigin | undefined = events.some((e) => e.t === 'run_started')
      ? undefined
      : {
          rootRunId: lineage.rootRunId,
          ...(parent ? { parentRunId: parent.runId } : {}),
          environment: env.config.name,
          environmentFingerprint: env.fingerprint,
          engineFingerprint: engine.fingerprint,
          agentId: agent.id,
          ...(agent.version !== undefined ? { agentVersion: agent.version } : {}),
          agentFingerprint: agent.fingerprint,
          ...(task.subject !== undefined ? { subject: task.subject } : {}),
        }
    try {
      await commit([{ t: 'run_ended', result: runResult, ...(origin ? { origin } : {}) }])
    } catch (error) {
      log('error', '写入 run_ended 失败', { error: messageOf(error) })
    }
    for (const release of releases) {
      try {
        release()
      } catch (error) {
        log('warn', '释放能力出错', { error: messageOf(error) })
      }
    }
    slot?.release()
    cancelDeadline()
    parent?.signal.removeEventListener('abort', onParentAbort)
    if (subscribers.size > 0) {
      const chains = Promise.all([...subscribers].map((s) => s.chain))
      if (!(await settlesWithin(chains, SUBSCRIBER_DRAIN_MS))) {
        log('warn', `订阅者 ${SUBSCRIBER_DRAIN_MS}ms 内没有处理完事件`)
      }
    }
    resolveResult(runResult)
  }

  void main()
    .catch((error: unknown) => {
      failure = { code: 'engine_error', message: messageOf(error) }
      log('error', '运行出错', { error: messageOf(error) })
    })
    .then(finish)

  const run: Run = {
    runId,
    result,
    subscribe(sub, opts) {
      const children = opts?.children === true
      const s: Subscription = { sub, chain: Promise.resolve(), children, detach: [] }
      subscribers.add(s)
      const fromSeq = opts?.fromSeq ?? 1
      void deliverTo(
        s,
        events.filter((e) => e.seq >= fromSeq),
      )
      if (children) for (const child of childRuns) s.detach.push(child.subscribe(sub, { children }))
      return () => {
        subscribers.delete(s)
        for (const off of s.detach.splice(0)) off()
      }
    },
    steer(text) {
      if (!ending) inbox.push(text)
    },
    abort(reason) {
      if (reason !== undefined && !ending) log('info', `运行被中止：${reason}`)
      stop('user')
    },
  }
  return { run, stop }
}
