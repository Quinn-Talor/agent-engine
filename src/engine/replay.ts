// 回归重放（设计 §6.5）：模型、工具、外部调用的响应从日志读取，其余组件重新执行，把新的裁决和交付结果
// 与日志逐条比较。沿日志的轨迹推进状态：在每个评估批次之前用新的守卫重新评估，在每个交付批次之前
// 用新的交付物与强制验收重新判定；轨迹本身不变，所以第一次分歧之后的比较只有参考价值。

import type { Deliverable } from '../contracts/agent.js'
import type { Clock, ModelMessage } from '../contracts/common.js'
import type {
  Check,
  ComponentCtx,
  Corpus,
  Fallback,
  GuardGroups,
  RunInfo,
  Verdict,
} from '../contracts/component.js'
import type { BlobRef, RunEvent } from '../contracts/events.js'
import type { ModelInput, ModelPrice } from '../contracts/model.js'
import type { Task } from '../contracts/task.js'
import { canonicalJson, parseCanonical, sha256Hex } from '../core/definition/hash.js'
import { buildCorpus, sideEffects } from '../core/log/projections.js'
import { seededRandom } from '../core/run/random.js'
import { apply, emptyUsage, initial, type RunState } from '../core/run/state.js'
import { createDelivery, type Delivery } from '../executor/deliver.js'
import { createEvaluator } from '../executor/evaluate.js'

export interface RegressionInput {
  events: readonly RunEvent[]
  getBlob(ref: BlobRef): Promise<string>
  /** 按归属分组的守卫，与运行时的来源前缀一致。 */
  guards: GuardGroups
  deliverable: Deliverable & { fallback: Fallback }
  environmentChecks?: readonly Check[]
  price?: ModelPrice
}

export interface RegressionReport {
  steps: Array<{ step: number; expected: Verdict; actual: Verdict; same: boolean }>
  deliveries: Array<{
    step: number
    attempt: number
    expected: string
    actual: string
    same: boolean
  }>
  firstDivergence?: { kind: 'verdict' | 'delivery'; step: number }
  /** 新组件发起、日志里没有的调用（`<来源>/<purpose 或 name>`）。 */
  missing: string[]
}

type Of<T extends RunEvent['t']> = Extract<RunEvent, { t: T }>
type Batch =
  | { kind: 'evaluate'; logged: Of<'evaluated'> }
  | { kind: 'deliver'; logged: Of<'delivery_checked'> }

const EMPTY_VIEW: ModelInput = { messages: [], tools: [] }

/** 评估批次与交付批次的起点：紧挨着的外部调用属于同一批。 */
function batchStarts(events: readonly RunEvent[]): Map<number, Batch> {
  const starts = new Map<number, Batch>()
  events.forEach((e, i) => {
    let batch: Batch | undefined
    if (e.t === 'evaluated') batch = { kind: 'evaluate', logged: e }
    else if (e.t === 'delivery_checked' && events[i - 1]?.t !== 'fallback_generated') {
      batch = { kind: 'deliver', logged: e }
    } else if (e.t === 'fallback_generated' && events[i + 1]?.t === 'delivery_checked') {
      batch = { kind: 'deliver', logged: events[i + 1] as Of<'delivery_checked'> }
    }
    if (!batch) return
    let start = i
    while (start > 0 && events[start - 1]!.t === 'external_call') start -= 1
    starts.set(start, batch)
  })
  return starts
}

function runInfoOf(events: readonly RunEvent[]): RunInfo {
  const started = events.find((e): e is Of<'run_started'> => e.t === 'run_started')
  const ended = events.find((e): e is Of<'run_ended'> => e.t === 'run_ended')
  if (!started) throw new Error('回放日志中没有 run_started')
  const task = started.task
  return {
    runId: ended?.result.runId ?? '',
    ...(started.parentRunId !== undefined ? { parentRunId: started.parentRunId } : {}),
    rootRunId: started.rootRunId,
    environment: {
      name: started.environment.name,
      principalReachable: started.environment.principalReachable,
      approver: started.environment.approver === true,
    },
    agent: {
      id: started.agent.id,
      ...(started.agent.version !== undefined ? { version: started.agent.version } : {}),
    },
    task: {
      ...(task.subject !== undefined ? { subject: task.subject } : {}),
      ...(task.tags !== undefined ? { tags: task.tags } : {}),
      ...(task.scope !== undefined ? { scope: task.scope } : {}),
      ...(task.context !== undefined ? { context: task.context } : {}),
      ...(task.goal !== undefined ? { goal: task.goal } : {}),
    },
    model: { ref: started.model, contextLimit: started.contextLimit },
  }
}

