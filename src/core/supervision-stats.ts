// 监督统计（docs/guard-mechanism.md §3.5）：守卫的告知、终止、顺延、纠偏、封路违规、顾问、验收与开销，
// 按运行汇总，用于校准阈值。

import type { Opinion } from '../contracts/component.js'
import type { RunEvent } from '../contracts/events.js'
import type { NormalizedUsage } from '../contracts/model.js'
import { foldState } from './projections.js'

export interface SupervisionStats {
  steps: number
  /** 每个来源的告知次数（含顺延改写的）。 */
  warns: Record<string, number>
  /** 每个来源进入裁决的终止次数。 */
  ends: Record<string, number>
  deferred: number
  /** 纠偏消息条数。 */
  steering: number
  /** 告知之后，同一来源在剩余步里没有再要求终止的告知数。 */
  effective: number
  blockViolations: number
  advice: { requested: number; adopted: number }
  /** 裁决为收尾或停止、且来源含守卫的步数。 */
  terminals: number
  checks: { returned: number; delivered: number; shadowFailures: number }
  usage: NormalizedUsage
}

const ADVISE = /\/supervision:advise$/
const GUARD_SOURCE = /^(task|environment|capability|engine):/

const isEnd = (o: Opinion): boolean => 'finalize' in o || 'stop' in o

export function supervisionStats(events: readonly RunEvent[]): SupervisionStats {
  const stats: SupervisionStats = {
    steps: 0,
    warns: {},
    ends: {},
    deferred: 0,
    steering: 0,
    effective: 0,
    blockViolations: 0,
    advice: { requested: 0, adopted: 0 },
    terminals: 0,
    checks: { returned: 0, delivered: 0, shadowFailures: 0 },
    usage: foldState(events).usage.supervision,
  }
  const warnings: Array<{ step: number; source: string }> = []
  const endings: Array<{ step: number; source: string }> = []

  for (const e of events) {
    switch (e.t) {
      case 'evaluated': {
        stats.steps += 1
        for (const r of e.opinions) {
          if (r.mode !== 'active' || !r.opinion) continue
          if ('continue' in r.opinion) {
            stats.warns[r.source] = (stats.warns[r.source] ?? 0) + 1
            if (r.deferred) stats.deferred += 1
            if (r.source.endsWith(':advisor')) stats.advice.adopted += 1
            warnings.push({ step: e.step, source: r.source })
          } else if (isEnd(r.opinion)) {
            stats.ends[r.source] = (stats.ends[r.source] ?? 0) + 1
            endings.push({ step: e.step, source: r.source })
          }
        }
        stats.blockViolations += e.observation.interventions.violated.length
        if (
          isEnd(e.verdict) &&
          e.verdict.sources.some((s) => s === 'guard:violation' || GUARD_SOURCE.test(s))
        ) {
          stats.terminals += 1
        }
        break
      }
      case 'intervention_applied':
        if (e.source === 'steering') stats.steering += 1
        break
      case 'external_call':
        // 运行上下文把组件的模型调用记为 `<组件来源>/<purpose>`。
        if (e.kind === 'model' && ADVISE.test(e.source)) stats.advice.requested += 1
        break
      case 'delivery_checked':
        if (e.outcome === 'returned') stats.checks.returned += 1
        if (e.outcome === 'delivered') stats.checks.delivered += 1
        stats.checks.shadowFailures += e.checks.filter((c) => c.mode === 'shadow' && !c.pass).length
        break
    }
  }

  for (const w of warnings) {
    if (!endings.some((x) => x.source === w.source && x.step > w.step)) stats.effective += 1
  }
  return stats
}
