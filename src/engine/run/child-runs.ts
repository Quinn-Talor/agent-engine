// 子运行（设计 §3.14、§8.3、I12）：委托入口；进行中子运行的登记、费用预留与取消树；
// 调用方返回后的等待与取消；已结束子运行的用量与费用，补记到父运行。

import type { Clock } from '../../contracts/common.js'
import type { PermissionRule } from '../../contracts/component.js'
import type { Caps } from '../../contracts/environment.js'
import { toolError } from '../../contracts/errors.js'
import type { RunEventBody } from '../../contracts/events.js'
import type { Run } from '../../contracts/run.js'
import type { ToolCtx } from '../../contracts/tool.js'
import { runCost } from '../../core/supervision/facts.js'
import { addUsage, emptyUsage, type RunState } from '../../core/run/state.js'
import type { Admitted } from './admit.js'
import { checkSpawn, type Lineage } from './lineage.js'
import { settlesWithin } from './run-abort.js'
import type { EngineRuntime, EnvironmentRuntime, RunRequest, StartedRun } from './run-driver.js'

/** 进行中的子运行。 */
interface Child {
  /** 运行中按费用上限整笔预留（I12）。 */
  reserved: number
  abort(): void
  /** 子运行结束（或被拒绝）时完成，不会失败。 */
  done: Promise<unknown>
}

export interface ChildRunsDeps {
  engine: EngineRuntime
  env: EnvironmentRuntime
  runId: string
  lineage: Lineage
  delegation: Caps['delegation']
  /** 本运行生效的权限规则，传给子运行。 */
  permissions: readonly PermissionRule[]
  clock: Clock
  /** 本运行的取消信号：取消时子运行随之取消。 */
  signal: AbortSignal
  /** 调用方已返回后，等子运行交付的上限。 */
  deliveryWaitMs: number
  state(): RunState
  /** 本运行的硬截止时刻。 */
  deadlineAt(): number | undefined
  start(env: EnvironmentRuntime, req: RunRequest): StartedRun
  /** 子运行已开始：要子运行事件的订阅者挂上去。 */
  started(run: Run): void
}

export interface ChildRuns {
  /** 本运行委托子运行的入口（工具上下文的 spawn）；模型与价格取自本运行的受理结果。 */
  spawner(admitted: Pick<Admitted, 'model' | 'price'>): ToolCtx['spawn']
  /** 进行中子运行的句柄。 */
  running(): Iterable<Run>
  /** 调用方已返回、还在进行的子运行：最多等 deliveryWaitMs，之后取消并等它结束（设计 §3.14）。 */
  settle(): Promise<void>
  /** 调用方返回后才结束的子运行：用量与费用补记到本批的 tool_finished，计入父运行（设计 §8.3）。 */
  withLate(batch: RunEventBody[]): RunEventBody[]
}

export function createChildRuns(deps: ChildRunsDeps): ChildRuns {
  const { engine, env, runId, lineage, delegation, permissions, clock, signal, state } = deps
  const children = new Set<Child>()
  const childRuns = new Set<Run>()
  /** 已结束子运行的用量与费用，不论是否已计入状态。 */
  let childSpent = { usage: emptyUsage(), cost: 0 }

  const spawner = (a: Pick<Admitted, 'model' | 'price'>): ToolCtx['spawn'] => {
    /** 已花掉与已预留的费用：自己的、已结束子运行的实际费用、进行中子运行的上限（I12）。 */
    const committedCost = () =>
      runCost(state(), a.price) -
      state().childCost +
      childSpent.cost +
      [...children].reduce((sum, c) => sum + c.reserved, 0)

    return async (childAgent, childTask, opts) => {
      const childEnv = opts?.environment ? engine.environmentOf(opts.environment) : env
      if (!childEnv) throw toolError('TOOL_EXCEPTION', '执行环境不属于本引擎')
      const budget = state().budget
      if (budget.maxCost !== undefined) {
        // 子运行的模型没有价格：费用上限约束不了它，不委托。
        const childModel = childAgent.model?.prefer ?? a.model
        if (!engine.hub.price(childModel)) {
          throw toolError('SPAWN_BUDGET', `子运行的模型 ${childModel} 没有价格，无法约束费用上限`)
        }
      }
      // 子运行的时长不占父运行的收尾预留：父运行到时间仍要给出兜底交付。
      const deadlineAt = deps.deadlineAt()
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
            const started = deps.start(childEnv, {
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
            deps.started(started.run)
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
  }

  return {
    spawner,
    running: () => childRuns,
    async settle() {
      if (children.size === 0) return
      const pending = [...children]
      const all = Promise.all(pending.map((c) => c.done))
      if (await settlesWithin(clock, all, deps.deliveryWaitMs)) return
      for (const c of pending) c.abort()
      await all
    },
    withLate(batch) {
      type Finished = Extract<RunEventBody, { t: 'tool_finished' }>
      const finished = batch.filter((e): e is Finished => e.t === 'tool_finished')
      let counted = state().usage.children
      let countedCost = state().childCost
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
    },
  }
}
