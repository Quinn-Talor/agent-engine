// 搜索呈现（设计 §9.2）：延后工具一开始只露出 search_tool；search_tool 按检索器的排序只加载命中的前几个，
// 本次运行内可见集合只增不减（常驻 → search_tool → 延后工具按加载先后），新加载的追加在末尾，不打碎提示词前缀；
// 延后工具很少时直接全给；没有命中只给服务器摘要。检索器可替换（tool-ranker.ts），出错时本次改用 BM25。

import { z } from 'zod'
import type { Exposure, ToolboxState } from '../../contracts/component.js'
import type { ToolDef } from '../../contracts/tool.js'
import { bm25Ranker, type RankedTool, type ToolRanker } from './tool-ranker.js'

const SEARCH_TOOL = 'search_tool'
/** 按 runId 记录工具箱状态的运行数上限，超过时删除最早的。 */
const MAX_RUNS = 256

export interface SearchExposureOptions {
  /** 单次检索最多加载几个，缺省 8。 */
  topK?: number
  /** 一次运行最多同时可见几个延后工具，缺省 40。 */
  maxLoaded?: number
  /** 延后工具不超过这个数时直接全给，缺省 20；0 表示总是检索。 */
  eagerBelow?: number
  /** 检索器，缺省 BM25。 */
  ranker?: ToolRanker
}

interface RunState {
  prepared: ToolboxState['prepared']
  calledNames: Set<string>
  /** 经检索加载的延后工具，按加载先后。 */
  loaded: string[]
}

export function searchExposure(opts: SearchExposureOptions = {}): Exposure {
  const topK = opts.topK ?? 8
  const maxLoaded = opts.maxLoaded ?? 40
  const eagerBelow = opts.eagerBelow ?? 20
  const ranker = opts.ranker ?? bm25Ranker()
  const fallback = bm25Ranker()
  const states = new Map<string, RunState>()

  const stateOf = (runId: string): RunState => {
    let s = states.get(runId)
    if (!s) {
      s = { prepared: [], calledNames: new Set(), loaded: [] }
      states.set(runId, s)
      if (states.size > MAX_RUNS) states.delete(states.keys().next().value!)
    }
    return s
  }

  const summary = (deferred: ToolboxState['prepared']) => {
    const counts = new Map<string, number>()
    for (const p of deferred) counts.set(p.capability, (counts.get(p.capability) ?? 0) + 1)
    return [...counts].map(([cap, n]) => `- ${cap} — ${n} 个工具`).join('\n')
  }

  const searchTool: ToolDef = {
    name: SEARCH_TOOL,
    description:
      '按关键词查找可用的工具，可用 server 限定服务器；只有找到的工具下一步可用，最多 8 个。' +
      '关键词用工具所属服务的语言写，不确定时中英文都写。',
    inputSchema: z.object({ query: z.string().optional(), server: z.string().optional() }),
    execution: { effect: 'none' },
    async execute(input, ctx) {
      const { query = '', server = '' } = input as { query?: string; server?: string }
      const state = stateOf(ctx.runId)
      const allDeferred = state.prepared.filter((p) => p.exposure === 'deferred')
      const target = server.trim().toLowerCase()
      const deferred = target
        ? allDeferred.filter((p) => {
            const cap = p.capability.toLowerCase()
            return cap === target || cap === `mcp:${target}`
          })
        : allDeferred
      if (target && deferred.length === 0) {
        return `没有名为 ${server} 的服务器。可用的服务器：\n${summary(allDeferred) || '无'}`
      }
      const candidates = deferred.map((p) => ({
        name: p.name,
        capability: p.capability,
        ...(p.description !== undefined ? { description: p.description } : {}),
      }))
      const known = new Set(candidates.map((c) => c.name))
      let hits: RankedTool[]
      let note = ''
      try {
        hits = (await ranker.rank(query, candidates)).filter((h) => known.has(h.name))
      } catch {
        hits = await fallback.rank(query, candidates)
        note = '\n检索器出错，已改用关键词检索'
      }
      if (hits.length === 0) {
        return `没有匹配"${query}"的工具。可以换关键词，或用 server 限定服务器：\n${summary(allDeferred) || '无'}${note}`
      }
      const take = hits.slice(0, topK)
      for (const h of take) if (!state.loaded.includes(h.name)) state.loaded.push(h.name)
      // 超过上限时淘汰最早加载、且从未调用过的
      const visibleCount = () =>
        new Set([
          ...state.loaded,
          ...allDeferred.map((p) => p.name).filter((n) => state.calledNames.has(n)),
        ]).size
      while (visibleCount() > maxLoaded) {
        const i = state.loaded.findIndex((n) => !state.calledNames.has(n))
        if (i < 0) break
        state.loaded.splice(i, 1)
      }
      const describe = new Map(candidates.map((c) => [c.name, c.description ?? '']))
      const lines = take.map((h) => `- ${h.name} — ${describe.get(h.name) ?? ''}`)
      const more =
        hits.length > topK
          ? `\n另有 ${hits.length - topK} 个匹配，可换更具体的关键词或用 server 限定`
          : ''
      return `以下工具下一步可用：\n${lines.join('\n')}${more}${note}`
    },
  }

  return {
    id: 'search',
    version: '2',
    tools: [searchTool],
    start(run) {
      return {
        visible(state) {
          const s = stateOf(run.runId)
          s.prepared = state.prepared
          for (const c of state.calls) s.calledNames.add(c.name)
          const eager = state.prepared
            .filter((p) => p.exposure === 'eager' && p.name !== SEARCH_TOOL)
            .map((p) => p.name)
          const deferred = state.prepared
            .filter((p) => p.exposure === 'deferred')
            .map((p) => p.name)
          if (deferred.length === 0) return eager
          if (deferred.length <= eagerBelow) return [...eager, ...deferred]
          const deferredSet = new Set(deferred)
          const shown = [...s.loaded]
          for (const c of state.calls) {
            if (deferredSet.has(c.name) && !shown.includes(c.name)) shown.push(c.name)
          }
          const hasSearch = state.prepared.some((p) => p.name === SEARCH_TOOL)
          return [...eager, ...(hasSearch ? [SEARCH_TOOL] : []), ...shown]
        },
      }
    },
  }
}
