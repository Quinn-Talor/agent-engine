// 工具流水线 a–c（设计 §8.2）：查找、阻断、参数校验。d 环节（工具自校验）由 act 直接调用 `validate`。

import type { ActiveBlock } from '../core/state.js'
import { toolError, type ToolErrorEnvelope } from '../contracts/errors.js'
import type { PreparedTool } from './tools.js'

const MAX_SUGGEST_DISTANCE = 2
const MAX_SCHEMA_CHARS = 1000

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!
      prev[j] = Math.min(above + 1, prev[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return prev[b.length]!
}

/** 拼写相近的候选：距离 ≤ 2 且最小，相同距离取先出现的。 */
export function suggest(target: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestDistance = MAX_SUGGEST_DISTANCE + 1
  for (const c of candidates) {
    if (c === target) continue
    const d = levenshtein(target, c)
    if (d < bestDistance) {
      best = c
      bestDistance = d
    }
  }
  return best
}

/** a 查找：是否在本步可见集合中。 */
const ONLY_LISTED = '本步只能调用列出的工具'

export function lookupTool(
  name: string,
  toolset: ReadonlyMap<string, PreparedTool>,
  visible: ReadonlySet<string>,
): { tool: PreparedTool } | { error: ToolErrorEnvelope } {
  const tool = toolset.get(name)
  if (tool && visible.has(name)) return { tool }
  // 只有本步能用 search_tool 时才指向它；别的工具呈现没有这个工具。
  const searchable = visible.has('search_tool')
  if (tool) {
    return {
      error: toolError(
        'TOOL_NOT_AVAILABLE',
        `工具 ${name} 本步不可见`,
        searchable ? '先调用 search_tool 查找并展开需要的工具' : ONLY_LISTED,
      ),
    }
  }
  const close = suggest(name, visible)
  return {
    error: toolError(
      'TOOL_NOT_AVAILABLE',
      `工具 ${name} 不存在`,
      close
        ? `你是不是想用 "${close}"`
        : searchable
          ? '先调用 search_tool 查找可用的工具'
          : ONLY_LISTED,
    ),
  }
}

/** b 封路：原因、封住的步、替代做法与后果。 */
export function blockedError(block: ActiveBlock): ToolErrorEnvelope {
  return toolError(
    'TOOL_BLOCKED',
    `该调用已被封住：${block.reason}（第 ${block.since} 步）`,
    `${block.suggest ?? '换一种做法，或改用其他工具'}。再调用将收尾`,
  )
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** c 参数校验：诊断缺了哪些、传了哪些、期望的 schema、拼写相近的字段。 */
export function validateInput(
  tool: PreparedTool,
  input: unknown,
): { value: unknown } | { error: ToolErrorEnvelope } {
  const parsed = tool.schema.safeParse(input)
  if (parsed.success) return { value: parsed.data }

  const issues = parsed.error.issues
    .map((i) => `- ${i.path.map(String).join('.') || '(根)'}: ${i.message}`)
    .join('\n')
  const schema = tool.jsonSchema as { properties?: Record<string, unknown>; required?: unknown }
  const expected = Object.keys(schema.properties ?? {})
  const required = Array.isArray(schema.required) ? schema.required.map(String) : []
  const provided = isPlainObject(input) ? Object.keys(input) : []
  const missing = required.filter((k) => !provided.includes(k))
  const unexpected = provided.filter((k) => !expected.includes(k))

  const message = [
    '参数校验失败：',
    issues,
    `缺少：${missing.join(', ') || '无'}`,
    `已提供：${provided.join(', ') || '无'}`,
  ].join('\n')
  const hints = [`期望的 schema：${JSON.stringify(tool.jsonSchema).slice(0, MAX_SCHEMA_CHARS)}`]
  for (const m of missing) {
    const typo = suggest(m, unexpected)
    if (typo) hints.push(`你是不是想用 "${m}"（而不是 "${typo}"）`)
  }
  return { error: toolError(tool.invalidInputCode, message, hints.join('\n')) }
}
