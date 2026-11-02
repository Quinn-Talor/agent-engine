// skill 能力（设计 §4.2）：按内容哈希冻结 SKILL.md；能力说明里列出 skill；共享 skill 宿主的激活工具。

import type { Capability, SkillHost, SkillPackage } from '../../sdk.js'

export function skill(pkg: SkillPackage): Capability {
  return {
    id: `skill:${pkg.name}`,
    version: '1',
    kind: 'skill',
    config: { name: pkg.name, hash: pkg.hash },
    async prepare(ctx) {
      // 在第一个 await 之前同步登记，准备环节合并时激活工具的枚举已经收齐。
      const { tool, release } = ctx.host<SkillHost>('skill').register(ctx.run.runId, pkg)
      return {
        tools: [tool],
        description: [
          {
            role: 'system',
            parts: [
              {
                type: 'text',
                text: `可用的 skill：${pkg.name} — ${pkg.description}。需要时调用 activate_skill 读取完整说明。`,
              },
            ],
          },
        ],
        snapshot: { fingerprint: pkg.hash },
        release,
      }
    },
  }
}
