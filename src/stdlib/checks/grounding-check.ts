// 引用核对验收（设计 §10.6）：累计 ≥ 2 处无法核实就不通过，提示列出内容，要求修正或删除。
// 默认 shadow：先校准，准确后交互场景用 annotate，高风险后台任务用 gate。

import type { Check, CheckMode } from '../../sdk.js'
import { grounding } from './grounding.js'

const DEFAULT_THRESHOLD = 2

export function groundingCheck(
  opts: { mode?: CheckMode; maxAttempts?: number; threshold?: number } = {},
): Check {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  return {
    id: 'grounding',
    version: '1',
    mode: opts.mode ?? 'shadow',
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    config: { threshold },
    start: () => ({
      async accept(candidate, corpus) {
        // 只检查交付文本：结构化输出的 JSON 满是双引号，会被当成引文。
        const items = grounding.unverified(candidate.text ?? '', corpus)
        if (items.length < threshold) return { pass: true }
        return {
          pass: false,
          issues: items.map((i) =>
            i.kind === 'quote' ? `引文无法核实：${i.text}` : `实体找不到出处：${i.text}`,
          ),
          hint: `以下内容在资料中找不到出处，请修正或删除：\n${items.map((i) => `- ${i.text}`).join('\n')}`,
        }
      },
    }),
  }
}
