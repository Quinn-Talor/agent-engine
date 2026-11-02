// 子 agent 能力（设计 §4.2）：声明可委托的 Agent；快照指纹为子 agent 的指纹；共享委托宿主的委托工具。

import type { Agent, Budget, Capability, DelegationHost, Environment } from '../../sdk.js'

const DESCRIPTION_CHARS = 200

/** 预算进入配置（方案 D14）：只取数值字段。 */
function budgetConfig(budget: Budget | undefined): Record<string, number> | null {
  if (!budget) return null
  const config: Record<string, number> = {}
  for (const [key, value] of Object.entries(budget))
    if (typeof value === 'number') config[key] = value
  return config
}

function firstInstruction(agent: Agent): string {
  for (const segment of agent.instructions) {
    for (const part of segment.parts) if (part.type === 'text') return part.text
  }
  return agent.id
}

export function subagent(
  agent: Agent,
  opts: { name?: string; description?: string; budget?: Budget; environment?: Environment } = {},
): Capability {
  const name = opts.name ?? agent.id
  const description = opts.description ?? firstInstruction(agent).slice(0, DESCRIPTION_CHARS)
  return {
    id: `subagent:${name}`,
    version: '1',
    kind: 'subagent',
    config: {
      name,
      agent: agent.id,
      fingerprint: agent.fingerprint,
      budget: budgetConfig(opts.budget),
    },
    async prepare(ctx) {
      // 在第一个 await 之前同步登记，准备环节合并时委托工具的枚举已经收齐。
      const { tool, release } = ctx.host<DelegationHost>('delegation').register(ctx.run.runId, {
        name,
        description,
        agent,
        ...(opts.budget ? { budget: opts.budget } : {}),
        ...(opts.environment ? { environment: opts.environment } : {}),
      })
      return {
        tools: [tool],
        description: [
          {
            role: 'system',
            parts: [
              {
                type: 'text',
                text: `可委托的子 agent：${name} — ${description}。用 delegate 委托。`,
              },
            ],
          },
        ],
        snapshot: { fingerprint: agent.fingerprint },
        release,
      }
    },
  }
}
