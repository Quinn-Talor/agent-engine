// 搜索呈现（设计 §9.2）：延后工具一开始只露出 search_tool；调用 search_tool 后，下一步展开全部延后工具；
// 调用过的延后工具在本次运行内一直可见；没有延后工具时 search_tool 也不露出。

import { z } from 'zod'
import type { Exposure, ToolboxState } from '../../contracts/component.js'
import type { ToolDef } from '../../contracts/tool.js'

const SEARCH_TOOL = 'search_tool'
/** 按 runId 记录工具箱状态的运行数上限，超过时删除最早的。 */
const MAX_RUNS = 256

export function searchExposure(): Exposure {
  const states = new Map<string, ToolboxState>()

  const remember = (runId: string, state: ToolboxState) => {
    states.delete(runId)
    states.set(runId, state)
    if (states.size > MAX_RUNS) states.delete(states.keys().next().value!)
  }

  const searchTool: ToolDef = {
    name: SEARCH_TOOL,
    description: '按关键词查找可用的工具；找到的工具下一步可用。',
    inputSchema: z.object({ query: z.string().optional() }),
    execution: { effect: 'none' },
    async execute(input, ctx) {
      const query = ((input as { query?: string }).query ?? '').trim()
      const deferred = (states.get(ctx.runId)?.prepared ?? []).filter(
        (p) => p.exposure === 'deferred',
      )
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
      const matches = deferred.filter((p) => {
        const haystack = `${p.name} ${p.description ?? ''}`.toLowerCase()
        return tokens.every((t) => haystack.includes(t))
      })
      if (matches.length > 0) {
        const lines = matches.map((p) => `- ${p.name} — ${p.description ?? ''}`)
        return `以下工具下一步可用：\n${lines.join('\n')}`
      }
      const names = deferred.map((p) => p.name).join('、') || '无'
      return `没有匹配"${query}"的工具。可用的延后工具：${names}`
    },
  }

  return {
    id: 'search',
    version: '1',
    tools: [searchTool],
    start(run) {
      return {
        visible(state) {
          remember(run.runId, state)
          const eager = state.prepared
            .filter((p) => p.exposure === 'eager' && p.name !== SEARCH_TOOL)
            .map((p) => p.name)
          const deferred = state.prepared
            .filter((p) => p.exposure === 'deferred')
            .map((p) => p.name)
          if (deferred.length === 0) return eager
          const called = new Set(state.calls.map((c) => c.name))
          const shown = called.has(SEARCH_TOOL) ? deferred : deferred.filter((n) => called.has(n))
          const hasSearch = state.prepared.some((p) => p.name === SEARCH_TOOL)
          return [...eager, ...shown, ...(hasSearch ? [SEARCH_TOOL] : [])]
        },
      }
    },
  }
}
