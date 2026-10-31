// 计数守卫（方案 §3.2）：计数 + 告知阈值 + 终止阈值。先告知、再终止；计数一次跳过终止阈值时也先告知。

import type { JsonValue } from '../../contracts/common.js'
import type { Guard, GuardOpinion, StepFacts } from '../../contracts/component.js'

export interface ThresholdGuardSpec {
  id: string
  version?: string
  config?: JsonValue
  warn: number
  /** 不设时只告知、从不终止。 */
  end?: number
  /** 默认 'finalize'。 */
  endAs?: 'finalize' | 'stop'
  /** 每次 start 调用一次，返回本次运行的计数函数：增量，或 'reset' 清零。 */
  count: () => (facts: StepFacts) => number | 'reset'
  /** 终止 code，默认守卫 id。 */
  code?: (facts: StepFacts) => string
  problem: (facts: StepFacts, n: number) => string
  /** 固定的建议，或按本步事实给出。 */
  suggest?: string | ((facts: StepFacts) => string)
}

export function thresholdGuard(spec: ThresholdGuardSpec): Guard {
  const { warn, end } = spec
  const endAs = spec.endAs ?? 'finalize'
  const code = spec.code ?? (() => spec.id)
  return {
    id: spec.id,
    version: spec.version ?? '1',
    config: spec.config ?? { warn, end: end ?? null, endAs },
    start() {
      const count = spec.count()
      let n = 0
      let warned = false
      return {
        check(facts): GuardOpinion | undefined {
          const k = count(facts)
          if (k === 'reset') {
            n = 0
            warned = false
            return undefined
          }
          if (k === 0) return undefined
          n += k
          if (end !== undefined && n >= end && warned) {
            return { end: { as: endAs, code: code(facts) }, detail: `计数 ${n}` }
          }
          if (n >= warn && !warned) {
            warned = true
            const problem =
              end === undefined
                ? spec.problem(facts, n)
                : `${spec.problem(facts, n)}（${n}/${end}，再出现 ${Math.max(1, end - n)} 次将${endAs === 'stop' ? '停止' : '收尾'}）`
            const suggest = typeof spec.suggest === 'function' ? spec.suggest(facts) : spec.suggest
            return {
              warn: { problem, ...(suggest !== undefined ? { suggest } : {}) },
              detail: `计数 ${n}`,
            }
          }
          return undefined
        },
      }
    },
  }
}
