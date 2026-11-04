// 固定的视图布局（设计 §3.13）：按稳定程度排列，不开放。
// [须知][Agent 指令][能力说明][history][任务输入][运行记录][易变信息与不可用提示]

import type { ModelMessage, Segment } from '../../contracts/common.js'
import type { ModelInput, ModelToolSpec } from '../../contracts/model.js'

export interface ViewParts {
  notice: Segment[]
  instructions: Segment[]
  capabilities: Segment[]
  history: ModelMessage[]
  input: Segment[]
  transcript: ModelMessage[]
  tail: Segment[]
  tools: ModelToolSpec[]
  toolChoice?: 'auto' | 'none'
  maxOutputTokens?: number
  temperature?: number
  topP?: number
}

/** 纯文本的 system 段转为 system 消息；含图片或文件的段转为 user 消息，内容不丢。 */
export function segmentToMessage(segment: Segment): ModelMessage {
  if (segment.role === 'system' && segment.parts.every((p) => p.type === 'text')) {
    return {
      role: 'system',
      content: segment.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
    }
  }
  return { role: 'user', content: segment.parts }
}

/** 压缩声明：前文 + 运行记录连起来的前 `upTo` 条换成一条摘要（设计 §9.3）。 */
export interface Compaction {
  upTo: number
  summary: string
}

/** 摘要在视图里的样子：一条带固定标题的 system 消息。 */
export function summaryMessage(summary: string): ModelMessage {
  return { role: 'system', content: `【前文摘要】\n${summary}` }
}

/**
 * 套上压缩声明之后的前文与运行记录。组装、会话的下一轮窗口与预览都用它，模型看到的前文只可能是
 * 原样的前文，或者原样的前文套上一次已声明的压缩。覆盖到运行记录时前文只剩摘要；任务输入不在
 * 编号里，布局仍把它放在摘要与剩下的运行记录之间。
 */
export function renderView(
  history: readonly ModelMessage[],
  transcript: readonly ModelMessage[],
  compaction?: Compaction,
): { history: ModelMessage[]; transcript: ModelMessage[] } {
  if (!compaction) return { history: [...history], transcript: [...transcript] }
  const summary = summaryMessage(compaction.summary)
  return compaction.upTo <= history.length
    ? { history: [summary, ...history.slice(compaction.upTo)], transcript: [...transcript] }
    : { history: [summary], transcript: transcript.slice(compaction.upTo - history.length) }
}

export function layout(parts: ViewParts): ModelInput {
  const blockA = [...parts.notice, ...parts.instructions, ...parts.capabilities].map(
    segmentToMessage,
  )
  const blockB = [...parts.history, ...parts.input.map(segmentToMessage)]
  const blockC = parts.transcript
  const blockD = parts.tail.map(segmentToMessage)
  const messages = [...blockA, ...blockB, ...blockC, ...blockD]

  // 缓存断点：稳定前缀末尾（能力说明之后）和运行记录末尾，两处重合时只打一个。
  const endA = blockA.length - 1
  const endB = blockA.length + blockB.length - 1
  const endC = blockA.length + blockB.length + blockC.length - 1
  const breakpoints = new Set<number>()
  if (blockA.length > 0) breakpoints.add(endA)
  if (blockC.length > 0) breakpoints.add(endC)
  else if (endB >= 0) breakpoints.add(endB)

  const input: ModelInput = {
    messages,
    tools: parts.tools,
    cacheBreakpoints: [...breakpoints].sort((a, b) => a - b),
  }
  if (parts.toolChoice !== undefined) input.toolChoice = parts.toolChoice
  if (parts.maxOutputTokens !== undefined) input.maxOutputTokens = parts.maxOutputTokens
  if (parts.temperature !== undefined) input.temperature = parts.temperature
  if (parts.topP !== undefined) input.topP = parts.topP
  return input
}
