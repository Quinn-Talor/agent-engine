// 规划（设计 §4.2）：update_plan 工具、计划推进守卫、使用说明。
// 计划推进：计划建立后连续 6 步没有推进时告知，12 步收尾 no_progress（docs/guard-mechanism.md §3.2）。

import { z } from 'zod'
import type { Capability } from '../../contracts/capability.js'
import type { Guard, StepFacts } from '../../contracts/component.js'
import type { ToolDef } from '../../contracts/tool.js'
import { thresholdGuard } from '../supervision/threshold-guard.js'
import { toolsFingerprint } from './tools.js'

/** update_plan 的返回文本中的计划进度：已完成项数 / 总项数（完成审查据此判断未完成的计划项）。 */
export const PLAN_PROGRESS = /已完成 (\d+)\/(\d+) 项/

type PlanItem = { id: string; text: string; status: 'pending' | 'in_progress' | 'done' }

const UPDATE_PLAN: ToolDef = {
  name: 'update_plan',
  description: '建立或更新计划。每完成一项就更新它的状态。',
  inputSchema: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        status: z.enum(['pending', 'in_progress', 'done']),
      }),
    ),
  }),
  execution: { effect: 'none' },
  execute: async (input) => {
    const { items } = input as { items: PlanItem[] }
    const done = items.filter((i) => i.status === 'done').length
    return `计划已更新：已完成 ${done}/${items.length} 项`
  },
}

/** "推进"= 一次成功的 update_plan，且输入与上一次成功的更新不同。 */
export function progressGuard([warn, end]: [number, number]): Guard {
  return thresholdGuard({
    id: 'progress',
    warn,
    end,
    config: { thresholds: [warn, end] },
    count: () => {
      let lastHash: string | undefined
      return (facts: StepFacts) => {
        const update = facts.toolCalls.find((c) => c.name === 'update_plan' && c.ok)
        if (update && update.inputHash !== lastHash) {
          lastHash = update.inputHash
          return 'reset'
        }
        return lastHash === undefined ? 0 : 1
      }
    },
    code: () => 'no_progress',
    problem: (_facts, n) => `计划已经 ${n} 步没有推进`,
    suggest: '先用 update_plan 更新计划，再继续',
  })
}

export function planning(opts: { thresholds?: [number, number] } = {}): Capability {
  const thresholds = opts.thresholds ?? [6, 12]
  return {
    id: 'planning',
    version: '1',
    kind: 'planning',
    config: { thresholds },
    async prepare() {
      return {
        tools: [UPDATE_PLAN],
        guards: [progressGuard(thresholds)],
        description: [
          {
            role: 'system',
            parts: [
              {
                type: 'text',
                text: '开始时用 update_plan 建立计划；每完成一项就把它标记为 done，并更新正在进行的项。',
              },
            ],
          },
        ],
        snapshot: { fingerprint: toolsFingerprint([UPDATE_PLAN]) },
      }
    },
  }
}
