// 压缩记忆（设计 §11）：估算值达到模型窗口 × trigger 时，把 history 与运行记录中较早的部分
// 压成 5 个字段的结构化摘要；保留最近的原文（切分点落在成对边界上）与最近 anchors 组工具交换。
// 压缩是增量的：实例保存当前摘要与它覆盖到的位置，再次超限时只把新切下的消息并入已有摘要；
// 两次压缩之间摘要不变，视图前缀可以命中缓存。摘要请求按窗口分块，单次输入不超过窗口的一半。
// 压缩只改变视图（设计 I3）；连续失败 3 次后冷却 60 秒，冷却期间在尾部加一条警告。

import type { ModelMessage } from '../../contracts/common.js'
import type { Memory, MemoryState, MemoryView } from '../../contracts/component.js'
import type { ModelRef } from '../../contracts/model.js'

const DEFAULT_TRIGGER = 0.8
const DEFAULT_KEEP_RATIO = 0.2
const DEFAULT_ANCHORS = 4
const FAILURE_LIMIT = 3
const COOLDOWN_MS = 60_000
/** 单次摘要请求（已有摘要 + 新切下的记录）最多占窗口的比例。 */
const SUMMARY_INPUT_RATIO = 0.5
const TRUNCATED = '…[已截断]'

const SYSTEM = [
  '把下面的对话与工具记录压缩成结构化摘要，供后续继续工作使用。',
  '按 5 个字段输出：',
  '1. 意图：委托人要完成什么；',
  '2. 关键事实：已经确认的数据与结论（保留数字和来源）；',
  '3. 未完成的动作：还需要做什么；',
  '4. 已解决的问题：已经处理过、不需要再做的事；',
  '5. 当前阻塞：卡在哪里、缺什么。',
  '如果给了已有摘要，把新增记录合并进去，输出更新后的完整摘要。',
].join('\n')

const WARNING: ModelMessage = {
  role: 'system',
  content: '[memory] 上下文压缩暂时不可用，请精简后续输出',
}

const hasToolCall = (m: ModelMessage): boolean =>
  m.role === 'assistant' &&
  Array.isArray(m.content) &&
  m.content.some((p) => p.type === 'tool-call')

/** 切分点：保留不超过 keepTokens 的尾部，落在成对边界上，且尾部至少含 anchors 组工具交换。 */
export function cutIndex(
  messages: readonly ModelMessage[],
  estimate: (m: ModelMessage[]) => number,
  keepTokens: number,
  anchors: number,
): number {
  let i = messages.length
  while (i > 0 && estimate(messages.slice(i - 1)) <= keepTokens) i -= 1
  while (i > 0 && i < messages.length && messages[i]!.role === 'tool') i -= 1
  const exchanges = (from: number) => messages.slice(from).filter(hasToolCall).length
  while (i > 0 && exchanges(i) < anchors) {
    let previous = i - 1
    while (previous >= 0 && !hasToolCall(messages[previous]!)) previous -= 1
    if (previous < 0) break
    i = previous
  }
  return i
}

function serialize(m: ModelMessage): string {
  if (typeof m.content === 'string') return `${m.role}: ${m.content}`
  const parts = m.content.map((p) => {
    switch (p.type) {
      case 'text':
      case 'reasoning':
        return p.text
      case 'tool-call':
        return `调用 ${p.toolName}(${JSON.stringify(p.input)})`
      case 'tool-result':
        return `结果 ${p.toolName}: ${p.output}`
      default:
        return `[${p.type}]`
    }
  })
  return `${m.role}: ${parts.join('\n')}`
}

/** 摘要请求的正文：有已有摘要时带上它，只追加新切下的记录。 */
const request = (previous: string | undefined, records: readonly string[]): string =>
  previous === undefined
    ? records.join('\n\n')
    : `【已有摘要】\n${previous}\n\n【新增记录】\n${records.join('\n\n')}`

