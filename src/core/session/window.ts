// 会话的窗口（会话方案 §6、§9、§11）：下一轮带入的前文由上一轮的窗口和日志确定性地推导出来（carry），
// 不调用模型；副作用台账沿序号递推。纯函数：日志与 blob 正文由调用方读好传进来。

import type { ModelMessage, Segment } from '../../contracts/common.js'
import type { BlobRef, LedgerEntry, RunEvent } from '../../contracts/events.js'
import { canonicalJson } from '../definition/hash.js'
import { foldState, sideEffects, transcriptMessages } from '../log/projections.js'
import { renderView, segmentToMessage, type Compaction } from '../run/layout.js'
import type { TranscriptEntry } from '../run/state.js'

/** carry 的版本：推导规则改变时加一，I17 只在同一版本下比较。 */
export const CARRY_VERSION = 1
/** 台账最多保留的条数。 */
export const LEDGER_LIMIT = 50
const MAX_INPUT_CHARS = 200
const MISSING_RESULT =
  '<tool_output>\nERROR [TOOL_MISSING_RESULT]: 调用结果没有记录；如有副作用，可能已经执行\n</tool_output>'

type Of<T extends RunEvent['t']> = Extract<RunEvent, { t: T }>

/** 一轮带入的前文：消息、每一轮的起点、第一条是摘要时的摘要正文。 */
export interface SessionWindow {
  messages: ModelMessage[]
  turnStarts: number[]
  summary?: string
}

export interface CarryInput {
  /** 接续点在会话里的序号。 */
  turn: number
  /** 接续点带入的窗口。 */
  window: SessionWindow
  /** 接续点的任务输入。 */
  input: readonly Segment[]
  /** 接续点的日志，读到某一条为止。 */
  events: readonly RunEvent[]
  /** blobsForCarry 列出的 blob 正文。 */
  blobs: ReadonlyMap<BlobRef, string>
}

const system = (text: string): ModelMessage => ({ role: 'system', content: text })

/** 只带对话本身：模型回复、工具调用与结果、委托人引导，以及说明为什么有第二版答复的交付退回提示。 */
const carried = (entry: TranscriptEntry): boolean =>
  entry.origin === 'model' ||
  entry.origin === 'tool' ||
  entry.origin === 'steer' ||
  (entry.origin === 'hint' && entry.source === 'delivery')

/** carry 需要的 blob：工具结果的展示文本与图片、须知的动态内容（占着记忆的坐标）、压缩摘要。 */
export function blobsForCarry(events: readonly RunEvent[]): BlobRef[] {
  const refs = new Set<BlobRef>()
  const state = foldState(events)
  for (const entry of state.transcript) {
    if (entry.origin === 'tool') {
      for (const r of entry.results) {
        refs.add(r.shown)
        for (const i of r.images ?? []) refs.add(i.blob)
      }
    } else if (entry.origin === 'hook') refs.add(entry.content)
  }
  // 一批调用没有全部结束时，已有的结果还不在运行记录里。
  for (const r of Object.values(state.results)) {
    refs.add(r.shown)
    for (const i of r.images ?? []) refs.add(i.blob)
  }
  const compaction = lastCompactionEvent(events)
  if (compaction) refs.add(compaction.summary)
  return [...refs]
}

function lastCompactionEvent(events: readonly RunEvent[]) {
  const built = events.findLast((e): e is Of<'context_built'> => e.t === 'context_built')
  return built?.compaction
}

/**
 * 工具调用缺结果时补齐（只在存储失败的路径上出现）：已经记下的结果照用，没有的补 TOOL_MISSING_RESULT，
 * 推导出的窗口总是成对的。
 */
function closePairs(
  messages: readonly ModelMessage[],
  recorded: ReadonlyMap<string, { output: string; isError: boolean }>,
): ModelMessage[] {
  const out: ModelMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    out.push(m)
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const calls = m.content.flatMap((p) => (p.type === 'tool-call' ? [p] : []))
    if (calls.length === 0) continue
    const next = messages[i + 1]
    const present = new Set(next?.role === 'tool' ? next.content.map((r) => r.toolCallId) : [])
    const missing = calls
      .filter((c) => !present.has(c.toolCallId))
      .map((c) => ({
        type: 'tool-result' as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        output: recorded.get(c.toolCallId)?.output ?? MISSING_RESULT,
        isError: recorded.get(c.toolCallId)?.isError ?? true,
      }))
    if (missing.length === 0) continue
    if (next?.role === 'tool') {
      out.push({ role: 'tool', content: [...next.content, ...missing] })
      i += 1
    } else out.push({ role: 'tool', content: missing })
  }
  return out
}

/** 一轮在窗口里的结局：兜底交付的文字；没有正常结束时一行说明。 */
function outcomeOf(turn: number, events: readonly RunEvent[]): ModelMessage[] {
  const out: ModelMessage[] = []
  const fallback = events.findLast(
    (e): e is Of<'fallback_generated'> => e.t === 'fallback_generated',
  )
  if (fallback) out.push({ role: 'assistant', content: fallback.text })
  const ended = events.findLast((e): e is Of<'run_ended'> => e.t === 'run_ended')
  if (!ended) return [...out, system(`【第 ${turn} 轮结局】没有记录`)]
  const r = ended.result
  if (r.status === 'completed' || r.status === 'awaiting_input') return out
  const code = r.code !== undefined ? `（${r.code}）` : ''
  const reason = r.error ? `：${r.error.message}` : ''
  return [...out, system(`【第 ${turn} 轮结局】${r.status}${code}${reason}`)]
}

