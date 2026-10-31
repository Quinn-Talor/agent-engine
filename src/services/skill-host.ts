// skill 宿主（设计 §8.3）：每次运行一个共享的激活工具 activate_skill，参数里用枚举选择；
// 激活内容不超过 20000 字；前文可能已被压缩，再次激活仍返回全文，开头加一句说明。

import type { CapabilityHost } from '../contracts/capability.js'
import { toolError } from '../contracts/errors.js'
import type { ToolDef } from '../contracts/tool.js'

const MAX_CONTENT_CHARS = 20_000

/** 解析后的 SKILL.md：内容哈希冻结 skill 的版本（设计 §4.2）。 */
export interface SkillPackage {
  name: string
  description: string
  /** SKILL.md 的正文（不含 frontmatter）。 */
  content: string
  hash: string
  dir?: string
}

export interface SkillHost extends CapabilityHost {
  readonly kind: 'skill'
  /**
   * 在能力准备时同步调用：同一运行的多个 skill 拿到同一个激活工具。
   * 不从 history 推断激活状态：前文里的 skill 内容可能已被压缩掉，再次激活时重新给出全文。
   */
  register(runId: string, pkg: SkillPackage): { tool: ToolDef; release(): void }
}

interface RunSkills {
  skills: Map<string, SkillPackage>
  /** 激活工具参数的枚举，与 schema 中的数组是同一个对象。 */
  names: string[]
  /** 本次运行激活过的 skill：再次激活时加一句说明。 */
  activated: Set<string>
  refs: number
  tool: ToolDef
}

const markerOf = (name: string) => `<skill name="${name}">`

export function skillHost(): SkillHost {
  const runs = new Map<string, RunSkills>()

  const toolFor = (names: string[]): ToolDef => ({
    name: 'activate_skill',
    description: '激活一个 skill，读取它的完整说明',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: names } },
      required: ['name'],
      additionalProperties: false,
    },
    execution: { effect: 'none' },
    async execute(input, ctx) {
      const name = (input as { name: string }).name
      const entry = runs.get(ctx.runId)
      const pkg = entry?.skills.get(name)
      if (!entry || !pkg) return toolError('INVALID_INPUT', `skill ${name} 不在本次运行中`)
      const { content } = pkg
      const body =
        content.length > MAX_CONTENT_CHARS
          ? `${content.slice(0, MAX_CONTENT_CHARS)}\n…（已截断，原文 ${content.length} 字）`
          : content
      const skill = `${markerOf(name)}\n${body}\n</skill>`
      if (entry.activated.has(name))
        return `（skill ${name} 之前已激活过，以下再次给出全文）\n${skill}`
      entry.activated.add(name)
      return skill
    },
  })

  return {
    kind: 'skill',
    register(runId, pkg) {
      let entry = runs.get(runId)
      if (!entry) {
        const names: string[] = []
        entry = { skills: new Map(), names, activated: new Set(), refs: 0, tool: toolFor(names) }
        runs.set(runId, entry)
      }
      entry.skills.set(pkg.name, pkg)
      if (!entry.names.includes(pkg.name)) entry.names.push(pkg.name)
      entry.refs += 1
      const current = entry
      let released = false
      return {
        tool: current.tool,
        release() {
          if (released) return
          released = true
          current.refs -= 1
          if (current.refs === 0 && runs.get(runId) === current) runs.delete(runId)
        },
      }
    },
  }
}