export function compactingMemory(
  opts: { trigger?: number; keepRecentTokens?: number; anchors?: number; model?: ModelRef } = {},
): Memory {
  const trigger = opts.trigger ?? DEFAULT_TRIGGER
  const anchors = opts.anchors ?? DEFAULT_ANCHORS
  return {
    id: 'compacting',
    version: '1',
    config: {
      trigger,
      keepRecentTokens: opts.keepRecentTokens ?? null,
      anchors,
      model: opts.model ?? null,
    },
    start(_run, ctx) {
      /** 当前摘要与它覆盖的消息数（history + 运行记录的前 covered 条）；运行内只向后推进。 */
      let summary: string | undefined
      let covered = 0
      let failures = 0
      let cooldownUntil = -Infinity

      const summarizeOnce = async (content: string): Promise<string | undefined> => {
        let text: string | undefined
        try {
          const response = await ctx.callModel({
            purpose: 'memory:compaction',
            system: SYSTEM,
            messages: [{ role: 'user', content }],
            ...(opts.model ? { model: opts.model } : {}),
          })
          text = response?.text
        } catch {
          text = undefined
        }
        if (!text) {
          failures += 1
          if (failures >= FAILURE_LIMIT) {
            failures = 0
            cooldownUntil = ctx.clock.now() + COOLDOWN_MS
            ctx.log('warn', '上下文压缩连续失败，冷却 60 秒')
          }
          return undefined
        }
        failures = 0
        return text
      }

      /** 把新切下的消息并入已有摘要；超出单次预算时分块依次合并，单条过长时截断。任一块失败则整体放弃。 */
      const fold = async (
        previous: string | undefined,
        cutOff: readonly ModelMessage[],
        state: MemoryState,
      ): Promise<string | undefined> => {
        const budget = Math.floor(state.contextLimit * SUMMARY_INPUT_RATIO)
        const cost = (text: string) => state.estimate([{ role: 'user', content: text }])
        let current = previous
        let records: string[] = []
        for (const m of cutOff) {
          let record = serialize(m)
          if (records.length > 0 && cost(request(current, [...records, record])) > budget) {
            current = await summarizeOnce(request(current, records))
            if (current === undefined) return undefined
            records = []
          }
          const room = Math.max(1, budget - cost(request(current, [])))
          const size = cost(record)
          if (size > room) {
            const keepChars = Math.floor((record.length * room) / size) - TRUNCATED.length * 2
            record = record.slice(0, Math.max(0, keepChars)) + TRUNCATED
          }
          records.push(record)
        }
        return records.length > 0 ? summarizeOnce(request(current, records)) : current
      }

      const viewOf = (
        history: ModelMessage[],
        transcript: ModelMessage[],
        all: readonly ModelMessage[],
      ): MemoryView => {
        if (summary === undefined) return { history, transcript }
        const summaryMessage: ModelMessage = {
          role: 'system',
          content: `【前文摘要】\n${summary}`,
        }
        const view =
          covered < history.length
            ? { history: [summaryMessage, ...history.slice(covered)], transcript }
            : {
                history: [summaryMessage],
                transcript: transcript.slice(covered - history.length),
              }
        return {
          ...view,
          compaction: {
            replaced: [0, covered],
            summary,
            anchorsKept: all.slice(covered).filter(hasToolCall).length,
          },
        }
      }

      return {
        async recall(state) {
          const { history, transcript } = state
          const all = [...history, ...transcript]
          const current = viewOf(history, transcript, all)
          if (ctx.clock.now() < cooldownUntil) {
            return { ...current, transcript: [...current.transcript, WARNING] }
          }
          const shown = [...current.history, ...current.transcript]
          if (state.fixedTokens + state.estimate(shown) < state.contextLimit * trigger) {
            return current
          }
          const keep = opts.keepRecentTokens ?? Math.floor(state.contextLimit * DEFAULT_KEEP_RATIO)
          const cut = cutIndex(all, state.estimate, keep, anchors)
          if (cut <= covered) return current
          const next = await fold(summary, all.slice(covered, cut), state)
          if (next === undefined) return current
          summary = next
          covered = cut
          return viewOf(history, transcript, all)
        },
      }
    },
  }
}
