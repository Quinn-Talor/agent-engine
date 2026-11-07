// 压缩记忆（设计 §11、会话方案 §7–§8）：各条线按可用空间（输入上限减去固定占用）计算。
// 第 1 步带入的前文超过轮开始线（或成本上限）、任一步前文 + 运行记录超过轮中触发线时，把较早的部分
// 压成 5 个字段的结构化摘要；保留不超过保留线的最近原文（切点落在成对边界上），以及本轮最近 anchors 组
// 工具交换。切点落在以前各轮里时顺延到下一轮的起点。压缩是增量的：实例保存当前摘要与它覆盖到的位置，
// 再次超限时只把新切下的消息并入已有摘要；会话的一轮从带入的摘要接着合并。两次压缩之间摘要不变，
// 视图前缀可以命中缓存。摘要请求按窗口分块，单次输入不超过窗口的一半（摘要交给别的模型时按两者中
// 较小的窗口）；摘要被截断时要求压短重试一次。记忆只给出决定，视图由引擎渲染（I3）；连续失败 3 次后
// 冷却 60 秒，冷却期间在尾部加一条提示。

import type { ModelMessage } from '../../contracts/common.js'
import type { Memory, MemoryState, MemoryView } from '../../contracts/component.js'
import type { ModelRef } from '../../contracts/model.js'
import { summaryMessage } from '../../sdk.js'

const DEFAULT_TRIGGER = 0.8
const DEFAULT_TURN_START = 0.5
const DEFAULT_KEEP_RATIO = 0.1
const DEFAULT_SUMMARY_RATIO = 0.1
const DEFAULT_ANCHORS = 1
const MIN_SUMMARY_TOKENS = 256
const FAILURE_LIMIT = 3
const COOLDOWN_MS = 60_000
/** 单次摘要请求（已有摘要 + 新切下的记录）最多占窗口的比例。 */
const SUMMARY_INPUT_RATIO = 0.5
const TRUNCATED = '…[已截断]'
const WARNING = '[memory] 上下文压缩暂时不可用，请精简后续输出'

const systemPrompt = (maxTokens: number, retry: boolean) =>
  [
    '把下面的对话与工具记录压缩成结构化摘要，供后续继续工作使用。',
    '按 5 个字段输出：',
    '1. 意图：委托人要完成什么；',
    '2. 关键事实：已经确认的数据与结论（保留数字和来源）；',
    '3. 未完成的动作：还需要做什么；',
    '4. 已解决的问题：已经处理过、不需要再做的事；',
    '5. 当前阻塞：卡在哪里、缺什么。',
    '如果给了已有摘要，把新增记录合并进去，输出更新后的完整摘要。',
    retry
      ? `上一次输出超出了长度，这次整份摘要压到 ${maxTokens} 个 token 以内，只留最要紧的内容。`
      : `整份摘要不超过 ${maxTokens} 个 token。`,
  ].join('\n')

const hasToolCall = (m: ModelMessage): boolean =>
  m.role === 'assistant' &&
  Array.isArray(m.content) &&
  m.content.some((p) => p.type === 'tool-call')

/**
 * 切分点：保留不超过 keepTokens 的尾部，落在成对边界上，且尾部至少含 anchors 组工具交换——只数
 * `anchorFrom` 之后的（本轮的运行记录），以前各轮的工具交换不让切点后退。
 */
export function cutIndex(
  messages: readonly ModelMessage[],
  estimate: (m: ModelMessage[]) => number,
  keepTokens: number,
  anchors: number,
  anchorFrom = 0,
): number {
  let i = messages.length
  while (i > 0 && estimate(messages.slice(i - 1)) <= keepTokens) i -= 1
  while (i > 0 && i < messages.length && messages[i]!.role === 'tool') i -= 1
  const exchanges = (from: number) =>
    messages.slice(Math.max(from, anchorFrom)).filter(hasToolCall).length
  while (exchanges(i) < anchors) {
    let previous = i - 1
    while (previous >= anchorFrom && !hasToolCall(messages[previous]!)) previous -= 1
    if (previous < anchorFrom) break
    i = previous
  }
  return i
}