/**
 * W_{N+1} = carry(W_N, 第 N 轮日志)（会话方案 §6）：套上最后一次已提交的压缩（坐标与当时的记忆相同：
 * 前文 + 运行记录，任务输入不在其中）→ 前文、任务输入、运行记录按视图的顺序拼起来 → 只带对话本身
 * → 补齐成对 → 结局 → 最后一次组装之后才到的委托人引导。
 */
export function carry(prev: CarryInput): SessionWindow {
  const state = foldState(prev.events)
  const history = prev.window.messages
  const tagged: Array<{ message: ModelMessage; keep: boolean }> = []
  for (const entry of state.transcript) {
    const keep = carried(entry)
    for (const message of transcriptMessages([entry], prev.blobs)) tagged.push({ message, keep })
  }
  const declared = lastCompactionEvent(prev.events)
  let compaction: Compaction | undefined
  if (declared) {
    const summary = prev.blobs.get(declared.summary)
    if (summary === undefined) throw new Error(`carry: 压缩摘要 ${declared.summary} 没有读出`)
    compaction = { upTo: declared.upTo, summary }
  }
  const view = renderView(
    history,
    tagged.map((t) => t.message),
    compaction,
  )
  const transcript = tagged
    .slice(tagged.length - view.transcript.length)
    .flatMap((t) => (t.keep ? [t.message] : []))
  const recorded = new Map(
    Object.entries(state.results).map(([callId, r]) => [
      callId,
      { output: prev.blobs.get(r.shown) ?? '', isError: r.isError },
    ]),
  )
  const messages = closePairs(
    [...view.history, ...prev.input.map(segmentToMessage), ...transcript],
    recorded,
  )
  messages.push(...outcomeOf(prev.turn, prev.events))
  if (state.pendingSteers.length > 0) {
    messages.push({ role: 'user', content: state.pendingSteers.join('\n\n') })
  }

  const kept = (start: number): number | undefined => {
    if (!compaction) return start
    if (compaction.upTo > history.length || start < compaction.upTo) return undefined
    return start - compaction.upTo + 1
  }
  const turnStarts = [
    ...prev.window.turnStarts.flatMap((s) => {
      const k = kept(s)
      return k === undefined ? [] : [k]
    }),
    view.history.length,
  ]
  const summary = compaction ? compaction.summary : prev.window.summary
  return { messages, turnStarts, ...(summary !== undefined ? { summary } : {}) }
}

const clip = (input: unknown): string => {
  const json = canonicalJson(input ?? null)
  return json.length > MAX_INPUT_CHARS ? `${json.slice(0, MAX_INPUT_CHARS)}…` : json
}

/** 一次运行自己的副作用：发起了子运行的委托调用不算（由子运行的副作用代替）；没有结果的副作用调用记为可能已执行。 */
function ownEffects(turn: number, events: readonly RunEvent[]): LedgerEntry[] {
  const delegated = new Set(
    events.flatMap((e) =>
      e.t === 'tool_finished' && (e.childRunId !== undefined || (e.childRunIds?.length ?? 0) > 0)
        ? [e.callId]
        : [],
    ),
  )
  const entries: LedgerEntry[] = sideEffects(events)
    .filter((s) => !delegated.has(s.callId))
    .map((s) => ({ turn, tool: s.toolName, input: clip(s.input), status: s.status }))
  const state = foldState(events)
  const finished = new Set(events.flatMap((e) => (e.t === 'tool_finished' ? [e.callId] : [])))
  for (const e of events) {
    if (e.t !== 'model_responded') continue
    for (const c of e.response.toolCalls) {
      const effect = state.tools[c.name]?.effect ?? 'none'
      if (effect === 'none' || finished.has(c.id)) continue
      entries.push({ turn, tool: c.name, input: clip(c.input), status: 'possibly_executed' })
    }
  }
  return entries
}

/** 一轮的副作用：它自己的，加上它发起的子运行（及更深的子运行）的。 */
export function ledgerEntries(
  turn: number,
  events: readonly RunEvent[],
  children: ReadonlyArray<readonly RunEvent[]>,
): LedgerEntry[] {
  return [ownEffects(turn, events), ...children.map((c) => ownEffects(turn, c))].flat()
}

/** 台账追加一轮的副作用；超过上限时可能已执行的全部保留，已执行的保留最近的，省略的计数。 */
export function appendLedger(
  prev: { ledger: readonly LedgerEntry[]; omitted: number },
  entries: readonly LedgerEntry[],
): { ledger: LedgerEntry[]; omitted: number } {
  const all = [...prev.ledger, ...entries]
  if (all.length <= LEDGER_LIMIT) return { ledger: all, omitted: prev.omitted }
  const possibly = all.filter((e) => e.status === 'possibly_executed').length
  let drop = all.length - Math.max(LEDGER_LIMIT, possibly)
  const ledger = all.filter((e) => {
    if (drop > 0 && e.status === 'executed') {
      drop -= 1
      return false
    }
    return true
  })
  return { ledger, omitted: prev.omitted + (all.length - ledger.length) }
}

/** 台账放在尾部的样子；台账为空时没有。 */
export function ledgerSegment(
  ledger: readonly LedgerEntry[],
  omitted: number,
): Segment | undefined {
  if (ledger.length === 0 && omitted === 0) return undefined
  const lines = [
    '【本会话已执行的副作用】下面的动作在之前的轮次里已经执行过；除非委托人明确要求，不要重复执行：',
    ...ledger.map(
      (e) =>
        `- 第 ${e.turn} 轮 ${e.tool} ${e.input}${e.status === 'possibly_executed' ? '（可能已执行，结果未知）' : ''}`,
    ),
    ...(omitted > 0 ? [`另有 ${omitted} 条更早的已执行副作用没有列出，原文保留在会话日志。`] : []),
  ]
  return { role: 'system', parts: [{ type: 'text', text: lines.join('\n') }] }
}