export async function regressionReplay(input: RegressionInput): Promise<RegressionReport> {
  const { events, getBlob } = input
  // 在受理或准备环节就结束的运行（例如被须知拦下）没有步，也没有可比较的裁决与交付。
  if (!events.some((e) => e.t === 'run_started')) return { steps: [], deliveries: [], missing: [] }
  const run = runInfoOf(events)
  let now = events[0]?.at ?? 0
  const clock: Clock = { now: () => now, setTimer: () => () => {} }

  // 外部调用按来源排队，回放时依次取用。
  const queues = new Map<string, Array<Of<'external_call'>>>()
  for (const e of events) {
    if (e.t !== 'external_call') continue
    const queue = queues.get(e.source) ?? []
    queue.push(e)
    queues.set(e.source, queue)
  }
  const missing = new Set<string>()
  const take = (key: string, model: boolean) => {
    const queue = queues.get(key)
    const at = queue?.findIndex((e) => (e.kind === 'model') === model) ?? -1
    if (queue && at >= 0) return queue.splice(at, 1)[0]!
    missing.add(key)
    return undefined
  }

  const started = events.find((e): e is Of<'run_started'> => e.t === 'run_started')!
  const signal = new AbortController().signal
  const contexts = new Map<string, ComponentCtx>()
  // 与运行时相同的种子随机数（run-context.ts）：按 runId 播种，所有组件共用一个序列。
  const random = seededRandom(parseInt(sha256Hex(run.runId).slice(0, 8), 16))
  const ctxFor = (source: string): ComponentCtx => {
    let ctx = contexts.get(source)
    if (ctx) return ctx
    ctx = {
      clock,
      random,
      signal,
      // 回放只知道运行模型的窗口与输出预留。
      modelLimits: (ref) =>
        ref === undefined || ref === started.model
          ? { contextLimit: started.contextLimit, maxOutputTokens: started.outputReserve }
          : undefined,
      async callModel(req) {
        const logged = take(`${source}/${req.purpose}`, true)
        if (!logged) return undefined
        return {
          text: await getBlob(logged.response),
          usage: logged.usage ?? emptyUsage(),
          model: run.model.ref,
          finishReason: 'stop',
        }
      },
      async record<T>(name: string): Promise<T> {
        const logged = take(`${source}/${name}`, false)
        if (!logged) throw new Error('回放日志中没有这次调用')
        // 日志里保存的是这次调用结果的规范 JSON。
        return parseCanonical(await getBlob(logged.response)) as T
      },
      log: () => undefined,
      host: () => {
        throw new Error('回放中没有能力宿主')
      },
    }
    contexts.set(source, ctx)
    return ctx
  }

  let state: RunState = initial({ runId: run.runId })
  const seen: RunEvent[] = []
  // 语料的构造与运行时一致（run-driver.ts）：任务输入、history、带工具名/副作用/是否出错的工具输出。
  // 语料只用文本，内容里图片与文件的引用（`{ $blob }`）不取回。
  let content: Promise<{ input: Task['input']; history: ModelMessage[] }> | undefined
  const logged = () =>
    (content ??= getBlob(started.task.content).then(
      (text) => parseCanonical(text) as { input: Task['input']; history: ModelMessage[] },
    ))
  const corpus = async (): Promise<Corpus> => {
    const effects = new Map(
      seen.flatMap((e) => (e.t === 'tool_finished' ? [[e.callId, e.effect] as const] : [])),
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
    const content = await logged()
    const ledger = started.session?.window.ledger
    return buildCorpus({
      input: content.input,
      history: content.history,
      toolOutputs,
      ...(ledger ? { ledger } : {}),
    })
  }
  const evaluator = createEvaluator({
    run,
    clock,
    guards: input.guards,
    ctxFor,
    ...(input.price ? { price: input.price } : {}),
    structured: input.deliverable.output.kind === 'structured',
    getBlob,
  })
  let delivery: Delivery | undefined
  const deliveryOf = () =>
    (delivery ??= createDelivery({
      run,
      clock,
      ...(input.price ? { price: input.price } : {}),
      deliverable: input.deliverable,
      environmentChecks: input.environmentChecks ?? [],
      ctxFor,
      corpus,
      notify: () => undefined,
      generate: async () => {
        const logged = take('deliver:fallback', true)
        return logged ? getBlob(logged.response) : undefined
      },
      currentView: () => EMPTY_VIEW,
      minimalView: () => EMPTY_VIEW,
      sideEffects: () => sideEffects(seen).map((s) => `${s.toolName} ${JSON.stringify(s.input)}`),
      finalizeReserveMs: state.budget.finalizeReserveMs,
    }))

  const report: RegressionReport = { steps: [], deliveries: [], missing: [] }
  const diverge = (kind: 'verdict' | 'delivery', step: number) => {
    report.firstDivergence ??= { kind, step }
  }
  const starts = batchStarts(events)
  for (const [i, e] of events.entries()) {
    now = e.at
    const batch = starts.get(i)
    if (batch?.kind === 'evaluate') {
      // 按记下的判定时刻重算剩余时长。
      now = batch.logged.decidedAt
      const produced = await evaluator.evaluate(state)
      const actual = (produced[0] as Of<'evaluated'>).verdict
      const same = canonicalJson(actual) === canonicalJson(batch.logged.verdict)
      report.steps.push({ step: batch.logged.step, expected: batch.logged.verdict, actual, same })
      if (!same) diverge('verdict', batch.logged.step)
    } else if (batch?.kind === 'deliver') {
      const produced = await deliveryOf().deliver(state)
      const checked = produced.find(
        (p): p is Omit<Of<'delivery_checked'>, 'seq' | 'at'> => p.t === 'delivery_checked',
      )
      const actual = checked?.outcome ?? 'none'
      const same = actual === batch.logged.outcome
      report.deliveries.push({
        step: batch.logged.step,
        attempt: batch.logged.attempt,
        expected: batch.logged.outcome,
        actual,
        same,
      })
      if (!same) diverge('delivery', batch.logged.step)
    }
    state = apply(state, e)
    seen.push(e)
  }
  report.missing = [...missing]
  return report
}