/** 切点落在以前各轮里时顺延到下一轮的起点（被切的轮整轮并入摘要）；落在最近一轮里时不动。 */
export function snapToTurn(
  cut: number,
  historyLength: number,
  turnStarts: readonly number[],
): number {
  if (cut >= historyLength) return cut
  return turnStarts.find((t) => t >= cut && t < historyLength) ?? cut
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
      case 'tool-result': {
        const n = p.images?.length ?? 0
        const images =
          n > 0 ? `\n[工具 ${p.toolName}（调用 ${p.toolCallId}）返回的图片 ${n} 张]` : ''
        return `结果 ${p.toolName}: ${p.output}${images}`
      }
      case 'image':
        return '[图片]'
      case 'file':
        return `[文件 ${p.filename ?? '未命名'}（${p.mediaType}）]`
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
  opts: {
    /** 轮中触发线：前文 + 运行记录占可用空间的比例。 */
    trigger?: number
    /** 轮开始线：第 1 步带入的前文占可用空间的比例。 */
    turnStart?: number
    /** 保留线：压缩后保留的最近原文最多占可用空间的比例。 */
    keepRatio?: number
    /** 保留线的绝对值，给出时代替 keepRatio。 */
    keepRecentTokens?: number
    /** 摘要上限：摘要请求的 maxOutputTokens 占可用空间的比例。 */
    summaryRatio?: number
    /** 带入的前文最多这么多 token，窗口很大的模型也一样；可用空间按 min(可用空间, 它 / turnStart) 算。 */
    maxHistoryTokens?: number
    /** 本轮至少保留的最近工具交换组数（超过保留线也保留）。 */
    anchors?: number
    /** 摘要用的模型；默认用运行的模型。 */
    model?: ModelRef
  } = {},
): Memory {
  const trigger = opts.trigger ?? DEFAULT_TRIGGER
  const turnStart = opts.turnStart ?? DEFAULT_TURN_START
  const keepRatio = opts.keepRatio ?? DEFAULT_KEEP_RATIO
  const summaryRatio = opts.summaryRatio ?? DEFAULT_SUMMARY_RATIO
  const anchors = opts.anchors ?? DEFAULT_ANCHORS
  return {
    id: 'compacting',
    version: '2',
    config: {
      trigger,
      turnStart,
      keepRatio,
      keepRecentTokens: opts.keepRecentTokens ?? null,
      summaryRatio,
      maxHistoryTokens: opts.maxHistoryTokens ?? null,
      anchors,
      model: opts.model ?? null,
    },
    start(_run, ctx) {
      /** 当前摘要与它覆盖的消息数（history + 运行记录的前 covered 条）；运行内只向后推进。 */
      let summary: string | undefined
      let covered = 0
      /** 带入的摘要是 history 的第一条：覆盖超过它才算本轮压缩过。 */
      let carried = 0
      let started = false
      let failures = 0
      let cooldownUntil = -Infinity
      /** 正在进行的摘要：引擎等不及（记忆超时）进入下一步时，不再从旧的位置并行发起第二次。 */
      let folding: Promise<string | undefined> | undefined

      const fail = () => {
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          failures = 0
          cooldownUntil = ctx.clock.now() + COOLDOWN_MS
          ctx.log('warn', '上下文压缩连续失败，冷却 60 秒')
        }
      }

      /** 一次摘要请求；被截断时要求压短重试一次，仍截断或出错时记一次失败。 */
      const summarizeOnce = async (content: string, maxTokens: number) => {
        for (const retry of [false, true]) {
          let response
          try {
            response = await ctx.callModel({
              purpose: 'memory:compaction',
              system: systemPrompt(retry ? Math.floor(maxTokens / 2) : maxTokens, retry),
              messages: [{ role: 'user', content }],
              maxOutputTokens: maxTokens,
              ...(opts.model ? { model: opts.model } : {}),
            })
          } catch {
            response = undefined
          }
          if (!response?.text) break
          if (response.finishReason !== 'length') {
            failures = 0
            return response.text
          }
        }
        fail()
        return undefined
      }

      /** 把新切下的消息并入已有摘要；超出单次预算时分块依次合并，单条过长时截断。任一块失败则整体放弃。 */
      const fold = async (
        previous: string | undefined,
        cutOff: readonly ModelMessage[],
        state: MemoryState,
        available: number,
      ): Promise<string | undefined> => {
        // 摘要交给别的模型时按两个窗口中较小的一个分块，块才放得进摘要模型；摘要上限也不超过它的输出上限。
        const side = ctx.modelLimits(opts.model)
        const window = Math.min(state.contextLimit, side?.contextLimit ?? state.contextLimit)
        const budget = Math.floor(window * SUMMARY_INPUT_RATIO)
        // 输入最多占窗口的一半，输出不超过剩下的一半：请求本身放得进摘要模型的窗口。
        const maxTokens = Math.min(
          side?.maxOutputTokens ?? Infinity,
          window - budget,
          Math.max(MIN_SUMMARY_TOKENS, Math.floor(available * summaryRatio)),
        )
        const cost = (text: string) => state.estimate([{ role: 'user', content: text }])
        let current = previous
        let records: string[] = []
        for (const m of cutOff) {
          let record = serialize(m)
          if (records.length > 0 && cost(request(current, [...records, record])) > budget) {
            current = await summarizeOnce(request(current, records), maxTokens)
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
        return records.length > 0 ? summarizeOnce(request(current, records), maxTokens) : current
      }

      const declared = (): MemoryView =>
        summary !== undefined && covered > carried ? { compaction: { upTo: covered, summary } } : {}

      return {
        async recall(state) {
          if (!started) {
            started = true
            if (state.summary !== undefined && state.history.length > 0) {
              summary = state.summary
              covered = carried = 1
            }
          }
          if (ctx.clock.now() < cooldownUntil) return { ...declared(), notice: WARNING }
          if (folding) return declared()
          const { history, transcript } = state
          const all = [...history, ...transcript]
          // 成本上限缩小可用空间：带入的前文不超过它，各条线随之缩小，压缩之后也留在它以内。
          const room = Math.max(1, state.inputLimit - state.fixedTokens)
          const available =
            opts.maxHistoryTokens !== undefined
              ? Math.min(room, opts.maxHistoryTokens / turnStart)
              : room
          const head = summary !== undefined && covered > 0 ? [summaryMessage(summary)] : []
          const shownHistory = [...head, ...history.slice(covered)]
          const shown = [...head, ...all.slice(covered)]
          const historyTokens = state.estimate(shownHistory)
          const atTurnStart = state.step === 1 && historyTokens > available * turnStart
          if (!atTurnStart && state.estimate(shown) <= available * trigger) return declared()
          const keep = opts.keepRecentTokens ?? Math.floor(available * keepRatio)
          const cut = snapToTurn(
            cutIndex(all, state.estimate, keep, anchors, history.length),
            history.length,
            state.turnStarts,
          )
          if (cut <= covered) return declared()
          folding = fold(summary, all.slice(covered, cut), state, available)
          let next: string | undefined
          try {
            next = await folding
          } finally {
            folding = undefined
          }
          if (next === undefined) return declared()
          summary = next
          covered = cut
          return declared()
        },
      }
    },
  }
}
