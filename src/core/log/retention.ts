// 保留期（设计 §8.5、会话方案 §13）：运行档案按执行环境的天数清理过期的运行。会话按整体过期——会话里的
// 每个运行（含子运行，按 rootRunId 归到它的轮）都过期了，整个会话才一起清理；有固定的或没结束的运行时整个
// 会话保留。不会只剩半条链。

import type { RetentionPolicy } from '../../contracts/events.js'

const DAY_MS = 86_400_000

export interface RetainedRun {
  runId: string
  rootRunId: string
  session?: string
  environment: string
  endedAt?: number
  pinned: boolean
}

/** 本次应清理的运行。 */
export function expiredRuns(runs: readonly RetainedRun[], policy: RetentionPolicy): Set<string> {
  const due = (r: RetainedRun) => {
    if (r.endedAt === undefined || r.pinned) return false
    const days = policy.environments?.[r.environment] ?? policy.defaultDays
    return r.endedAt < policy.now - days * DAY_MS
  }
  const sessionOf = new Map(
    runs.flatMap((r) => (r.session !== undefined ? [[r.runId, r.session]] : [])),
  )
  const groupOf = (r: RetainedRun) => r.session ?? sessionOf.get(r.rootRunId)
  const groups = new Map<string, RetainedRun[]>()
  const expired = new Set<string>()
  for (const r of runs) {
    const group = groupOf(r)
    if (group === undefined) {
      if (due(r)) expired.add(r.runId)
    } else groups.set(group, [...(groups.get(group) ?? []), r])
  }
  for (const members of groups.values()) {
    if (members.every(due)) for (const r of members) expired.add(r.runId)
  }
  return expired
}
