// 血缘与子运行规则（设计 §8.3、I12）：深度有上限、不委托给自己或祖先、按根运行限制每个子 agent 的次数与每层的并发、
// 预算不超过父运行的剩余额度。检查通过时给出子运行的预算上限。

import type { Agent } from '../contracts/agent.js'
import type { Caps } from '../contracts/environment.js'
import { toolError, type ToolErrorEnvelope } from '../contracts/errors.js'
import type { Task } from '../contracts/task.js'
import { Limiter } from '../executor/act.js'

const DEFAULT_DEPTH = 3
const DEFAULT_PER_AGENT = 3

/** 按根运行统计的委托次数与子运行并发。 */
export interface RootCounters {
  spawned: Map<string, number>
  /**
   * 第 depth 层子运行共用的并发上限。每层各用一个：占着名额的运行只等更深一层的名额，
   * 等待不会成环（共用一个时，子运行占着名额等孙运行，孙运行等同一个名额，互相卡死）。
   */
  limiter(depth: number): { run<T>(fn: () => Promise<T>): Promise<T> }
}

export interface Lineage {
  rootRunId: string
  /** 根运行为 0。 */
  depth: number
  /** 根运行到当前运行的 agent id。 */
  agentIds: readonly string[]
  root: RootCounters
}

export function rootLineage(rootRunId: string, agentId: string, concurrency: number): Lineage {
  const limiters = new Map<number, Limiter>()
  const limiter = (depth: number): Limiter => {
    let l = limiters.get(depth)
    if (!l) {
      l = new Limiter(concurrency)
      limiters.set(depth, l)
    }
    return l
  }
  return { rootRunId, depth: 0, agentIds: [agentId], root: { spawned: new Map(), limiter } }
}

export type SpawnCheck =
  | { ok: true; ceiling: { maxTotalMs?: number; maxCost?: number } }
  | { ok: false; error: ToolErrorEnvelope }

export function checkSpawn(input: {
  lineage: Lineage
  delegation: Caps['delegation']
  agent: Agent
  task: Task
  remaining: { timeMs?: number; cost?: number }
}): SpawnCheck {
  const { lineage, agent, task, remaining } = input
  const delegation = input.delegation ?? {}
  const refuse = (code: Parameters<typeof toolError>[0], message: string): SpawnCheck => ({
    ok: false,
    error: toolError(code, message),
  })

  const depth = delegation.depth ?? DEFAULT_DEPTH
  if (lineage.depth + 1 > depth) {
    return refuse('SPAWN_DEPTH_EXCEEDED', `委托深度超过上限 ${depth}`)
  }
  if (lineage.agentIds.includes(agent.id)) {
    return refuse('SPAWN_CYCLE', `不能委托给自己或祖先：${agent.id}`)
  }
  const perAgent = delegation.perAgent ?? DEFAULT_PER_AGENT
  if ((lineage.root.spawned.get(agent.id) ?? 0) >= perAgent) {
    return refuse('SPAWN_LIMIT', `子 agent ${agent.id} 的委托次数已达上限 ${perAgent}`)
  }

  const time = task.budget?.maxTotalMs
  if (time === undefined && remaining.timeMs === undefined) {
    return refuse('SPAWN_BUDGET', '子运行必须设置 maxTotalMs')
  }
  if (
    remaining.timeMs !== undefined &&
    (remaining.timeMs <= 0 || (time !== undefined && time > remaining.timeMs))
  ) {
    return refuse('SPAWN_BUDGET', '子运行的时长超过父运行的剩余时长')
  }
  const cost = task.budget?.maxCost
  if (
    remaining.cost !== undefined &&
    (remaining.cost <= 0 || (cost !== undefined && cost > remaining.cost))
  ) {
    return refuse('SPAWN_BUDGET', '子运行的费用超过父运行的剩余额度')
  }

  lineage.root.spawned.set(agent.id, (lineage.root.spawned.get(agent.id) ?? 0) + 1)
  return {
    ok: true,
    ceiling: {
      ...(remaining.timeMs !== undefined ? { maxTotalMs: remaining.timeMs } : {}),
      ...(remaining.cost !== undefined ? { maxCost: remaining.cost } : {}),
    },
  }
}
