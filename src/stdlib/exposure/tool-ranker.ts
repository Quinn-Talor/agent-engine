// 工具检索器（设计 §9.2）：按查询给候选工具打分排序，供 search_tool 决定加载哪些延后工具。
// 检索器是插件点：内置 BM25（中文按单字与相邻两字切词）；应用可以传自己的实现（例如向量检索），
// 引擎不依赖任何模型。

export interface ToolCandidate {
  name: string
  capability: string
  description?: string
}

export interface RankedTool {
  name: string
  score: number
}

export interface ToolRanker {
  readonly id: string
  /** 只返回相关的候选，按相关度降序。 */
  rank(query: string, candidates: readonly ToolCandidate[]): Promise<RankedTool[]>
}

const CJK = /[一-鿿]/

/** 小写；驼峰处断开；按非字母数字汉字切分；含汉字的段切成单字与相邻两字。 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const segments = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
  for (const segment of segments) {
    for (const part of segment.match(/[一-鿿]+|[a-z0-9]+/g) ?? []) {
      if (!CJK.test(part)) {
        out.push(part)
        continue
      }
      const chars = [...part]
      chars.forEach((c, i) => {
        out.push(c)
        if (i + 1 < chars.length) out.push(c + chars[i + 1])
      })
    }
  }
  return out
}

const byScoreThenName = (a: RankedTool, b: RankedTool) =>
  b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** BM25：名字（按 `_`、`-`、驼峰拆词）计两次，加上描述与能力 id。 */
export function bm25Ranker(opts: { k1?: number; b?: number } = {}): ToolRanker {
  const k1 = opts.k1 ?? 1.2
  const b = opts.b ?? 0.75
  return {
    id: 'bm25',
    async rank(query, candidates) {
      const terms = [...new Set(tokenize(query))]
      if (terms.length === 0 || candidates.length === 0) return []
      const docs = candidates.map((c) => {
        const name = tokenize(c.name)
        return [...name, ...name, ...tokenize(c.description ?? ''), ...tokenize(c.capability)]
      })
      const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1
      const df = new Map<string, number>()
      for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)
      const n = docs.length
      return candidates
        .map((c, i) => {
          const doc = docs[i]!
          const tf = new Map<string, number>()
          for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)
          let score = 0
          for (const t of terms) {
            const f = tf.get(t)
            if (!f) continue
            const d = df.get(t)!
            const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5))
            score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * doc.length) / avg))
          }
          return { name: c.name, score }
        })
        .filter((r) => r.score > 0)
        .sort(byScoreThenName)
    },
  }
}
