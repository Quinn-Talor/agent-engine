// 交付物：交什么（法律意见书的结构）、怎么验收、做不完时交什么。
// 验收按顺序跑：引用核对（自定义）→ 引文核对（标准）→ 完成审查（标准，风险高才多调一次模型）；
// 执行环境的强制验收（免责声明）叠加在最后。

import {
  completionReview,
  groundingCheck,
  standardFallback,
  structured,
  type Check,
  type Deliverable,
  type Fallback,
  type ModelRef,
} from '@talor/agent-engine'
import { OpinionSchema, everyIssueCited } from './domain.ts'

/**
 * 引用核对：意见书里引用的每一条法规，必须在本次检索到的资料里出现过（语料 = 任务输入 + history +
 * 工具输出）。这是"引用契约"：模型不能引用它没查到的条文。
 */
export const citationsGrounded: Check = {
  id: 'citations-grounded',
  version: '1',
  mode: 'gate',
  maxAttempts: 2,
  start: () => ({
    async accept(candidate, corpus) {
      // 只核对意见书；形状不对的输出由输出契约退回，这里不重复判断。
      const parsed = OpinionSchema.safeParse(candidate.output)
      if (!parsed.success) return { pass: true }
      const opinion = parsed.data
      const found = corpus.sources
        .filter((s) => s.origin === 'tool' && !s.isError)
        .map((s) => s.text)
      const missing = [...new Set(opinion.analysis.flatMap((a) => a.citations))].filter(
        (c) => !found.some((text) => text.includes(c)),
      )
      if (missing.length === 0) return { pass: true }
      return {
        pass: false,
        issues: missing.map((c) => `引用的 ${c} 没有出现在检索结果里`),
        hint: `先用 search_statutes 查到这些条文再引用，查不到就删掉：${missing.join('、')}`,
      }
    },
  }),
}

/** 兜底：在标准兜底说明的基础上，改写律所关心的几种收尾说明。 */
export function legalFallback(): Fallback {
  const standard = standardFallback()
  return {
    instructions: {
      ...standard.instructions,
      max_steps: {
        reachable:
          '这次咨询的处理步数用完了。用三五句话给出阶段性意见：已经查到的法条和初步判断，还缺哪些材料，最后问委托人一个能让工作继续的问题。',
        unreachable:
          '这次咨询的处理步数用完了。用三五句话给出阶段性意见：已经查到的法条和初步判断，还缺哪些材料。',
      },
    },
    fixedText: '本次咨询没能完成，值班律师会在一个工作日内联系您。',
  }
}

/** 正式咨询的交付物：结构化的法律意见书。 */
export function legalOpinion(reviewModel: ModelRef): Deliverable {
  return {
    output: structured(OpinionSchema, { validate: everyIssueCited, maxRepairs: 2 }),
    checks: [
      citationsGrounded,
      groundingCheck({ mode: 'gate' }),
      completionReview({ model: reviewModel }),
    ],
    fallback: legalFallback(),
  }
}
