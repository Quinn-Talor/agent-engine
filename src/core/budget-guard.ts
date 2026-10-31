// 预算守卫（方案 §3.2 守卫 1）：资源用到告知线时告知一次，让模型尽快收束。
// 核心内置，来源 `guard:pressure`；预算用完的终止仍由 decide 合并后检查。

import type { Guard, GuardOpinion, StepFacts } from '../contracts/component.js'

type Dimension = 'steps' | 'time' | 'tokens' | 'cost' | 'context'

const NAMES: Record<Dimension, string> = {
  steps: '步数',
  time: '时间',
  tokens: 'token',
  cost: '费用',
  context: '上下文',
}

/** 步数：剩余 ≤ 1 步或已用 95%；其余：已用 90%。 */
function crossed(facts: StepFacts): Dimension[] {
  const { pressure, stepsLeft } = facts
  const out: Dimension[] = []
  if ((stepsLeft !== undefined && stepsLeft <= 1) || pressure.steps >= 0.95) out.push('steps')
  for (const d of ['time', 'tokens', 'cost', 'context'] as const) {
    if (pressure[d] >= 0.9) out.push(d)
  }
  return out
}

const percent = (v: number): string => `${Math.round(v * 100)}%`

export function budgetGuard(): Guard {
  return {
    id: 'budget',
    version: '1',
    start() {
      const warned = new Set<Dimension>()
      return {
        check(facts): GuardOpinion | undefined {
          const fresh = crossed(facts).filter((d) => !warned.has(d))
          if (fresh.length === 0) return undefined
          for (const d of fresh) warned.add(d)
          return {
            warn: {
              problem: `资源即将用完：${fresh.map((d) => NAMES[d]).join('、')}`,
              suggest: '尽快收束：基于已有信息给出结果',
            },
            detail: fresh
              .map((d) =>
                d === 'steps'
                  ? `剩余 ${facts.stepsLeft ?? 0} 步`
                  : `${NAMES[d]} ${percent(facts.pressure[d])}`,
              )
              .join('，'),
          }
        },
      }
    },
  }
}
